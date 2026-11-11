import { type ImageEntry } from "./thumbnails";

export const CREATED_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export const DAY_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});

export const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
});

export const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatCreated(entry: ImageEntry): string {
  if (entry.created == null) return "Created date unavailable";
  return CREATED_DATE_FORMAT.format(new Date(entry.created));
}

/** Local-time `YYYY-MM-DD` key for a timestamp — the unit the date filter groups by. */
export function dayKeyFromTimestamp(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateFromDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** The timestamp the date filter buckets an entry by, or null when none is known. */
export function timestampForFilter(entry: ImageEntry): number | null {
  return entry.created ?? entry.modified ?? null;
}

/** The entry's date-filter day key, or null when it has no usable timestamp. */
export function dayKeyForEntry(entry: ImageEntry): string | null {
  const ts = timestampForFilter(entry);
  return ts == null ? null : dayKeyFromTimestamp(ts);
}

export interface DayBucket {
  count: number;
  /** First entry seen for the day — used as the day's thumbnail in the drawer. */
  preview: ImageEntry;
}

/** Groups entries by local day. */
export function bucketByDay(entries: readonly ImageEntry[]): Map<string, DayBucket> {
  const buckets = new Map<string, DayBucket>();
  for (const entry of entries) {
    const key = dayKeyForEntry(entry);
    if (key == null) continue;
    const prev = buckets.get(key);
    if (prev) prev.count += 1;
    else buckets.set(key, { count: 1, preview: entry });
  }
  return buckets;
}
