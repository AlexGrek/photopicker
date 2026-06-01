import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtuosoMasonry, type ItemContent } from "@virtuoso.dev/masonry";
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Ellipsis, Flag, ImageOff, SlidersHorizontal, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listImages, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { type Config } from "@/lib/config";
import { EMPTY_MARK, clearFlags, clearStars, getMarks, writeStarsToExif, type Mark } from "@/lib/marks";
import { PhotoTile, type TileContext } from "./PhotoTile";
import { Lightbox } from "./Lightbox";

/** Pick a column count that keeps tiles a comfortable size at any window width. */
function useColumnCount(): number {
  const [count, setCount] = useState(4);
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      if (w < 480) setCount(2);
      else if (w < 768) setCount(3);
      else if (w < 1100) setCount(4);
      else if (w < 1500) setCount(5);
      else setCount(6);
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return count;
}

const TileItem = PhotoTile as ItemContent<ImageEntry, TileContext>;
type ViewMode = "masonry" | "grid" | "list";
type SortMode = "nameAsc" | "nameDesc" | "createdDesc" | "createdAsc" | "shotDesc" | "shotAsc";
const SORT_LABEL: Record<SortMode, string> = {
  nameAsc: "Name A-Z",
  nameDesc: "Name Z-A",
  createdDesc: "Created newest",
  createdAsc: "Created oldest",
  shotDesc: "Shot date newest (slow)",
  shotAsc: "Shot date oldest (slow)",
};
const CREATED_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const DAY_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
});
const MONTH_LABEL_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "long",
});
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dirName(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || dir;
}

function formatCreated(entry: ImageEntry): string {
  if (entry.created == null) return "Created date unavailable";
  return CREATED_DATE_FORMAT.format(new Date(entry.created));
}

function dayKeyFromTimestamp(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dateFromDayKey(dayKey: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function monthKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function timestampForFilter(entry: ImageEntry): number | null {
  return entry.created ?? entry.modified ?? null;
}

function stemKey(name: string): string {
  return name.replace(/\.[^.]+$/, "").toLocaleLowerCase();
}

function isJpegName(name: string): boolean {
  return /\.(jpg|jpeg|jpe|jfif)$/i.test(name);
}

function hasJpegRawPair(items: ImageEntry[]): boolean {
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
function detectRawCouplingBySample(items: ImageEntry[]): boolean {
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

/** Stable, varied aspect ratios so the loading skeleton reads as a masonry, not a grid. */
const SKELETON_ASPECTS = [1.3, 0.74, 1, 1.5, 0.8, 1.2, 0.66, 1.05, 1.4, 0.9, 1.15, 0.7];

/**
 * Shimmering placeholder shown while `list_images` is still reading a slow or huge
 * directory. It mirrors the masonry's column layout and reuses the same per-tile
 * shimmer, so when the real thumbnails arrive the transition feels continuous.
 */
function GallerySkeleton({ columnCount }: { columnCount: number }) {
  const tiles = columnCount * 5;
  return (
    <div className="ph-skeleton" style={{ columnCount }} aria-hidden>
      {Array.from({ length: tiles }, (_, i) => (
        <div
          key={i}
          className="ph-skeleton-tile ph-tile-skeleton"
          style={{
            aspectRatio: String(SKELETON_ASPECTS[i % SKELETON_ASPECTS.length]),
            // Negative, staggered delays start each tile mid-shimmer for an organic feel.
            animationDelay: `${-(i % 8) * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
}

export function Gallery({
  dir,
  initialFile,
  onBack,
}: {
  dir: string;
  /** File name to pop into the lightbox once this directory loads (an "Open with"
   *  / file-association launch); ignored thereafter. */
  initialFile?: string;
  onBack: () => void;
}) {
  const columnCount = useColumnCount();
  const [entries, setEntries] = useState<ImageEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Per-photo marks for this directory, keyed by file name. Loaded with the listing
  // and refreshed when the lightbox closes, so rating/flag edits there feed the filters.
  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [minRating, setMinRating] = useState(0); // 0 = any rating
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("masonry");
  const [sortMode, setSortMode] = useState<SortMode>("nameAsc");
  const [rawCoupling, setRawCoupling] = useState(false);
  const [galleryNotice, setGalleryNotice] = useState<{ id: number; text: string } | null>(null);
  const [enableRawCouplingDetection, setEnableRawCouplingDetection] = useState(true);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [busyAction, setBusyAction] = useState<null | "flags" | "stars" | "write">(null);
  const [shotDateByPath, setShotDateByPath] = useState<Record<string, number>>({});
  const [shotDateKeyLoaded, setShotDateKeyLoaded] = useState<string | null>(null);
  const [browseMenuOpen, setBrowseMenuOpen] = useState(false);
  const [dateDrawerOpen, setDateDrawerOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStart(new Date()));
  const browseMenuRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const dateDrawerRef = useRef<HTMLDivElement | null>(null);
  // Which `initialFile` we've already auto-opened, so later list changes (e.g. a
  // move/delete dropping a tile) never yank the lightbox back to the opened photo.
  const openedFileRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    setOpenIndex(null);
    setActionMenuOpen(false);
    setBrowseMenuOpen(false);
    setDateDrawerOpen(false);
    setSelectedDay(null);
    setCalendarMonth(monthStart(new Date()));
    setMarks({});
    setShotDateByPath({});
    setShotDateKeyLoaded(null);
    openedFileRef.current = undefined;
    Promise.all([
      listImages(dir),
      invoke<Config>("get_config").catch(() => ({ enableRawCouplingDetection: true } as Config)),
    ]).then(
      ([list, cfg]) => {
        if (!alive) return;
        const detectionEnabled = cfg.enableRawCouplingDetection;
        setEnableRawCouplingDetection(detectionEnabled);
        setEntries(list);
        const autoEnabled = detectionEnabled && detectRawCouplingBySample(list);
        setRawCoupling(autoEnabled);
        if (autoEnabled) setGalleryNotice({ id: Date.now(), text: "Raw coupling enabled" });
      },
      (e) => {
        if (alive) setError(String(e));
      },
    );
    getMarks(dir).then(
      (m) => alive && setMarks(m),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [dir]);

  useEffect(() => {
    if (!galleryNotice) return;
    const t = setTimeout(() => setGalleryNotice(null), 2600);
    return () => clearTimeout(t);
  }, [galleryNotice]);

  const shotSort = sortMode === "shotDesc" || sortMode === "shotAsc";
  const shotDateLoadKey = `${dir}:${rawCoupling ? "coupled" : "plain"}`;
  useEffect(() => {
    if (!shotSort) return;
    if (shotDateKeyLoaded === shotDateLoadKey) return;
    let alive = true;
    invoke<Record<string, number>>("list_shot_dates", { dir, rawCoupling }).then(
      (map) => {
        if (!alive) return;
        setShotDateByPath(map);
        setShotDateKeyLoaded(shotDateLoadKey);
      },
      () => {
        if (!alive) return;
        setShotDateByPath({});
        setShotDateKeyLoaded(shotDateLoadKey);
      },
    );
    return () => {
      alive = false;
    };
  }, [dir, rawCoupling, shotSort, shotDateKeyLoaded, shotDateLoadKey]);

  const filtersActive = minRating > 0 || flaggedOnly || selectedDay !== null;

  const rawCouplingMeta = useMemo(() => {
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
  }, [entries]);

  const baseEntries = useMemo(() => {
    if (!entries) return [];
    if (!rawCoupling) return entries;
    return entries.filter((e) => !rawCouplingMeta.hiddenRawPaths.has(e.path));
  }, [entries, rawCoupling, rawCouplingMeta]);

  const byMarkFilter = useMemo<ImageEntry[]>(() => {
    return baseEntries.filter((e) => {
      const m = marks[e.name] ?? EMPTY_MARK;
      if (flaggedOnly && !m.flag) return false;
      return m.rating >= minRating;
    });
  }, [baseEntries, marks, minRating, flaggedOnly]);

  const dateBuckets = useMemo(() => {
    const buckets = new Map<string, { count: number; preview: ImageEntry }>();
    for (const entry of byMarkFilter) {
      const ts = timestampForFilter(entry);
      if (ts == null) continue;
      const key = dayKeyFromTimestamp(ts);
      const prev = buckets.get(key);
      if (prev) prev.count += 1;
      else buckets.set(key, { count: 1, preview: entry });
    }
    return buckets;
  }, [byMarkFilter]);

  const dayRows = useMemo(
    () =>
      Array.from(dateBuckets.entries())
        .map(([day, data]) => ({ day, ...data }))
        .sort((a, b) => b.day.localeCompare(a.day)),
    [dateBuckets],
  );

  // The photos actually shown — the grid and the lightbox both navigate this list,
  // so `openIndex` always indexes the filtered set.
  const visible = useMemo<ImageEntry[]>(() => {
    const filtered = selectedDay
      ? byMarkFilter.filter((entry) => {
          const ts = timestampForFilter(entry);
          return ts != null && dayKeyFromTimestamp(ts) === selectedDay;
        })
      : byMarkFilter;
    if (filtered.length <= 1) return filtered;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sortMode === "shotDesc" || sortMode === "shotAsc") {
        const aShot = shotDateByPath[a.path] ?? -1;
        const bShot = shotDateByPath[b.path] ?? -1;
        if (sortMode === "shotDesc") {
          return bShot - aShot || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        }
        return aShot - bShot || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      if (sortMode === "nameAsc") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (sortMode === "nameDesc") return b.name.localeCompare(a.name, undefined, { sensitivity: "base" });
      const aCreated = a.created ?? -1;
      const bCreated = b.created ?? -1;
      if (sortMode === "createdDesc") {
        return bCreated - aCreated || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      }
      return aCreated - bCreated || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return sorted;
  }, [byMarkFilter, selectedDay, sortMode, shotDateByPath]);

  // Filtering can drastically shrink the list; with window-scroll virtualization,
  // keeping an old deep scroll offset may leave the viewport beyond the new data.
  // Reset to top whenever the filter state changes.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [minRating, flaggedOnly, selectedDay, sortMode, viewMode, rawCoupling]);

  useEffect(() => {
    if (!browseMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (browseMenuRef.current && !browseMenuRef.current.contains(e.target as Node)) {
        setBrowseMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [browseMenuOpen]);

  useEffect(() => {
    if (!actionMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(e.target as Node)) {
        setActionMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [actionMenuOpen]);

  useEffect(() => {
    if (!dateDrawerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (dateDrawerRef.current && !dateDrawerRef.current.contains(e.target as Node)) {
        setDateDrawerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDateDrawerOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [dateDrawerOpen]);

  // Once the directory's entries are in, jump to the OS-opened file — exactly once
  // per requested file. Clears any active filter first so the file always shows.
  useEffect(() => {
    if (!initialFile || !entries) return;
    if (openedFileRef.current === initialFile) return;
    if (minRating > 0 || flaggedOnly || selectedDay) {
      setMinRating(0);
      setFlaggedOnly(false);
      setSelectedDay(null);
      return;
    }
    openedFileRef.current = initialFile;
    const i = visible.findIndex((e) => e.name === initialFile);
    if (i >= 0) {
      setOpenIndex(i);
      return;
    }
    if (rawCoupling) {
      const key = stemKey(initialFile);
      const paired = visible.findIndex((e) => stemKey(e.name) === key);
      if (paired >= 0) setOpenIndex(paired);
    }
  }, [initialFile, entries, visible, minRating, flaggedOnly, selectedDay, rawCoupling]);

  const context = useMemo<TileContext>(
    () => ({ onOpen: (i) => setOpenIndex(i), mode: viewMode === "grid" ? "grid" : "masonry" }),
    [viewMode],
  );

  // Latest visible list, so back-to-back removals (fired from async callbacks) never
  // operate on a stale list and resurrect an already-removed photo.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // A photo left this folder (moved or deleted): drop its tile and keep the lightbox
  // on whatever slides into its place (closing if nothing visible is left).
  function handleRemoved(paths: string[]) {
    const removed = new Set(paths);
    const full = entriesRef.current;
    if (full) {
      const remaining = full.filter((e) => !removed.has(e.path));
      entriesRef.current = remaining;
      setEntries(remaining);
    }
    const vis = visibleRef.current;
    setOpenIndex((idx) => {
      if (idx === null) return idx;
      const current = vis[idx];
      const remainingVisible = vis.filter((e) => !removed.has(e.path));
      if (remainingVisible.length === 0) return null;
      if (current && removed.has(current.path)) return Math.min(idx, remainingVisible.length - 1);
      const removedBefore = vis.slice(0, idx).reduce((n, e) => n + (removed.has(e.path) ? 1 : 0), 0);
      return Math.max(0, idx - removedBefore);
    });
  }

  // Re-read marks after culling in the lightbox so the filters reflect new ratings/flags.
  function closeLightbox() {
    setOpenIndex(null);
    getMarks(dir).then(setMarks, () => {});
  }

  function handleEntryUpdated(path: string, modified: number | null) {
    setEntries((prev) => {
      if (!prev) return prev;
      const next = prev.map((e) => (e.path === path ? { ...e, modified } : e));
      entriesRef.current = next;
      return next;
    });
  }

  const monthStartDate = monthStart(calendarMonth);
  const monthStartWeekday = monthStartDate.getDay();
  const monthDays = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0).getDate();
  const selectedDayMonthKey = selectedDay ? monthKey(dateFromDayKey(selectedDay)) : null;

  function jumpMonth(delta: number) {
    setCalendarMonth((prev) => monthStart(new Date(prev.getFullYear(), prev.getMonth() + delta, 1)));
  }

  function pickDay(day: string) {
    setSelectedDay(day);
    setBrowseMenuOpen(false);
  }

  function showNotice(text: string) {
    setGalleryNotice({ id: Date.now(), text });
  }

  async function runBulkAction(kind: "flags" | "stars" | "write") {
    if (busyAction) return;
    setBusyAction(kind);
    try {
      if (kind === "flags") {
        const changed = await clearFlags(dir);
        const fresh = await getMarks(dir);
        setMarks(fresh);
        showNotice(`Removed flags from ${changed} photo${changed === 1 ? "" : "s"}`);
      } else if (kind === "stars") {
        const changed = await clearStars(dir);
        const fresh = await getMarks(dir);
        setMarks(fresh);
        showNotice(`Removed stars from ${changed} photo${changed === 1 ? "" : "s"}`);
      } else {
        const summary = await writeStarsToExif(dir);
        showNotice(
          `EXIF written: ${summary.written}, skipped: ${summary.skipped}, failed: ${summary.failed}`,
        );
      }
      setActionMenuOpen(false);
    } catch (e) {
      showNotice(`Action failed: ${String(e)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="ph-gallery">
      {galleryNotice && (
        <div className="ph-gallery-notice" key={galleryNotice.id}>
          {galleryNotice.text}
        </div>
      )}
      <header className="ph-gallery-head">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} title="Back">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="ph-gallery-title">
          <span className="ph-gallery-name" title={dir}>
            {dirName(dir)}
          </span>
          {entries ? (
            <span className="ph-gallery-count">
              {filtersActive
                ? `${visible.length} of ${baseEntries.length}`
                : `${baseEntries.length} photo${baseEntries.length === 1 ? "" : "s"}`}
            </span>
          ) : error ? null : (
            <span className="ph-gallery-count ph-gallery-loading">Reading folder…</span>
          )}
        </div>

        {entries && entries.length > 0 && (
          <div className="ph-gallery-controls">
            <div className="ph-gallery-filters">
              <div className="ph-filter-stars" role="group" aria-label="Filter by minimum rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`ph-filter-star${minRating >= n ? " ph-filter-star-on" : ""}`}
                    onClick={() => setMinRating((cur) => (cur === n ? 0 : n))}
                    title={`Show ${n}+ stars`}
                    aria-pressed={minRating >= n}
                  >
                    <Star className="h-4 w-4" />
                  </button>
                ))}
              </div>
              <button
                type="button"
                className={`ph-filter-flag${flaggedOnly ? " ph-filter-flag-on" : ""}`}
                onClick={() => setFlaggedOnly((v) => !v)}
                title="Show flagged only"
                aria-pressed={flaggedOnly}
              >
                <Flag className="h-4 w-4" />
              </button>
            </div>
            <div className="ph-browse-menu-wrap" ref={browseMenuRef}>
              <button
                type="button"
                className="ph-browse-menu-button"
                onClick={() => setBrowseMenuOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={browseMenuOpen}
                title="View and sorting options"
              >
                <SlidersHorizontal className="h-4 w-4" />
                <span>View/Sort</span>
              </button>
              {browseMenuOpen && (
                <div className="ph-browse-menu" role="menu" aria-label="View and sorting options">
                  <div className="ph-browse-menu-title">View mode</div>
                  {(["masonry", "grid", "list"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`ph-browse-menu-item${viewMode === mode ? " ph-browse-menu-item-on" : ""}`}
                      onClick={() => {
                        setViewMode(mode);
                        setBrowseMenuOpen(false);
                      }}
                      role="menuitemradio"
                      aria-checked={viewMode === mode}
                    >
                      {mode === "masonry" ? "Masonry" : mode === "grid" ? "Square grid" : "List details"}
                    </button>
                  ))}
                  <div className="ph-browse-menu-sep" />
                  <div className="ph-browse-menu-title">Raw coupling</div>
                  <button
                    type="button"
                    className={`ph-browse-menu-item${rawCoupling ? " ph-browse-menu-item-on" : ""}`}
                    onClick={() => setRawCoupling((v) => !v)}
                    role="menuitemcheckbox"
                    aria-checked={rawCoupling}
                    title={
                      enableRawCouplingDetection
                        ? "Manual toggle (auto-detection is enabled in Settings)"
                        : "Manual toggle (auto-detection disabled in Settings)"
                    }
                  >
                    {rawCoupling ? "On (JPEG shown, actions on RAW+JPEG)" : "Off"}
                  </button>
                  <div className="ph-browse-menu-sep" />
                  <div className="ph-browse-menu-title">Sort by</div>
                  {(Object.keys(SORT_LABEL) as SortMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      className={`ph-browse-menu-item${sortMode === mode ? " ph-browse-menu-item-on" : ""}`}
                      onClick={() => {
                        setSortMode(mode);
                        setBrowseMenuOpen(false);
                      }}
                      role="menuitemradio"
                      aria-checked={sortMode === mode}
                    >
                      {SORT_LABEL[mode]}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className={`ph-date-filter-button${selectedDay ? " ph-date-filter-button-on" : ""}`}
              onClick={() => {
                setActionMenuOpen(false);
                setBrowseMenuOpen(false);
                setDateDrawerOpen(true);
                if (selectedDay && selectedDayMonthKey) {
                  setCalendarMonth(monthStart(dateFromDayKey(selectedDay)));
                }
              }}
              title="Open date filter"
            >
              <CalendarDays className="h-4 w-4" />
              <span>Date</span>
            </button>
            <div className="ph-browse-menu-wrap" ref={actionMenuRef}>
              <button
                type="button"
                className="ph-browse-menu-button"
                onClick={() => {
                  setBrowseMenuOpen(false);
                  setActionMenuOpen((v) => !v);
                }}
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
                title="More actions"
              >
                <Ellipsis className="h-4 w-4" />
              </button>
              {actionMenuOpen && (
                <div className="ph-browse-menu" role="menu" aria-label="More actions">
                  <button
                    type="button"
                    className="ph-browse-menu-item"
                    onClick={() => runBulkAction("flags")}
                    disabled={busyAction !== null}
                  >
                    Remove flags
                  </button>
                  <button
                    type="button"
                    className="ph-browse-menu-item"
                    onClick={() => runBulkAction("stars")}
                    disabled={busyAction !== null}
                  >
                    Remove stars
                  </button>
                  <button
                    type="button"
                    className="ph-browse-menu-item"
                    onClick={() => runBulkAction("write")}
                    disabled={busyAction !== null}
                  >
                    Write stars into EXIF
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {error ? (
        <div className="ph-gallery-message">
          <ImageOff className="h-5 w-5" />
          <span>Could not read this folder.</span>
        </div>
      ) : entries === null ? (
        <GallerySkeleton columnCount={columnCount} />
      ) : entries.length === 0 ? (
        <div className="ph-gallery-message">
          <ImageOff className="h-5 w-5" />
          <span>No supported photos in this folder.</span>
        </div>
      ) : visible.length === 0 ? (
        <div className="ph-gallery-message">
          <ImageOff className="h-5 w-5" />
          <span>No photos match the filter.</span>
        </div>
      ) : viewMode === "list" ? (
        <ul className="ph-gallery-list">
          {visible.map((entry, i) => (
            <li key={entry.path} className="ph-gallery-list-item">
              <button
                type="button"
                className="ph-gallery-list-row"
                onClick={() => setOpenIndex(i)}
                title={entry.name}
              >
                <img
                  src={thumbUrl(entry, 128)}
                  alt={entry.name}
                  className="ph-gallery-list-thumb"
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                />
                <span className="ph-gallery-list-text">
                  <span className="ph-gallery-list-name">{entry.name}</span>
                  <span className="ph-gallery-list-date">{formatCreated(entry)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <VirtuosoMasonry
          key={`${dir}:${viewMode}:${sortMode}:${rawCoupling ? "coupled" : "plain"}:${minRating}:${flaggedOnly ? "flagged" : "all"}`}
          useWindowScroll
          columnCount={columnCount}
          data={visible}
          context={context}
          ItemContent={TileItem}
          className="ph-masonry"
        />
      )}

      {dateDrawerOpen && (
        <div className="ph-date-drawer-backdrop">
          <aside className="ph-date-drawer" ref={dateDrawerRef}>
            <div className="ph-date-drawer-head">
              <div className="ph-date-drawer-title-wrap">
                <span className="ph-date-drawer-title">Date filter</span>
                <span className="ph-date-drawer-subtitle">
                  {selectedDay ? DAY_LABEL_FORMAT.format(dateFromDayKey(selectedDay)) : "All dates"}
                </span>
              </div>
              <button
                type="button"
                className="ph-date-drawer-close"
                onClick={() => setDateDrawerOpen(false)}
                title="Close date filter"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {selectedDay && (
              <button
                type="button"
                className="ph-date-drawer-clear"
                onClick={() => setSelectedDay(null)}
                title="Clear selected date"
              >
                Clear date
              </button>
            )}

            <section className="ph-date-calendar">
              <div className="ph-date-calendar-head">
                <button type="button" className="ph-date-calendar-nav" onClick={() => jumpMonth(-1)} title="Previous month">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="ph-date-calendar-month">{MONTH_LABEL_FORMAT.format(monthStartDate)}</span>
                <button type="button" className="ph-date-calendar-nav" onClick={() => jumpMonth(1)} title="Next month">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="ph-date-calendar-grid">
                {WEEKDAY_LABELS.map((label) => (
                  <div key={label} className="ph-date-calendar-weekday">
                    {label}
                  </div>
                ))}
                {Array.from({ length: monthStartWeekday }, (_, i) => (
                  <div key={`empty-${i}`} />
                ))}
                {Array.from({ length: monthDays }, (_, i) => {
                  const dayNumber = i + 1;
                  const day = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth(), dayNumber);
                  const dayKey = dayKeyFromTimestamp(day.getTime());
                  const count = dateBuckets.get(dayKey)?.count ?? 0;
                  const isSelected = selectedDay === dayKey;
                  return (
                    <button
                      key={dayKey}
                      type="button"
                      className={`ph-date-day${count > 0 ? " ph-date-day-has" : ""}${isSelected ? " ph-date-day-on" : ""}`}
                      disabled={count === 0}
                      onClick={() => pickDay(dayKey)}
                      title={count > 0 ? `${count} photo${count === 1 ? "" : "s"}` : "No photos"}
                    >
                      <span className="ph-date-day-number">{dayNumber}</span>
                      {count > 0 && <span className="ph-date-day-count">{count}</span>}
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="ph-date-day-list">
              <div className="ph-date-day-list-title">Photo days</div>
              {dayRows.length === 0 ? (
                <div className="ph-date-day-empty">No dated photos in this folder.</div>
              ) : (
                <ul className="ph-date-day-items">
                  {dayRows.map((row) => (
                    <li key={row.day}>
                      <button
                        type="button"
                        className={`ph-date-day-row${selectedDay === row.day ? " ph-date-day-row-on" : ""}`}
                        onClick={() => {
                          pickDay(row.day);
                          setCalendarMonth(monthStart(dateFromDayKey(row.day)));
                        }}
                        title={`${row.count} photo${row.count === 1 ? "" : "s"}`}
                      >
                        <img
                          src={thumbUrl(row.preview, 96)}
                          alt={row.preview.name}
                          className="ph-date-day-row-thumb"
                          loading="lazy"
                          decoding="async"
                          draggable={false}
                        />
                        <span className="ph-date-day-row-text">
                          <span className="ph-date-day-row-date">{DAY_LABEL_FORMAT.format(dateFromDayKey(row.day))}</span>
                          <span className="ph-date-day-row-count">
                            {row.count} photo{row.count === 1 ? "" : "s"}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>
      )}

      {openIndex !== null && visible[openIndex] && (
        <Lightbox
          dir={dir}
          entries={visible}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={closeLightbox}
          onRemoved={handleRemoved}
          onEntryUpdated={handleEntryUpdated}
          actionPathsByPath={rawCoupling ? rawCouplingMeta.actionPathsByPath : {}}
        />
      )}
    </div>
  );
}
