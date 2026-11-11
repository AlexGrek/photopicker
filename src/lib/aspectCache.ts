import { LruMap } from "./lru";
import { type ImageEntry } from "./thumbnails";

/**
 * Remembers each tile's aspect ratio once its thumbnail has loaded.
 *
 * `list_images` deliberately reads no file contents, so a tile only learns its
 * real shape from the loaded thumbnail. Without this cache a tile that scrolls
 * out of the virtualized masonry and back would mount square again and then snap
 * to its real ratio — re-measuring the column and shifting everything below it.
 */
const ratios = new LruMap<string, string>(20_000);

function key(entry: ImageEntry): string {
  return `${entry.path}?${entry.modified ?? 0}`;
}

export function cachedAspectRatio(entry: ImageEntry): string | undefined {
  return ratios.get(key(entry));
}

export function rememberAspectRatio(entry: ImageEntry, ratio: string): void {
  ratios.set(key(entry), ratio);
}
