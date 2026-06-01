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

/// Lists supported image files directly inside `dir`, sorted case-insensitively by name.
pub fn list_images(dir: &str) -> Result<Vec<ImageEntry>, String> {
    let read = fs::read_dir(dir).map_err(|e| format!("Cannot read {dir}: {e}"))?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        let ext = file_ext(&path);
        let is_raw = is_raw_ext(ext);
        if !is_jpeg_ext(ext) && !is_raw {
            continue;
        }
        let meta = entry.metadata().ok();
        if meta.as_ref().map(|m| !m.is_file()).unwrap_or(false) {
            continue;
        }
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let created = meta
            .as_ref()
            .and_then(|m| m.created().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        out.push(ImageEntry {
            path: path.to_string_lossy().into_owned(),
            name: entry.file_name().to_string_lossy().into_owned(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified,
            created,
            raw: is_raw,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

fn file_ext(path: &Path) -> Option<&str> {
    path.extension().and_then(|e| e.to_str())
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
