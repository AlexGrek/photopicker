import { useEffect, useMemo, useRef, useState } from "react";
import { VirtuosoMasonry, type ItemContent } from "@virtuoso.dev/masonry";
import { ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Flag, ImageOff, SlidersHorizontal, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listImages, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { EMPTY_MARK, getMarks, type Mark } from "@/lib/marks";
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
type SortMode = "nameAsc" | "nameDesc" | "createdDesc" | "createdAsc";
const SORT_LABEL: Record<SortMode, string> = {
  nameAsc: "Name A-Z",
  nameDesc: "Name Z-A",
  createdDesc: "Created newest",
  createdAsc: "Created oldest",
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
  const [browseMenuOpen, setBrowseMenuOpen] = useState(false);
  const [dateDrawerOpen, setDateDrawerOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => monthStart(new Date()));
  const browseMenuRef = useRef<HTMLDivElement | null>(null);
  const dateDrawerRef = useRef<HTMLDivElement | null>(null);
  // Which `initialFile` we've already auto-opened, so later list changes (e.g. a
  // move/delete dropping a tile) never yank the lightbox back to the opened photo.
  const openedFileRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    setOpenIndex(null);
    setBrowseMenuOpen(false);
    setDateDrawerOpen(false);
    setSelectedDay(null);
    setCalendarMonth(monthStart(new Date()));
    setMarks({});
    openedFileRef.current = undefined;
    listImages(dir).then(
      (list) => {
        if (alive) setEntries(list);
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

  const filtersActive = minRating > 0 || flaggedOnly || selectedDay !== null;

  const byMarkFilter = useMemo<ImageEntry[]>(() => {
    if (!entries) return [];
    return entries.filter((e) => {
      const m = marks[e.name] ?? EMPTY_MARK;
      if (flaggedOnly && !m.flag) return false;
      return m.rating >= minRating;
    });
  }, [entries, marks, minRating, flaggedOnly]);

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
  }, [byMarkFilter, selectedDay, sortMode]);

  // Filtering can drastically shrink the list; with window-scroll virtualization,
  // keeping an old deep scroll offset may leave the viewport beyond the new data.
  // Reset to top whenever the filter state changes.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [minRating, flaggedOnly, selectedDay, sortMode, viewMode]);

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
    if (i >= 0) setOpenIndex(i);
  }, [initialFile, entries, visible, minRating, flaggedOnly, selectedDay]);

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
  function handleRemoved(path: string) {
    const full = entriesRef.current;
    if (full) {
      const remaining = full.filter((e) => e.path !== path);
      entriesRef.current = remaining;
      setEntries(remaining);
    }
    const vis = visibleRef.current;
    const removedIndex = vis.findIndex((e) => e.path === path);
    if (removedIndex === -1) return;
    const remainingVisible = vis.length - 1;
    setOpenIndex((idx) => {
      if (idx === null) return idx;
      if (remainingVisible <= 0) return null;
      const shifted = removedIndex < idx ? idx - 1 : idx;
      return Math.min(shifted, remainingVisible - 1);
    });
  }

  // Re-read marks after culling in the lightbox so the filters reflect new ratings/flags.
  function closeLightbox() {
    setOpenIndex(null);
    getMarks(dir).then(setMarks, () => {});
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

  return (
    <div className="ph-gallery">
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
                ? `${visible.length} of ${entries.length}`
                : `${entries.length} photo${entries.length === 1 ? "" : "s"}`}
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
          <span>No JPEG photos in this folder.</span>
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
          key={`${dir}:${viewMode}:${sortMode}:${minRating}:${flaggedOnly ? "flagged" : "all"}`}
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
        />
      )}
    </div>
  );
}
