import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Abbreviates a home-relative path to `~…` for compact display. Handles the
 * macOS (`/Users/<name>/…`), Linux (`/home/<name>/…`) and Windows
 * (`C:\Users\<name>\…`) layouts; any other path is returned unchanged.
 */
export function shortenPath(p: string): string {
  const posix = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(p);
  if (posix) return posix[1] ? `~${posix[1]}` : "~";
  const windows = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+([\\/].*)?$/.exec(p);
  if (windows) return windows[1] ? `~${windows[1]}` : "~";
  return p;
}

/** Last path segment of `path` (either separator), ignoring trailing separators. */
export function baseName(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

/** Returns a copy of `set` with `value` added if absent, removed if present. */
export function toggleInSet<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** `1 photo` / `3 photos`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * One shared collator for every file-name comparison. Constructing a collator is
 * the expensive part of `localeCompare(…, options)`, so sorting thousands of
 * entries through a single instance is dramatically cheaper. `numeric` orders
 * `IMG_2` before `IMG_10`.
 */
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

export function compareNames(a: string, b: string): number {
  return NAME_COLLATOR.compare(a, b);
}
