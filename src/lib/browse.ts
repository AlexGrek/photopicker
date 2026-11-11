import { invoke } from "@tauri-apps/api/core";
import { LruMap } from "./lru";
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

// Folder tiles are virtualized, so one tile mounts many times as it scrolls in
// and out of view. Each `directory_preview` call walks up to `maxDepth` levels of
// a possibly slow volume, so the in-flight/settled promise is cached per folder.
const previewCache = new LruMap<string, Promise<ImageEntry[]>>(500);

/** Up to four image previews for a folder tile, recursing at most `maxDepth` levels. */
export function directoryPreview(dir: string, maxDepth: number): Promise<ImageEntry[]> {
  const key = `${maxDepth}\n${dir}`;
  const cached = previewCache.get(key);
  if (cached) return cached;
  const request = invoke<ImageEntry[]>("directory_preview", { dir, maxDepth });
  previewCache.set(key, request);
  // A failed walk (card pulled, share offline) should be retried next time.
  request.catch(() => previewCache.delete(key));
  return request;
}

/**
 * Drops every cached folder preview. Called when files are moved or deleted (a
 * cached preview may name a file that no longer exists) and when a location is
 * freshly opened from the main menu.
 */
export function invalidateDirectoryPreviews(): void {
  previewCache.clear();
}
