import { type ImageEntry } from "./thumbnails";
import { compareNames } from "./utils";

export type SortMode = "nameAsc" | "nameDesc" | "createdDesc" | "createdAsc" | "shotDesc" | "shotAsc";

export const SORT_LABEL: Record<SortMode, string> = {
  nameAsc: "Name A-Z",
  nameDesc: "Name Z-A",
  createdDesc: "Created newest",
  createdAsc: "Created oldest",
  shotDesc: "Shot date newest (slow)",
  shotAsc: "Shot date oldest (slow)",
};

export function isShotSort(mode: SortMode): boolean {
  return mode === "shotDesc" || mode === "shotAsc";
}

/** Converts an EXIF shot-date key (YYYYMMDDhhmmss) into a comparable local epoch (ms). */
export function shotKeyToEpoch(key: number): number {
  const s = String(key).padStart(14, "0");
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10));
  const mi = Number(s.slice(10, 12));
  const se = Number(s.slice(12, 14));
  return new Date(y, (mo || 1) - 1, d || 1, h, mi, se).getTime();
}

/**
 * A single, comparable timestamp (epoch ms) for the shot-date sort. Photos use their
 * EXIF shot date when available; videos (which carry no EXIF) fall back to the file's
 * creation time so they interleave organically with photos rather than clumping.
 * Returns -1 when nothing is known, matching the "unknown sorts last/first" behaviour.
 */
export function shotSortValue(entry: ImageEntry, shotDateByPath: Record<string, number>): number {
  const key = shotDateByPath[entry.path];
  if (key != null) return shotKeyToEpoch(key);
  if (entry.video) return entry.created ?? entry.modified ?? -1;
  return -1;
}

/**
 * Returns `entries` in `mode` order (a new array; the input is not mutated).
 *
 * Numeric sort keys are computed once per entry up front — the shot-date key in
 * particular parses a date, which is far too slow to redo inside the comparator —
 * and ties always fall back to the name, ascending.
 */
export function sortEntries(
  entries: readonly ImageEntry[],
  mode: SortMode,
  shotDateByPath: Record<string, number> = {},
): ImageEntry[] {
  const sorted = [...entries];
  if (sorted.length <= 1) return sorted;

  if (mode === "nameAsc") return sorted.sort((a, b) => compareNames(a.name, b.name));
  if (mode === "nameDesc") return sorted.sort((a, b) => compareNames(b.name, a.name));

  const keys = new Map<ImageEntry, number>();
  for (const entry of sorted) {
    keys.set(entry, isShotSort(mode) ? shotSortValue(entry, shotDateByPath) : (entry.created ?? -1));
  }
  const descending = mode === "createdDesc" || mode === "shotDesc";
  return sorted.sort((a, b) => {
    const ka = keys.get(a) as number;
    const kb = keys.get(b) as number;
    return (descending ? kb - ka : ka - kb) || compareNames(a.name, b.name);
  });
}
