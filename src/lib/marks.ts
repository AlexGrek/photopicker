import { invoke } from "@tauri-apps/api/core";

/** A photo's mark, persisted in the sled DB (see `src-tauri/src/marks.rs`). */
export interface Mark {
  /** 0 = unrated, otherwise 1–5 stars. */
  rating: number;
  flag: boolean;
}

export const EMPTY_MARK: Mark = { rating: 0, flag: false };

/** All saved marks for `dir`, keyed by file name. */
export function getMarks(dir: string): Promise<Record<string, Mark>> {
  return invoke<Record<string, Mark>>("get_marks", { dir });
}

/** Saves (or clears, when empty) the mark for one photo. */
export function setMark(dir: string, name: string, mark: Mark): Promise<void> {
  return invoke<void>("set_mark", { dir, name, mark });
}

/** Copies `src` into `targetDir` without overwriting; resolves to the destination path. */
export function copyToTarget(src: string, targetDir: string): Promise<string> {
  return invoke<string>("copy_to_target", { src, targetDir });
}

/** Moves `src` into `targetDir` (no original left behind); resolves to the destination path. */
export function moveToTarget(src: string, targetDir: string): Promise<string> {
  return invoke<string>("move_to_target", { src, targetDir });
}

/** Permanently deletes the file at `path`. */
export function deleteFile(path: string): Promise<void> {
  return invoke<void>("delete_file", { path });
}

/** Clears all flags in this directory's marks (ratings stay unchanged). */
export function clearFlags(dir: string): Promise<number> {
  return invoke<number>("clear_flags", { dir });
}

/** Clears all star ratings in this directory's marks (flags stay unchanged). */
export function clearStars(dir: string): Promise<number> {
  return invoke<number>("clear_stars", { dir });
}

export interface ExifWriteSummary {
  written: number;
  skipped: number;
  failed: number;
}

/** Writes stars from marks DB into EXIF metadata for supported files. */
export function writeStarsToExif(dir: string): Promise<ExifWriteSummary> {
  return invoke<ExifWriteSummary>("write_stars_to_exif", { dir });
}

export interface RotateImageResult {
  orientation: number;
  modified: number | null;
}

/** Rotates JPEG orientation metadata in-place. */
export function rotateImage(path: string, clockwise: boolean): Promise<RotateImageResult> {
  return invoke<RotateImageResult>("rotate_image_exif", { path, clockwise });
}
