import { convertFileSrc, invoke } from "@tauri-apps/api/core";

/** One JPEG file in a browsed directory (metadata only — see `list_images`). */
export interface ImageEntry {
  path: string;
  name: string;
  size: number;
  /** Created ms since epoch, if the filesystem provides it. */
  created: number | null;
  /** Last-modified ms since epoch; also the thumbnail URL's cache-busting version. */
  modified: number | null;
  /** True for RAW files (currently embedded preview only). */
  raw: boolean;
  /** True for video files (poster generated client-side; played natively). */
  video: boolean;
}

/** Lists the JPEGs in `dir`. Cheap — reads directory metadata, no file contents. */
export function listImages(dir: string): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>("list_images", { dir });
}

/**
 * Builds a `thumb://` URL the webview can load straight into an `<img>`.
 *
 * The Rust handler (see `src-tauri/src/lib.rs`) streams a small upright JPEG —
 * from the embedded EXIF thumbnail for tile-sized requests, or a capped decode
 * for the larger lightbox view. No base64: the browser fetches, decodes and
 * caches the bytes itself, so re-scrolling and opening the lightbox are instant.
 *
 * @param maxEdge longest edge in px (≈256 for tiles, larger for the lightbox)
 * @param nonce   in-session cache-buster, bumped after an in-place edit (rotation)
 *                in case the file's mtime is too coarse to change the `v=` version
 */
export function thumbUrl(entry: ImageEntry, maxEdge: number, nonce = 0): string {
  const base = convertFileSrc(entry.path, "thumb");
  const version = entry.modified != null ? `&v=${entry.modified}` : "";
  // The nonce is appended only once it is non-zero, so an un-rotated photo keeps
  // the exact URL its grid tile used and is served straight from the image cache.
  const bust = nonce > 0 ? `&r=${nonce}` : "";
  return `${base}?max=${maxEdge}${version}${bust}`;
}

/**
 * Builds an `orig://` URL that streams the **original full-resolution file** into
 * the webview, which decodes it natively. Used by the lightbox for the real photo;
 * the stretched thumbnail stands in until this finishes loading on slow storage.
 */
export function origUrl(entry: ImageEntry, nonce = 0): string {
  const base = convertFileSrc(entry.path, "orig");
  return nonce > 0 ? `${base}?r=${nonce}` : base;
}

/**
 * Builds a `video://` URL that streams a video file with HTTP Range support, so a
 * `<video>` element can seek without downloading the whole (potentially huge) file.
 * Used by the lightbox for playback and by the client-side poster-frame generator.
 */
export function videoUrl(entry: Pick<ImageEntry, "path" | "modified">): string {
  const base = convertFileSrc(entry.path, "video");
  const version = entry.modified != null ? `?v=${entry.modified}` : "";
  return `${base}${version}`;
}
