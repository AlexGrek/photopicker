mod config;
mod images;
mod makernote;
mod marks;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use config::Config;
use images::{DirectoryEntry, ExifInfo, ImageEntry};
use little_exif::exif_tag::ExifTag;
use little_exif::ifd::ExifTagGroup;
use little_exif::metadata::Metadata;
use marks::{Mark, MarksDb};
use serde::Serialize;
use tauri::http::{Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, UriSchemeResponder};
use tokio::sync::Semaphore;

/// Max concurrent thumbnail decodes. Small enough not to thrash a memory card,
/// large enough to keep the grid filling smoothly.
const THUMB_CONCURRENCY: usize = 8;

/// What an OS "Open with" / file-association request resolves to: a directory to
/// browse, plus optionally a specific file within it to pop straight into the
/// lightbox. A folder opens itself; a file opens its parent folder with the file
/// flagged so the frontend can jump to it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenTarget {
    dir: String,
    file: Option<String>,
}

/// Shared slot for a file-association / "Open with" request. The OS can hand us a
/// path before the webview is alive (launch) or while it is already running. Launch
/// requests are stashed here and drained by [`take_pending_open`] once the frontend
/// mounts; later requests are emitted as `open-target` events instead. The ready
/// flag and the pending slot share one lock so a launch race can't drop a request.
#[derive(Default)]
struct OpenState(Mutex<OpenInner>);

#[derive(Default)]
struct OpenInner {
    pending: Option<OpenTarget>,
    ready: bool,
}

/// Resolves an opened filesystem path into an [`OpenTarget`], or `None` if the path
/// doesn't exist (so stray CLI flags never get mistaken for a folder to open).
fn resolve_open_target(path: &Path) -> Option<OpenTarget> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.is_dir() {
        Some(OpenTarget {
            dir: path.to_string_lossy().into_owned(),
            file: None,
        })
    } else {
        Some(OpenTarget {
            dir: path.parent()?.to_string_lossy().into_owned(),
            file: Some(path.file_name()?.to_string_lossy().into_owned()),
        })
    }
}

/// Routes a freshly opened path to the frontend: emits it when the webview is up,
/// otherwise stashes it for [`take_pending_open`] to deliver once the app mounts.
fn dispatch_open(app: &AppHandle, target: OpenTarget) {
    let state = app.state::<OpenState>();
    let mut inner = state.0.lock().unwrap();
    if inner.ready {
        drop(inner); // don't hold the lock across the emit
        let _ = app.emit("open-target", target);
    } else {
        inner.pending = Some(target);
    }
}

/// Called by the frontend once mounted. Marks the webview ready (so subsequent OS
/// opens arrive as `open-target` events) and returns any open request captured at
/// launch, so a double-clicked photo lands in the lightbox on the first paint.
#[tauri::command]
fn take_pending_open(state: State<OpenState>) -> Option<OpenTarget> {
    let mut inner = state.0.lock().unwrap();
    inner.ready = true;
    inner.pending.take()
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Lists the JPEG files in `dir` (metadata only — reads no file contents).
///
/// Async + `spawn_blocking` is deliberate: enumerating a huge or slow (network /
/// memory-card) directory can take many seconds, and a synchronous command would
/// run on the main thread and freeze the whole window. Off-loading it keeps the
/// event loop free so the gallery's loading animation actually runs.
#[tauri::command]
async fn list_images(dir: String) -> Result<Vec<ImageEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || images::list_images(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_directories(dir: String) -> Result<Vec<DirectoryEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || images::list_directories(&dir))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn directory_preview(dir: String, max_depth: u32) -> Result<Vec<ImageEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || images::directory_preview(&dir, max_depth))
        .await
        .map_err(|e| e.to_string())?
}

/// Reads EXIF shot dates for supported files in `dir` (slow path, on demand).
/// Returns a map keyed by absolute file path.
#[tauri::command]
async fn list_shot_dates(dir: String, raw_coupling: bool) -> Result<HashMap<String, u64>, String> {
    tauri::async_runtime::spawn_blocking(move || images::list_shot_dates(&dir, raw_coupling))
        .await
        .map_err(|e| e.to_string())?
}

/// Reads EXIF metadata for one file (bounded prefix read; whole file only when needed).
#[tauri::command]
async fn get_exif_info(path: String) -> Result<ExifInfo, String> {
    tauri::async_runtime::spawn_blocking(move || images::read_exif_info(&path))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_config() -> Config {
    Config::load()
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    config.save()
}

#[tauri::command]
fn push_recent_directory(dir: String) -> Result<Config, String> {
    let mut cfg = Config::load();
    cfg.push_recent_directory(dir);
    cfg.save()?;
    Ok(cfg)
}

#[tauri::command]
fn add_target_directory(dir: String) -> Result<Config, String> {
    let mut cfg = Config::load();
    cfg.add_target_directory(dir);
    cfg.save()?;
    Ok(cfg)
}

#[tauri::command]
fn remove_target_directory(dir: String) -> Result<Config, String> {
    let mut cfg = Config::load();
    cfg.remove_target_directory(&dir);
    cfg.save()?;
    Ok(cfg)
}

#[tauri::command]
fn set_last_target_directory(dir: String) -> Result<Config, String> {
    let mut cfg = Config::load();
    cfg.set_last_target_directory(dir);
    cfg.save()?;
    Ok(cfg)
}

#[tauri::command]
fn remove_recent_directory(dir: String) -> Result<Config, String> {
    let mut cfg = Config::load();
    cfg.remove_recent_directory(&dir);
    cfg.save()?;
    Ok(cfg)
}

/// Returns every saved mark (rating + flag) for the photos in `dir`, keyed by file name.
#[tauri::command]
fn get_marks(db: State<MarksDb>, dir: String) -> Result<HashMap<String, Mark>, String> {
    db.get_all(&dir)
}

/// Saves (or clears, if empty) the mark for one photo in `dir`.
#[tauri::command]
fn set_mark(db: State<MarksDb>, dir: String, name: String, mark: Mark) -> Result<(), String> {
    db.set(&dir, &name, &mark)
}

/// Clears all flags in `dir` while preserving star ratings.
#[tauri::command]
fn clear_flags(db: State<MarksDb>, dir: String) -> Result<u32, String> {
    let marks = db.get_all(&dir)?;
    let mut changed = 0u32;
    for (name, mark) in marks {
        if !mark.flag {
            continue;
        }
        db.set(
            &dir,
            &name,
            &Mark {
                rating: mark.rating,
                flag: false,
            },
        )?;
        changed += 1;
    }
    Ok(changed)
}

/// Clears all star ratings in `dir` while preserving flags.
#[tauri::command]
fn clear_stars(db: State<MarksDb>, dir: String) -> Result<u32, String> {
    let marks = db.get_all(&dir)?;
    let mut changed = 0u32;
    for (name, mark) in marks {
        if mark.rating == 0 {
            continue;
        }
        db.set(
            &dir,
            &name,
            &Mark {
                rating: 0,
                flag: mark.flag,
            },
        )?;
        changed += 1;
    }
    Ok(changed)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExifWriteSummary {
    written: u32,
    skipped: u32,
    failed: u32,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct RotateImageResult {
    orientation: u16,
    modified: Option<u64>,
}

fn is_rating_writable(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase).as_deref(),
        Some("jpg" | "jpeg" | "jpe" | "jfif")
    )
}

fn rating_percent(rating: u8) -> u16 {
    (rating as u16).saturating_mul(20).min(100)
}

fn write_rating_to_exif(path: &Path, rating: u8) -> Result<(), String> {
    let mut metadata = Metadata::new_from_path(path).unwrap_or_default();
    // Microsoft rating tags commonly consumed by DAM tools.
    metadata.remove_tag_by_hex_group(0x4746, ExifTagGroup::GENERIC);
    metadata.remove_tag_by_hex_group(0x4749, ExifTagGroup::GENERIC);
    if rating > 0 {
        metadata.set_tag(ExifTag::UnknownINT16U(vec![rating as u16], 0x4746, ExifTagGroup::GENERIC));
        metadata.set_tag(ExifTag::UnknownINT16U(
            vec![rating_percent(rating)],
            0x4749,
            ExifTagGroup::GENERIC,
        ));
    }
    metadata
        .write_to_file(path)
        .map_err(|e| format!("{}: {}", path.display(), e))
}

fn rotate_orientation(current: u16, clockwise: bool) -> u16 {
    match (current, clockwise) {
        (1, true) => 6,
        (2, true) => 7,
        (3, true) => 8,
        (4, true) => 5,
        (5, true) => 2,
        (6, true) => 3,
        (7, true) => 4,
        (8, true) => 1,
        (1, false) => 8,
        (2, false) => 5,
        (3, false) => 6,
        (4, false) => 7,
        (5, false) => 4,
        (6, false) => 1,
        (7, false) => 2,
        (8, false) => 3,
        (_, _) => {
            if clockwise {
                6
            } else {
                8
            }
        }
    }
}

fn file_modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// Rotates a JPEG by updating only EXIF orientation metadata (no pixel rewrite).
#[tauri::command]
fn rotate_image_exif(path: String, clockwise: bool) -> Result<RotateImageResult, String> {
    let image_path = PathBuf::from(&path);
    if !is_rating_writable(&image_path) {
        return Err("Rotation is supported only for JPEG files".into());
    }
    let mut metadata = Metadata::new_from_path(&image_path).unwrap_or_default();
    let current = metadata
        .get_tag(&ExifTag::Orientation(Vec::new()))
        .next()
        .and_then(|tag| match tag {
            ExifTag::Orientation(values) => values.first().copied(),
            _ => None,
        })
        .filter(|v| (1..=8).contains(v))
        .unwrap_or(1);
    let next = rotate_orientation(current, clockwise);
    metadata.set_tag(ExifTag::Orientation(vec![next]));
    metadata
        .write_to_file(&image_path)
        .map_err(|e| format!("{}: {}", image_path.display(), e))?;
    Ok(RotateImageResult {
        orientation: next,
        modified: file_modified_ms(&image_path),
    })
}

/// Writes current star ratings from the marks database into image EXIF tags.
#[tauri::command]
fn write_stars_to_exif(db: State<MarksDb>, dir: String) -> Result<ExifWriteSummary, String> {
    let marks = db.get_all(&dir)?;
    let mut summary = ExifWriteSummary {
        written: 0,
        skipped: 0,
        failed: 0,
    };
    for (name, mark) in marks {
        let path = PathBuf::from(&dir).join(&name);
        if !path.exists() || !is_rating_writable(&path) {
            summary.skipped += 1;
            continue;
        }
        match write_rating_to_exif(&path, mark.rating) {
            Ok(()) => summary.written += 1,
            Err(_) => summary.failed += 1,
        }
    }
    Ok(summary)
}

/// Picks a non-clobbering path inside `target_dir` for a file named like `src`'s
/// file name, appending ` (n)` before the extension if something is already there.
fn unique_destination(src: &Path, target_dir: &str) -> Result<PathBuf, String> {
    let file_name = src.file_name().ok_or("source has no file name")?;
    let mut dest = PathBuf::from(target_dir);
    dest.push(file_name);
    if !dest.exists() {
        return Ok(dest);
    }
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().into_owned());
    for n in 1.. {
        let candidate = match &ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let path = PathBuf::from(target_dir).join(candidate);
        if !path.exists() {
            return Ok(path);
        }
    }
    unreachable!("the loop always returns")
}

fn copy_path_recursive(src: &Path, dest: &Path) -> Result<(), String> {
    if src.is_dir() {
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            copy_path_recursive(&entry.path(), &dest.join(name))?;
        }
    } else {
        std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn remove_path_recursive(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

fn move_path(src: &Path, dest: &Path) -> Result<(), String> {
    if std::fs::rename(src, dest).is_err() {
        copy_path_recursive(src, dest)?;
        remove_path_recursive(src)?;
    }
    Ok(())
}

/// Copies the photo at `src` into `target_dir` (one of the configured target
/// locations), never overwriting an existing file. Returns the destination path.
/// Off-thread: originals can be 100 MP, and the copy must not freeze the window.
#[tauri::command]
async fn copy_to_target(src: String, target_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&src);
        let dest = unique_destination(src, &target_dir)?;
        if src.is_dir() {
            copy_path_recursive(src, &dest)?;
        } else {
            std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
        }
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Like [`copy_to_target`], but the original is not left behind. Tries a plain
/// rename first (instant, same filesystem); falls back to copy-then-delete when
/// the target is on a different volume (network share / external card), where
/// `rename` fails with a cross-device error.
#[tauri::command]
async fn move_to_target(src: String, target_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = Path::new(&src);
        let dest = unique_destination(src, &target_dir)?;
        move_path(src, &dest)?;
        Ok(dest.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Permanently deletes the photo or folder at `path`. Destructive and irreversible —
/// the caller gates this behind an explicit confirmation.
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || remove_path_recursive(Path::new(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Percent-decodes the file path from a `<scheme>://localhost/<urlencoded path>` URI.
fn decode_request_path(request: &Request<Vec<u8>>) -> Option<String> {
    let encoded = request.uri().path().trim_start_matches('/');
    let path = urlencoding::decode(encoded).ok()?.into_owned();
    (!path.is_empty()).then_some(path)
}

/// Reads the `max=<n>` query parameter, defaulting to 256 and clamped to a sane range.
fn request_max_edge(request: &Request<Vec<u8>>) -> u32 {
    request
        .uri()
        .query()
        .and_then(|q| {
            q.split('&')
                .find_map(|pair| pair.strip_prefix("max=").and_then(|v| v.parse::<u32>().ok()))
        })
        .unwrap_or(256)
        .clamp(32, 4096)
}

fn jpeg_response(bytes: Vec<u8>, cache_control: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(200)
        .header("Content-Type", "image/jpeg")
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", cache_control)
        .body(bytes)
        .unwrap()
}

fn error_response(status: u16) -> Response<Vec<u8>> {
    Response::builder().status(status).body(Vec::new()).unwrap()
}

/// Handles one `thumb://` request: throttles, renders the thumbnail off-thread,
/// and replies with raw JPEG bytes (no base64 — the webview loads it like any image).
fn handle_thumb_request(
    sem: Arc<Semaphore>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    tauri::async_runtime::spawn(async move {
        let Some(path) = decode_request_path(&request) else {
            responder.respond(error_response(400));
            return;
        };
        let max_edge = request_max_edge(&request);
        // Hold a permit for the whole decode to cap concurrent reads off the card.
        let _permit = sem.acquire_owned().await;
        let rendered =
            tauri::async_runtime::spawn_blocking(move || images::render_thumbnail(&path, max_edge))
                .await;
        let response = match rendered {
            // Path + max + mtime fully identify the bytes, so let the webview cache hard.
            Ok(Ok(bytes)) => jpeg_response(bytes, "private, max-age=31536000, immutable"),
            _ => error_response(404),
        };
        responder.respond(response);
    });
}

/// Maps a video file's extension to a MIME type the webview's media element understands.
fn video_content_type(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mov") => "video/quicktime",
        Some("m4v") => "video/x-m4v",
        _ => "video/mp4",
    }
}

/// Parses an HTTP `Range: bytes=start-end` header into an inclusive `(start, end)` byte
/// range clamped to `total`. Only a single range is supported (the common media case).
/// Returns `None` when there is no (usable) range, so the caller serves the whole file.
fn parse_range(request: &Request<Vec<u8>>, total: u64) -> Option<(u64, u64)> {
    if total == 0 {
        return None;
    }
    let value = request.headers().get("range")?.to_str().ok()?;
    let spec = value.trim().strip_prefix("bytes=")?;
    // Ignore multi-range requests — reply with the first (or whole file if unparsable).
    let spec = spec.split(',').next()?.trim();
    let (start_s, end_s) = spec.split_once('-')?;
    let last = total - 1;
    let (start, end) = if start_s.is_empty() {
        // Suffix range: bytes=-N → the final N bytes.
        let n: u64 = end_s.parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), last)
    } else {
        let start: u64 = start_s.parse().ok()?;
        let end = if end_s.is_empty() { last } else { end_s.parse::<u64>().ok()?.min(last) };
        (start, end)
    };
    if start > end || start > last {
        return None;
    }
    Some((start, end))
}

/// Reads `[start, end]` (inclusive) bytes from `path` without loading the whole file.
fn read_file_range(path: &str, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let len = (end - start + 1) as usize;
    let mut buf = vec![0u8; len];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Handles one `video://` request: streams the video with HTTP Range support so the
/// webview's `<video>` element can seek without downloading the whole (potentially huge)
/// file. Replies `206 Partial Content` for a ranged request, `200` for the whole file.
fn handle_video_request(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let Some(path) = decode_request_path(&request) else {
            responder.respond(error_response(400));
            return;
        };
        let content_type = video_content_type(&path);
        let result = tauri::async_runtime::spawn_blocking(move || {
            let total = std::fs::metadata(&path)?.len();
            let range = parse_range(&request, total);
            match range {
                Some((start, end)) => {
                    let bytes = read_file_range(&path, start, end)?;
                    Ok::<_, std::io::Error>((bytes, Some((start, end)), total))
                }
                None => {
                    let bytes = std::fs::read(&path)?;
                    Ok((bytes, None, total))
                }
            }
        })
        .await;

        let response = match result {
            Ok(Ok((bytes, range, total))) => {
                let mut builder = Response::builder()
                    .header("Content-Type", content_type)
                    .header("Access-Control-Allow-Origin", "*")
                    .header("Accept-Ranges", "bytes")
                    .header("Cache-Control", "no-store")
                    .header("Content-Length", bytes.len().to_string());
                builder = match range {
                    Some((start, end)) => builder
                        .status(206)
                        .header("Content-Range", format!("bytes {start}-{end}/{total}")),
                    None => builder.status(200),
                };
                builder.body(bytes).unwrap()
            }
            _ => error_response(404),
        };
        responder.respond(response);
    });
}

/// Handles one `orig://` request: streams the original file's bytes verbatim so the
/// webview decodes the full-resolution image itself. Used by the lightbox, where the
/// user has explicitly chosen to view the full photo (not a fast preview).
fn handle_orig_request(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    tauri::async_runtime::spawn(async move {
        let Some(path) = decode_request_path(&request) else {
            responder.respond(error_response(400));
            return;
        };
        let read = tauri::async_runtime::spawn_blocking(move || std::fs::read(&path)).await;
        let response = match read {
            // Originals can be huge — don't let them pile up in the webview cache.
            Ok(Ok(bytes)) => jpeg_response(bytes, "no-store"),
            _ => error_response(404),
        };
        responder.respond(response);
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Preload rawloader's camera database so RAW preview support is ready once
    // we start reading embedded previews from ARW/RAF files.
    rawloader::force_initialization();
    let thumb_sem = Arc::new(Semaphore::new(THUMB_CONCURRENCY));
    let marks_db = MarksDb::open().expect("failed to open marks database");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(marks_db)
        .manage(OpenState::default())
        .setup(|app| {
            // A first-launch file open on Windows/Linux (and `photopicker <path>` from
            // a shell on any platform) arrives as a CLI argument, not an Opened event.
            if let Some(arg) = std::env::args_os().nth(1) {
                if let Some(target) = resolve_open_target(Path::new(&arg)) {
                    dispatch_open(app.handle(), target);
                }
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("thumb", move |_ctx, request, responder| {
            handle_thumb_request(thumb_sem.clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("orig", |_ctx, request, responder| {
            handle_orig_request(request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("video", |_ctx, request, responder| {
            handle_video_request(request, responder);
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_config,
            save_config,
            push_recent_directory,
            add_target_directory,
            remove_target_directory,
            set_last_target_directory,
            remove_recent_directory,
            get_marks,
            set_mark,
            clear_flags,
            clear_stars,
            write_stars_to_exif,
            rotate_image_exif,
            copy_to_target,
            move_to_target,
            delete_file,
            list_images,
            list_directories,
            directory_preview,
            list_shot_dates,
            get_exif_info,
            take_pending_open,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |_app_handle, _event| {
        // macOS delivers file-association / "Open with" requests — at launch and while
        // the app is already running — as Opened events carrying file:// URLs.
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &_event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if let Some(target) = resolve_open_target(&path) {
                        dispatch_open(_app_handle, target);
                        break;
                    }
                }
            }
        }
    });
}
