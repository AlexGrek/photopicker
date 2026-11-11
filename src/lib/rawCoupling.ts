import { type ImageEntry } from "./thumbnails";

/** Case-insensitive file name without its extension — what pairs a RAW with its JPEG. */
export function stemKey(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
}

export function isJpegName(name: string): boolean {
  return /\.(jpg|jpeg|jpe|jfif)$/i.test(name);
}

export function hasJpegRawPair(items: readonly ImageEntry[]): boolean {
  const groups = new Map<string, { raw: boolean; jpeg: boolean }>();
  for (const item of items) {
    const key = stemKey(item.name);
    const entry = groups.get(key) ?? { raw: false, jpeg: false };
    if (item.raw) entry.raw = true;
    if (isJpegName(item.name)) entry.jpeg = true;
    groups.set(key, entry);
    if (entry.raw && entry.jpeg) return true;
  }
  return false;
}

// Heuristic requested by product: sample 2 files from the start and 4 from the
// end; if at least one JPEG/RAW pair exists there, auto-enable raw coupling.
export function detectRawCouplingBySample(items: readonly ImageEntry[]): boolean {
  if (items.length === 0) return false;
  const sampled: ImageEntry[] = [];
  const seen = new Set<string>();
  const pushUnique = (entry: ImageEntry | undefined) => {
    if (!entry || seen.has(entry.path)) return;
    seen.add(entry.path);
    sampled.push(entry);
  };
  for (const entry of items.slice(0, 2)) pushUnique(entry);
  for (const entry of items.slice(Math.max(0, items.length - 4))) pushUnique(entry);
  return hasJpegRawPair(sampled);
}

export interface RawCouplingMeta {
  /** RAW files that have a JPEG sibling — hidden from the grid while coupling is on. */
  hiddenRawPaths: Set<string>;
  /** For each visible JPEG, every file (JPEG + RAWs) an action on it should affect. */
  actionPathsByPath: Record<string, string[]>;
}

export function buildRawCouplingMeta(entries: readonly ImageEntry[] | null): RawCouplingMeta {
  const hiddenRawPaths = new Set<string>();
  const actionPathsByPath: Record<string, string[]> = {};
  if (!entries || entries.length === 0) return { hiddenRawPaths, actionPathsByPath };

  const groups = new Map<string, ImageEntry[]>();
  for (const entry of entries) {
    const key = stemKey(entry.name);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  for (const group of groups.values()) {
    const raws = group.filter((e) => e.raw);
    const jpegs = group.filter((e) => isJpegName(e.name));
    if (raws.length === 0 || jpegs.length === 0) continue;
    for (const raw of raws) hiddenRawPaths.add(raw.path);
    const coupledPaths = group.map((e) => e.path);
    for (const jpeg of jpegs) actionPathsByPath[jpeg.path] = coupledPaths;
  }

  return { hiddenRawPaths, actionPathsByPath };
}
