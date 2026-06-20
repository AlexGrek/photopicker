//! Disk-backed photo browsing for the gallery.
//!
//! The gallery is designed for *slow* storage (memory cards, network shares) and
//! *huge* photos (100 MP is normal for modern cameras). Reading a full file just
//! to show a grid tile would be unbearable, so the strategy is:
//!
//! 1. [`list_images`] only enumerates directory entries — no file contents are read.
//! 2. [`render_thumbnail`] reads at most a bounded *prefix* of each file (a couple
//!    of MiB) and, in the overwhelmingly common case of camera JPEGs, pulls the
//!    DCF-mandated embedded EXIF thumbnail straight out of that prefix. The full
//!    file is only ever read when a JPEG has no usable embedded thumbnail (e.g. a
//!    stripped web image) or when a large preview is explicitly requested.
//!
//! Thumbnails are decoded, rotated upright per their EXIF orientation, downscaled
//! and re-encoded as small JPEGs. The bytes are served verbatim over the `thumb://`
//! URI scheme (see `lib.rs`) so the webview loads them like any `<img src>` — no
//! base64, native browser caching, and the image's own dimensions drive layout.

use std::fs;
use std::io::{Cursor, Read};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use jpeg_encoder::{ColorType, Encoder};
use serde::Serialize;
use zune_jpeg::zune_core::bytestream::ZCursor;
use zune_jpeg::zune_core::colorspace::ColorSpace;
use zune_jpeg::zune_core::options::DecoderOptions;
use zune_jpeg::JpegDecoder;

/// How many bytes from the front of a file we are willing to read before we are
/// forced to fall back to reading the whole thing. Comfortably covers the APPn
/// segments (EXIF + embedded thumbnail) of any normal camera JPEG.
const PREFIX_CAP: u64 = 2 * 1024 * 1024;

/// Below this requested edge length the cheap embedded EXIF thumbnail is "good
/// enough"; above it (e.g. the lightbox's full-quality view) we always decode.
const EXIF_THUMB_MAX_EDGE: u32 = 512;

/// A guard against pathological / corrupt SOF dimensions blowing up memory.
const MAX_DECODE_EDGE: usize = 1 << 17; // 131072 px

/// One subdirectory in a browsed directory. Cheap — pure directory metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
}

/// One image file in a browsed directory. Cheap to produce — pure directory metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
    /// Absolute path, used to build the `thumb://` URL.
    pub path: String,
    pub name: String,
    /// File size in bytes.
    pub size: u64,
    /// Last-modified time in milliseconds since the Unix epoch, if available.
    /// Doubles as a cache-busting version for the thumbnail URL.
    pub modified: Option<u64>,
    /// Created time in milliseconds since the Unix epoch, if available.
    pub created: Option<u64>,
    /// Whether this file is a RAW photo (currently preview-only via embedded JPEG).
    pub raw: bool,
}

#[derive(Clone)]
struct ShotDateCandidate {
    path: String,
    stem: String,
    raw: bool,
    jpeg: bool,
}

fn image_entry_from_path(path: &Path, name: &std::ffi::OsStr) -> Option<ImageEntry> {
    let ext = file_ext(path);
    let is_raw = is_raw_ext(ext);
    if !is_jpeg_ext(ext) && !is_raw {
        return None;
    }
    let meta = path.metadata().ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    let created = meta
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Some(ImageEntry {
        path: path.to_string_lossy().into_owned(),
        name: name.to_string_lossy().into_owned(),
        size: meta.len(),
        modified,
        created,
        raw: is_raw,
    })
}

/// Lists subdirectories directly inside `dir`, sorted case-insensitively by name.
pub fn list_directories(dir: &str) -> Result<Vec<DirectoryEntry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("Cannot read {dir}: {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        if is_unix_hidden_name(&entry.file_name()) {
            continue;
        }
        let meta = entry.metadata().ok();
        if meta.as_ref().map(|m| !m.is_dir()).unwrap_or(true) {
            continue;
        }
        out.push(DirectoryEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

const PREVIEW_LIMIT: usize = 4;

/// Collects up to four image previews from `dir`, recursing into subdirectories
/// while `max_depth` allows (0 = direct children only).
pub fn directory_preview(dir: &str, max_depth: u32) -> Result<Vec<ImageEntry>, String> {
    let mut out = Vec::new();
    collect_preview_entries(Path::new(dir), max_depth, &mut out);
    Ok(out)
}

fn collect_preview_entries(dir: &Path, max_depth: u32, out: &mut Vec<ImageEntry>) {
    if out.len() >= PREVIEW_LIMIT {
        return;
    }
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    let mut files = Vec::new();
    let mut subdirs = Vec::new();
    for entry in read.flatten() {
        if is_unix_hidden_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        let meta = entry.metadata().ok();
        if meta.as_ref().map(|m| m.is_dir()).unwrap_or(false) {
            subdirs.push(path);
        } else if let Some(image) = image_entry_from_path(&path, &entry.file_name()) {
            files.push(image);
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    subdirs.sort_by(|a, b| {
        a.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
            .cmp(
                &b.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase(),
            )
    });

    for image in files {
        out.push(image);
        if out.len() >= PREVIEW_LIMIT {
            return;
        }
    }

    if max_depth == 0 {
        return;
    }
    for sub in subdirs {
        collect_preview_entries(&sub, max_depth - 1, out);
        if out.len() >= PREVIEW_LIMIT {
            return;
        }
    }
}

/// Lists supported image files directly inside `dir`, sorted case-insensitively by name.
pub fn list_images(dir: &str) -> Result<Vec<ImageEntry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("Cannot read {dir}: {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        if is_unix_hidden_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if let Some(image) = image_entry_from_path(&path, &entry.file_name()) {
            out.push(image);
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn file_ext(path: &Path) -> Option<&str> {
    path.extension().and_then(|e| e.to_str())
}

/// Unix hidden files (names starting with `.`) — e.g. `.DS_Store`, AppleDouble `._foo.jpg`.
fn is_unix_hidden_name(name: &std::ffi::OsStr) -> bool {
    name.as_encoded_bytes().first() == Some(&b'.')
}

fn is_jpeg_ext(ext: Option<&str>) -> bool {
    matches!(ext.map(str::to_ascii_lowercase).as_deref(), Some("jpg" | "jpeg" | "jpe" | "jfif"))
}

fn is_raw_ext(ext: Option<&str>) -> bool {
    matches!(ext.map(str::to_ascii_lowercase).as_deref(), Some("arw" | "raf"))
}

fn is_raw_path(path: &Path) -> bool {
    is_raw_ext(file_ext(path))
}

pub fn list_shot_dates(dir: &str, raw_coupling: bool) -> Result<HashMap<String, u64>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("Cannot read {dir}: {e}"))?;
    let mut candidates = Vec::<ShotDateCandidate>::new();
    for entry in read.flatten() {
        if is_unix_hidden_name(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        let ext = file_ext(&path);
        let raw = is_raw_ext(ext);
        let jpeg = is_jpeg_ext(ext);
        if !raw && !jpeg {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .unwrap_or_default();
        candidates.push(ShotDateCandidate {
            path: path.to_string_lossy().into_owned(),
            stem,
            raw,
            jpeg,
        });
    }

    let skip_raw_stems = if raw_coupling {
        let mut raw = HashSet::<String>::new();
        let mut jpeg = HashSet::<String>::new();
        for c in &candidates {
            if c.raw {
                raw.insert(c.stem.clone());
            }
            if c.jpeg {
                jpeg.insert(c.stem.clone());
            }
        }
        raw.intersection(&jpeg).cloned().collect::<HashSet<String>>()
    } else {
        HashSet::new()
    };

    let mut out = HashMap::<String, u64>::new();
    for c in candidates {
        if raw_coupling && c.raw && skip_raw_stems.contains(&c.stem) {
            continue;
        }
        if let Some(ts) = read_shot_date_key(&c.path, c.raw) {
            out.insert(c.path, ts);
        }
    }
    Ok(out)
}

/// Renders an upright thumbnail JPEG for `path`, fitting its longest edge to
/// `max_edge` pixels. Returns the encoded JPEG bytes ready to serve to the webview.
pub fn render_thumbnail(path: &str, max_edge: u32) -> Result<Vec<u8>, String> {
    let path_obj = PathBuf::from(path);
    let total_len = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let prefix = read_prefix(path, PREFIX_CAP.min(total_len.max(1)))?;
    let raw_file = is_raw_path(&path_obj);

    // Orientation + the embedded thumbnail both live at the front of the file.
    let meta = read_exif(&prefix);
    let want_exif = max_edge <= EXIF_THUMB_MAX_EDGE;

    let from_exif = if want_exif {
        meta.thumbnail.as_deref().and_then(|bytes| decode_rgb(bytes).ok())
    } else {
        None
    };

    let (mut rgb, mut w, mut h) = match from_exif {
        Some(decoded) => decoded,
        None => {
            if raw_file {
                // RAW files are preview-only for now. We never decode full RAW data here.
                return Err("RAW embedded preview not available".into());
            }
            // No usable embedded thumbnail (or a large preview was requested): pay
            // for a full decode, reading the whole file only now.
            let full = read_whole_if_needed(path, &prefix, total_len)?;
            decode_rgb(&full)?
        }
    };

    // Bake orientation into the pixels so the frontend never has to rotate.
    (rgb, w, h) = apply_orientation(rgb, w, h, meta.orientation);
    let (thumb, tw, th) = downscale(rgb, w, h, max_edge);
    encode_jpeg(&thumb, tw, th, 82)
}

fn read_prefix(path: &str, len: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(len as usize);
    file.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

fn read_whole_if_needed(path: &str, prefix: &[u8], total_len: u64) -> Result<Vec<u8>, String> {
    if (prefix.len() as u64) >= total_len {
        Ok(prefix.to_vec())
    } else {
        fs::read(path).map_err(|e| e.to_string())
    }
}

/// Geometry-only metadata extracted from a file's EXIF block.
struct ExifMeta {
    orientation: u16,
    /// Raw bytes of the embedded thumbnail JPEG, if present.
    thumbnail: Option<Vec<u8>>,
    /// EXIF DateTimeOriginal-like sortable timestamp key (YYYYMMDDhhmmss).
    shot_date_key: Option<u64>,
}

fn read_exif(bytes: &[u8]) -> ExifMeta {
    let mut cursor = Cursor::new(bytes);
    let exif = match exif::Reader::new().read_from_container(&mut cursor) {
        Ok(e) => e,
        Err(_) => {
            return ExifMeta {
                orientation: 1,
                thumbnail: None,
                shot_date_key: None,
            }
        }
    };

    let orientation = exif
        .get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .filter(|&o| (1..=8).contains(&o))
        .unwrap_or(1) as u16;

    // The thumbnail IFD records the embedded JPEG as an offset/length into the TIFF buffer.
    let thumbnail = (|| {
        let off = exif
            .get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL)?
            .value
            .get_uint(0)? as usize;
        let len = exif
            .get_field(exif::Tag::JPEGInterchangeFormatLength, exif::In::THUMBNAIL)?
            .value
            .get_uint(0)? as usize;
        let buf = exif.buf();
        let slice = buf.get(off..off.checked_add(len)?)?;
        // Only trust it if it actually starts with a JPEG SOI marker.
        if slice.len() >= 2 && slice[0] == 0xFF && slice[1] == 0xD8 {
            Some(slice.to_vec())
        } else {
            None
        }
    })();

    let shot_date_key = read_exif_shot_date_key(&exif);

    ExifMeta {
        orientation,
        thumbnail,
        shot_date_key,
    }
}

fn read_exif_shot_date_key(exif: &exif::Exif) -> Option<u64> {
    let tags = [exif::Tag::DateTimeOriginal, exif::Tag::DateTimeDigitized, exif::Tag::DateTime];
    for tag in tags {
        let field = exif.get_field(tag, exif::In::PRIMARY)?;
        let exif::Value::Ascii(values) = &field.value else {
            continue;
        };
        let raw = values.first()?;
        let text = std::str::from_utf8(raw).ok()?.trim_matches(char::from(0)).trim();
        if let Some(key) = parse_exif_datetime_key(text) {
            return Some(key);
        }
    }
    None
}

fn parse_exif_datetime_key(text: &str) -> Option<u64> {
    // Expected EXIF form: "YYYY:MM:DD HH:MM:SS". Keep only digits to build
    // a sortable key: YYYYMMDDhhmmss.
    let digits: String = text.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 14 {
        return None;
    }
    digits[..14].parse::<u64>().ok()
}

fn read_shot_date_key(path: &str, raw_file: bool) -> Option<u64> {
    let total_len = fs::metadata(path).ok()?.len();
    let prefix = read_prefix(path, PREFIX_CAP.min(total_len.max(1))).ok()?;
    let exif = read_exif(&prefix);
    if exif.shot_date_key.is_some() {
        return exif.shot_date_key;
    }
    // RAW metadata can sit deeper in the file than JPEG metadata.
    if raw_file || (prefix.len() as u64) < total_len {
        let full = read_whole_if_needed(path, &prefix, total_len).ok()?;
        return read_exif(&full).shot_date_key;
    }
    None
}

/// Fully decodes a JPEG to packed RGB (3 bytes/px).
fn decode_rgb(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32), String> {
    let mut decoder = JpegDecoder::new_with_options(
        ZCursor::new(bytes),
        DecoderOptions::default()
            .jpeg_set_out_colorspace(ColorSpace::RGB)
            .set_max_width(MAX_DECODE_EDGE)
            .set_max_height(MAX_DECODE_EDGE)
            .set_strict_mode(false),
    );
    let pixels = decoder.decode().map_err(|e| e.to_string())?;
    let info = decoder.info().ok_or("missing JPEG header info")?;
    let (w, h) = (u32::from(info.width), u32::from(info.height));
    if pixels.len() < (w as usize) * (h as usize) * 3 {
        return Err("unexpected pixel buffer (non-RGB JPEG?)".into());
    }
    Ok((pixels, w, h))
}

/// Rotates/flips packed RGB pixels so they sit upright, returning the new buffer
/// and its dimensions. Orientation 1 (and anything unexpected) is a no-op.
fn apply_orientation(src: Vec<u8>, w: u32, h: u32, orientation: u16) -> (Vec<u8>, u32, u32) {
    if orientation <= 1 || orientation > 8 {
        return (src, w, h);
    }
    let (w, h) = (w as usize, h as usize);
    let (dw, dh) = match orientation {
        5 | 6 | 7 | 8 => (h, w),
        _ => (w, h),
    };
    let mut dst = vec![0u8; dw * dh * 3];
    for dy in 0..dh {
        for dx in 0..dw {
            let (sx, sy) = match orientation {
                2 => (w - 1 - dx, dy),
                3 => (w - 1 - dx, h - 1 - dy),
                4 => (dx, h - 1 - dy),
                5 => (dy, dx),
                6 => (dy, h - 1 - dx),
                7 => (w - 1 - dy, h - 1 - dx),
                8 => (w - 1 - dy, dx),
                _ => (dx, dy),
            };
            let si = (sy * w + sx) * 3;
            let di = (dy * dw + dx) * 3;
            dst[di..di + 3].copy_from_slice(&src[si..si + 3]);
        }
    }
    (dst, dw as u32, dh as u32)
}

/// Area-average (box) downscale so the longest edge is at most `max_edge`.
/// Returns the input untouched when it already fits.
fn downscale(src: Vec<u8>, w: u32, h: u32, max_edge: u32) -> (Vec<u8>, u32, u32) {
    let longest = w.max(h);
    if longest <= max_edge || longest == 0 {
        return (src, w, h);
    }
    let scale = max_edge as f64 / longest as f64;
    let ow = ((w as f64 * scale).round() as u32).max(1);
    let oh = ((h as f64 * scale).round() as u32).max(1);
    let (w, h, ow_u, oh_u) = (w as usize, h as usize, ow as usize, oh as usize);
    let mut dst = vec![0u8; ow_u * oh_u * 3];
    for oy in 0..oh_u {
        let sy0 = oy * h / oh_u;
        let sy1 = (((oy + 1) * h / oh_u).max(sy0 + 1)).min(h);
        for ox in 0..ow_u {
            let sx0 = ox * w / ow_u;
            let sx1 = (((ox + 1) * w / ow_u).max(sx0 + 1)).min(w);
            let (mut r, mut g, mut b, mut count) = (0u32, 0u32, 0u32, 0u32);
            for sy in sy0..sy1 {
                let row = sy * w;
                for sx in sx0..sx1 {
                    let si = (row + sx) * 3;
                    r += src[si] as u32;
                    g += src[si + 1] as u32;
                    b += src[si + 2] as u32;
                    count += 1;
                }
            }
            let di = (oy * ow_u + ox) * 3;
            dst[di] = (r / count) as u8;
            dst[di + 1] = (g / count) as u8;
            dst[di + 2] = (b / count) as u8;
        }
    }
    (dst, ow, oh)
}

fn encode_jpeg(rgb: &[u8], w: u32, h: u32, quality: u8) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, quality);
    encoder
        .encode(rgb, w as u16, h as u16, ColorType::Rgb)
        .map_err(|e| e.to_string())?;
    Ok(out)
}

/// One EXIF tag for the info modal.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifField {
    pub label: String,
    pub value: String,
}

/// Short strings for the always-on lightbox overlay.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifOverlay {
    pub lens: Option<String>,
    pub focal_length: Option<String>,
    pub aperture: Option<String>,
    pub shutter: Option<String>,
    pub iso: Option<String>,
    pub focus_distance: Option<String>,
}

/// Full EXIF read for a single file (prefix read, whole file only when needed).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExifInfo {
    pub fields: Vec<ExifField>,
    pub overlay: ExifOverlay,
}

fn parse_exif_container(bytes: &[u8]) -> Option<exif::Exif> {
    let mut cursor = Cursor::new(bytes);
    exif::Reader::new().read_from_container(&mut cursor).ok()
}

fn load_exif_container(path: &str) -> Result<Option<exif::Exif>, String> {
    let path_obj = PathBuf::from(path);
    let raw_file = is_raw_path(&path_obj);
    let total_len = fs::metadata(path).map_err(|e| e.to_string())?.len();
    let prefix = read_prefix(path, PREFIX_CAP.min(total_len.max(1)))?;
    if let Some(exif) = parse_exif_container(&prefix) {
        return Ok(Some(exif));
    }
    if raw_file || (prefix.len() as u64) < total_len {
        let full = read_whole_if_needed(path, &prefix, total_len)?;
        return Ok(parse_exif_container(&full));
    }
    Ok(None)
}

fn field_display(field: &exif::Field) -> String {
    format!("{}", field.display_value().with_unit(field))
}

fn format_exposure(exif: &exif::Exif) -> Option<String> {
    let field = exif.get_field(exif::Tag::ExposureTime, exif::In::PRIMARY)?;
    if let exif::Value::Rational(ref v) = field.value {
        if let Some(r) = v.first() {
            if r.denom == 0 {
                return None;
            }
            if r.num >= r.denom {
                let secs = r.num as f64 / r.denom as f64;
                return Some(format!("{secs:.1}s"));
            }
            if r.denom.is_multiple_of(r.num) {
                return Some(format!("1/{}s", r.denom / r.num));
            }
            return Some(format!("{}/{}s", r.num, r.denom));
        }
    }
    let s = field_display(field);
    if s.is_empty() { None } else { Some(s) }
}

fn format_iso(exif: &exif::Exif) -> Option<String> {
    for tag in [exif::Tag::PhotographicSensitivity, exif::Tag::ISOSpeed] {
        let Some(field) = exif.get_field(tag, exif::In::PRIMARY) else {
            continue;
        };
        let s = field_display(&field);
        if s.is_empty() {
            continue;
        }
        return Some(if s.to_ascii_uppercase().starts_with("ISO") {
            s
        } else {
            format!("ISO {s}")
        });
    }
    None
}

fn find_field_by_tag<'a>(exif: &'a exif::Exif, tag: exif::Tag) -> Option<&'a exif::Field> {
    exif.get_field(tag, exif::In::PRIMARY)
        .or_else(|| exif.fields().find(|f| f.tag == tag))
}

fn format_f_stop(f: f64) -> String {
    if !f.is_finite() || f <= 0.0 {
        return String::new();
    }
    let rounded = (f * 10.0).round() / 10.0;
    if (rounded - rounded.round()).abs() < 0.05 {
        format!("f/{}", rounded.round() as i64)
    } else {
        format!("f/{rounded:.1}")
    }
}

fn normalize_f_stop_display(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(rest) = trimmed.strip_prefix("f/").or_else(|| trimmed.strip_prefix("F/")) {
        return format!("f/{rest}");
    }
    if trimmed.starts_with('f') || trimmed.starts_with('F') {
        return trimmed.to_string();
    }
    format!("f/{trimmed}")
}

fn format_aperture(exif: &exif::Exif) -> Option<String> {
    if let Some(field) = find_field_by_tag(exif, exif::Tag::FNumber) {
        if let exif::Value::Rational(ref v) = field.value {
            if let Some(r) = v.first() {
                if r.denom != 0 {
                    let formatted = format_f_stop(r.num as f64 / r.denom as f64);
                    if !formatted.is_empty() {
                        return Some(formatted);
                    }
                }
            }
        }
        let s = normalize_f_stop_display(&field_display(field));
        if !s.is_empty() {
            return Some(s);
        }
    }
    if let Some(field) = find_field_by_tag(exif, exif::Tag::ApertureValue) {
        if let exif::Value::Rational(ref v) = field.value {
            if let Some(r) = v.first() {
                if r.denom != 0 {
                    let av = r.num as f64 / r.denom as f64;
                    let formatted = format_f_stop(2f64.powf(av / 2.0));
                    if !formatted.is_empty() {
                        return Some(formatted);
                    }
                }
            }
        }
    }
    None
}

fn format_focal_length(exif: &exif::Exif) -> Option<String> {
    if let Some(field) = find_field_by_tag(exif, exif::Tag::FocalLength) {
        if let exif::Value::Rational(ref v) = field.value {
            if let Some(r) = v.first() {
                if r.denom != 0 {
                    let mm = r.num as f64 / r.denom as f64;
                    if mm.is_finite() && mm > 0.0 {
                        let rounded = (mm * 10.0).round() / 10.0;
                        return Some(if (rounded - rounded.round()).abs() < 0.05 {
                            format!("{} mm", rounded.round() as i64)
                        } else {
                            format!("{rounded:.1} mm")
                        });
                    }
                }
            }
        }
        let s = field_display(field).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

fn format_lens(exif: &exif::Exif) -> Option<String> {
    if let Some(field) = exif.get_field(exif::Tag::LensModel, exif::In::PRIMARY) {
        let s = field_display(&field);
        if !s.is_empty() {
            return Some(s);
        }
    }
    let make = exif
        .get_field(exif::Tag::LensMake, exif::In::PRIMARY)
        .map(field_display)
        .filter(|s| !s.is_empty());
    let model = exif
        .get_field(exif::Tag::LensSpecification, exif::In::PRIMARY)
        .map(field_display)
        .filter(|s| !s.is_empty());
    match (make, model) {
        (Some(a), Some(b)) => Some(format!("{a} {b}")),
        (Some(a), None) | (None, Some(a)) => Some(a),
        (None, None) => None,
    }
}

fn format_distance_meters(m: f64) -> String {
    if m.is_infinite() {
        return "∞".to_string();
    }
    if !m.is_finite() || m <= 0.0 {
        return String::new();
    }
    if m >= 1_000.0 {
        format!("{:.0} km", m / 1_000.0)
    } else if m >= 100.0 {
        format!("{:.0} m", m)
    } else if m >= 1.0 {
        format!("{:.1} m", m)
    } else if m >= 0.01 {
        format!("{:.0} cm", m * 100.0)
    } else {
        format!("{:.0} mm", m * 1_000.0)
    }
}

fn makernote_bytes(field: &exif::Field) -> Option<&[u8]> {
    match &field.value {
        exif::Value::Undefined(bytes, _) => Some(bytes),
        exif::Value::Byte(bytes) => Some(bytes),
        _ => None,
    }
}

fn format_focus_distance(exif: &exif::Exif) -> Option<String> {
    if let Some(field) = find_field_by_tag(exif, exif::Tag::SubjectDistance) {
        if let exif::Value::Rational(ref v) = field.value {
            if let Some(r) = v.first() {
                if r.num == 0 {
                    return None;
                }
                if r.num == 0xffff_ffff {
                    return Some("∞".to_string());
                }
                if r.denom != 0 {
                    let meters = r.num as f64 / r.denom as f64;
                    if meters > 1_000_000.0 {
                        return Some("∞".to_string());
                    }
                    let formatted = format_distance_meters(meters);
                    if !formatted.is_empty() {
                        return Some(formatted);
                    }
                }
            }
        }
        let t = field_display(field);
        let t = t.trim();
        if t.is_empty() || t.eq_ignore_ascii_case("unknown") {
            return None;
        }
        if t.eq_ignore_ascii_case("infinity") {
            return Some("∞".to_string());
        }
        return Some(t.to_string());
    }
    if let Some(field) = find_field_by_tag(exif, exif::Tag::SubjectDistanceRange) {
        let t = field_display(field).trim().to_string();
        if t.is_empty() || t.eq_ignore_ascii_case("unknown") {
            return None;
        }
        return Some(t);
    }
    if let Some(field) = find_field_by_tag(exif, exif::Tag::MakerNote) {
        if let Some(bytes) = makernote_bytes(field) {
            if let Some(meters) = crate::makernote::focus_distance_meters(bytes) {
                let formatted = format_distance_meters(meters);
                if !formatted.is_empty() {
                    return Some(formatted);
                }
            }
        }
    }
    None
}

fn build_exif_overlay(exif: &exif::Exif) -> ExifOverlay {
    ExifOverlay {
        lens: format_lens(exif),
        focal_length: format_focal_length(exif),
        aperture: format_aperture(exif),
        shutter: format_exposure(exif),
        iso: format_iso(exif),
        focus_distance: format_focus_distance(exif),
    }
}

/// Reads EXIF metadata from `path` for the lightbox info modal and overlay.
pub fn read_exif_info(path: &str) -> Result<ExifInfo, String> {
    let Some(exif) = load_exif_container(path)? else {
        return Ok(ExifInfo {
            fields: Vec::new(),
            overlay: ExifOverlay::default(),
        });
    };

    let mut fields: Vec<ExifField> = exif
        .fields()
        .map(|f| ExifField {
            label: format!("{}", f.tag),
            value: field_display(f),
        })
        .filter(|f| !f.value.is_empty())
        .collect();
    fields.sort_by(|a, b| a.label.cmp(&b.label));

    Ok(ExifInfo {
        overlay: build_exif_overlay(&exif),
        fields,
    })
}

#[cfg(test)]
mod exif_overlay_tests {
    use super::*;

    #[test]
    fn format_f_stop_rounds_common_values() {
        assert_eq!(format_f_stop(2.8), "f/2.8");
        assert_eq!(format_f_stop(4.0), "f/4");
        assert_eq!(format_f_stop(5.6), "f/5.6");
    }

    #[test]
    fn normalize_f_stop_display_adds_prefix() {
        assert_eq!(normalize_f_stop_display("2.8"), "f/2.8");
        assert_eq!(normalize_f_stop_display("f/4"), "f/4");
        assert_eq!(normalize_f_stop_display("F/5.6"), "f/5.6");
    }

    #[test]
    fn apex_converts_to_f_stop() {
        // AV 6 = f/8 exactly
        assert_eq!(format_f_stop(2f64.powf(6.0 / 2.0)), "f/8");
    }

    #[test]
    fn format_distance_meters_scales_units() {
        assert_eq!(format_distance_meters(0.45), "45 cm");
        assert_eq!(format_distance_meters(2.5), "2.5 m");
        assert_eq!(format_distance_meters(120.0), "120 m");
        assert_eq!(format_distance_meters(f64::INFINITY), "∞");
    }

    #[test]
    fn format_focal_length_from_rational() {
        let path = "/Users/user/Nextcloud/Photos/DSCF0147.JPG";
        let Ok(Some(exif)) = load_exif_container(path) else {
            return;
        };
        assert_eq!(format_focal_length(&exif).as_deref(), Some("23 mm"));
    }
}
