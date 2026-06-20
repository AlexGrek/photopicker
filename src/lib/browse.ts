import { invoke } from "@tauri-apps/api/core";
import { type ImageEntry } from "@/lib/thumbnails";

/** Max recursion depth when sampling a folder tile's 2×2 preview mosaic. */
export const PREVIEW_RECURSION_LIMIT = 3;

export interface DirectoryEntry {
  path: string;
  name: string;
}

export type BrowserItem =
  | { kind: "directory"; path: string; name: string }
  | { kind: "photo"; entry: ImageEntry };

export function itemPath(item: BrowserItem): string {
  return item.kind === "directory" ? item.path : item.entry.path;
}

export function itemName(item: BrowserItem): string {
  return item.kind === "directory" ? item.name : item.entry.name;
}

export function isPhotoItem(item: BrowserItem): item is { kind: "photo"; entry: ImageEntry } {
  return item.kind === "photo";
}

/** Lists subdirectories in `dir`. Cheap — reads directory metadata only. */
export function listDirectories(dir: string): Promise<DirectoryEntry[]> {
  return invoke<DirectoryEntry[]>("list_directories", { dir });
}

/** Up to four image previews for a folder tile, recursing at most `maxDepth` levels. */
export function directoryPreview(dir: string, maxDepth: number): Promise<ImageEntry[]> {
  return invoke<ImageEntry[]>("directory_preview", { dir, maxDepth });
}
