import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtuosoMasonry } from "@virtuoso.dev/masonry";
import { ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight, ChevronDown, Ellipsis, Flag, ImageOff, SlidersHorizontal, SquareCheck, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listImages, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import {
  listDirectories,
  PREVIEW_RECURSION_LIMIT,
  type BrowserItem,
  type DirectoryEntry,
  itemPath,
  isPhotoItem,
} from "@/lib/browse";
import { type Config } from "@/lib/config";
import { EMPTY_MARK, clearFlags, clearStars, getMarks, writeStarsToExif, type Mark } from "@/lib/marks";
import { BrowserTile, type BrowserTileContext } from "./BrowserTile";
import { DirectoryListRow } from "./DirectoryTile";
import { Lightbox } from "./Lightbox";
import { GallerySelectionBar } from "./GallerySelectionBar";
import { LightboxCloseFlight } from "./LightboxCloseFlight";
import { findPhotoElement, photoPathAttr, scrollToPhoto } from "@/lib/photoScroll";

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

const TileItem = BrowserTile;
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
  onRemoveUnreachable,
}: {
  dir: string;
  /** File name to pop into the lightbox once this directory loads (an "Open with"
   *  / file-association launch); ignored thereafter. */
  initialFile?: string;
  onBack: () => void;
  /** Called to drop this unreachable folder from Last Locations and return to the menu. */
  onRemoveUnreachable?: () => void | Promise<void>;
}) {
  const columnCount = useColumnCount();
  const [browseStack, setBrowseStack] = useState<string[]>(() => [dir]);
  const currentDir = browseStack[browseStack.length - 1] ?? dir;
  const browseDepth = browseStack.length - 1;
  const previewDepth = Math.max(0, PREVIEW_RECURSION_LIMIT - browseDepth);
  const [directories, setDirectories] = useState<DirectoryEntry[] | null>(null);
  const [entries, setEntries] = useState<ImageEntry[] | null>(null);
  const [unreadable, setUnreadable] = useState(false);
  const [removingUnreachable, setRemovingUnreachable] = useState(false);
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
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set());
  const [selectionMenuOpen, setSelectionMenuOpen] = useState(false);
  const [ghostPath, setGhostPath] = useState<string | null>(null);
  const [closeFlight, setCloseFlight] = useState<{
    fromRect: DOMRect;
    toRect: DOMRect;
    imageSrc: string;
    path: string;
  } | null>(null);
  const browseMenuRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const dateDrawerRef = useRef<HTMLDivElement | null>(null);
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  // Which `initialFile` we've already auto-opened, so later list changes (e.g. a
  // move/delete dropping a tile) never yank the lightbox back to the opened photo.
  const openedFileRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    setBrowseStack([dir]);
  }, [dir]);

  useEffect(() => {
    let alive = true;
    setDirectories(null);
    setEntries(null);
    setUnreadable(false);
    setRemovingUnreachable(false);
    setOpenIndex(null);
    setActionMenuOpen(false);
    setBrowseMenuOpen(false);
    setDateDrawerOpen(false);
    setSelectedDay(null);
    setCalendarMonth(monthStart(new Date()));
    setSelectionMode(false);
    setSelectedPaths(new Set());
    setSelectionMenuOpen(false);
    setGhostPath(null);
    setCloseFlight(null);
    setMarks({});
    setShotDateByPath({});
    setShotDateKeyLoaded(null);
    openedFileRef.current = undefined;
    Promise.all([
      listImages(currentDir),
      listDirectories(currentDir),
      invoke<Config>("get_config").catch(() => ({ enableRawCouplingDetection: true } as Config)),
    ]).then(
      ([list, dirs, cfg]) => {
        if (!alive) return;
        const detectionEnabled = cfg.enableRawCouplingDetection;
        setEnableRawCouplingDetection(detectionEnabled);
        setDirectories(dirs);
        setEntries(list);
        const autoEnabled = detectionEnabled && detectRawCouplingBySample(list);
        setRawCoupling(autoEnabled);
        if (autoEnabled) setGalleryNotice({ id: Date.now(), text: "Raw coupling enabled" });
      },
      () => {
        if (alive) setUnreadable(true);
      },
    );
    getMarks(currentDir).then(
      (m) => alive && setMarks(m),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [currentDir]);

  useEffect(() => {
    if (!galleryNotice) return;
    const t = setTimeout(() => setGalleryNotice(null), 2600);
    return () => clearTimeout(t);
  }, [galleryNotice]);

  const shotSort = sortMode === "shotDesc" || sortMode === "shotAsc";
  const shotDateLoadKey = `${currentDir}:${rawCoupling ? "coupled" : "plain"}`;
  useEffect(() => {
    if (!shotSort) return;
    if (shotDateKeyLoaded === shotDateLoadKey) return;
    let alive = true;
    invoke<Record<string, number>>("list_shot_dates", { dir: currentDir, rawCoupling }).then(
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
  }, [currentDir, rawCoupling, shotSort, shotDateKeyLoaded, shotDateLoadKey]);

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
  // so `openIndex` always indexes the filtered photo set (directories are separate).
  const visiblePhotos = useMemo<ImageEntry[]>(() => {
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

  const visibleDirectories = useMemo<DirectoryEntry[]>(() => {
    if (!directories) return [];
    const sorted = [...directories];
    sorted.sort((a, b) => {
      if (sortMode === "nameDesc") {
        return b.name.localeCompare(a.name, undefined, { sensitivity: "base" });
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return sorted;
  }, [directories, sortMode]);

  const visibleItems = useMemo<BrowserItem[]>(() => {
    const items: BrowserItem[] = visibleDirectories.map((d) => ({
      kind: "directory",
      path: d.path,
      name: d.name,
    }));
    for (const entry of visiblePhotos) {
      items.push({ kind: "photo", entry });
    }
    return items;
  }, [visibleDirectories, visiblePhotos]);

  const photoIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    visiblePhotos.forEach((entry, i) => map.set(entry.path, i));
    return map;
  }, [visiblePhotos]);

  // Filtering can drastically shrink the list; with window-scroll virtualization,
  // keeping an old deep scroll offset may leave the viewport beyond the new data.
  // Reset to top whenever the filter state changes.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [minRating, flaggedOnly, selectedDay, sortMode, viewMode, rawCoupling, currentDir]);

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

  useEffect(() => {
    if (!selectionMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (selectionMenuRef.current && !selectionMenuRef.current.contains(e.target as Node)) {
        setSelectionMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [selectionMenuOpen]);

  // Drop selections that are no longer visible after filter/sort changes.
  useEffect(() => {
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      const visiblePaths = new Set(visibleItems.map(itemPath));
      let changed = false;
      const next = new Set<string>();
      for (const path of prev) {
        if (visiblePaths.has(path)) next.add(path);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [visibleItems]);
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
    const i = visiblePhotos.findIndex((e) => e.name === initialFile);
    if (i >= 0) {
      setOpenIndex(i);
      return;
    }
    if (rawCoupling) {
      const key = stemKey(initialFile);
      const paired = visiblePhotos.findIndex((e) => stemKey(e.name) === key);
      if (paired >= 0) setOpenIndex(paired);
    }
  }, [initialFile, entries, visiblePhotos, minRating, flaggedOnly, selectedDay, rawCoupling]);

  function openDirectory(path: string) {
    setOpenIndex(null);
    setBrowseStack((prev) => [...prev, path]);
  }

  function goUpOneDirectory() {
    setOpenIndex(null);
    setBrowseStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  function handleHeadBack() {
    if (browseDepth > 0) goUpOneDirectory();
    else onBack();
  }

  const context = useMemo<BrowserTileContext>(
    () => ({
      onOpen: (i) => setOpenIndex(i),
      mode: viewMode === "grid" ? "grid" : "masonry",
      selectionMode,
      selectedPaths,
      ghostPath,
      previewDepth,
      onToggleSelect: (path) => {
        setSelectedPaths((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
      },
      photoIndexForPath: (path) => photoIndexByPath.get(path) ?? -1,
      onOpenDirectory: openDirectory,
    }),
    [viewMode, selectionMode, selectedPaths, ghostPath, visiblePhotos, previewDepth, photoIndexByPath],
  );

  const selectedItems = useMemo(
    () => visibleItems.filter((item) => selectedPaths.has(itemPath(item))),
    [visibleItems, selectedPaths],
  );
  const hasSelection = selectedItems.length > 0;

  function enterSelectionMode() {
    setSelectionMode(true);
    setOpenIndex(null);
  }

  function clearSelection() {
    setSelectedPaths(new Set());
    setSelectionMode(false);
    setSelectionMenuOpen(false);
  }

  function toggleSelectionMode() {
    if (selectionMode || hasSelection) clearSelection();
    else enterSelectionMode();
  }

  function selectAllVisible() {
    setSelectionMode(true);
    setSelectedPaths(new Set(visibleItems.map(itemPath)));
    setSelectionMenuOpen(false);
  }

  function selectNone() {
    setSelectedPaths(new Set());
    setSelectionMenuOpen(false);
  }

  function invertSelection() {
    setSelectionMode(true);
    setSelectedPaths((prev) => {
      const next = new Set<string>();
      for (const item of visibleItems) {
        const path = itemPath(item);
        if (!prev.has(path)) next.add(path);
      }
      return next;
    });
    setSelectionMenuOpen(false);
  }

  function selectByFlag(flagged: boolean) {
    setSelectionMode(true);
    setSelectedPaths(
      new Set(
        visiblePhotos
          .filter((e) => (marks[e.name] ?? EMPTY_MARK).flag === flagged)
          .map((e) => e.path),
      ),
    );
    setSelectionMenuOpen(false);
  }

  function toggleListSelection(path: string) {
    if (!selectionMode && !selectedPaths.has(path)) enterSelectionMode();
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleSelectedPath(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  // Latest visible list, so back-to-back removals (fired from async callbacks) never
  // operate on a stale list and resurrect an already-removed photo.
  const visiblePhotosRef = useRef(visiblePhotos);
  visiblePhotosRef.current = visiblePhotos;
  const visibleItemsRef = useRef(visibleItems);
  visibleItemsRef.current = visibleItems;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  // A photo left this folder (moved or deleted): drop its tile and keep the lightbox
  // on whatever slides into its place (closing if nothing visible is left).
  function handleRemoved(paths: string[]) {
    const removed = new Set(paths);
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      for (const path of prev) {
        if (removed.has(path)) changed = true;
        else next.add(path);
      }
      return changed ? next : prev;
    });
    const full = entriesRef.current;
    if (full) {
      const remaining = full.filter((e) => !removed.has(e.path));
      entriesRef.current = remaining;
      setEntries(remaining);
    }
    setDirectories((prev) => {
      if (!prev) return prev;
      const remaining = prev.filter((d) => !removed.has(d.path));
      return remaining.length === prev.length ? prev : remaining;
    });
    const vis = visiblePhotosRef.current;
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
    getMarks(currentDir).then(setMarks, () => {});
  }

  const animateCloseLightbox = useCallback(
    async (info: {
      path: string;
      index: number;
      getSourceRect: () => DOMRect | null;
      imageSrc: string;
    }) => {
      const { path, index, getSourceRect, imageSrc } = info;
      const total = visiblePhotosRef.current.length;

      setGhostPath(path);
      await scrollToPhoto(path, index, total);

      const targetRect = findPhotoElement(path)?.getBoundingClientRect() ?? null;
      const sourceRect = getSourceRect();

      if (!targetRect || !sourceRect) {
        setGhostPath(null);
        closeLightbox();
        return;
      }

      setCloseFlight({ fromRect: sourceRect, toRect: targetRect, imageSrc, path });
      setOpenIndex(null);
    },
    [dir],
  );

  function finishCloseFlight() {
    setCloseFlight(null);
    setGhostPath(null);
    getMarks(currentDir).then(setMarks, () => {});
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
        const changed = await clearFlags(currentDir);
        const fresh = await getMarks(currentDir);
        setMarks(fresh);
        showNotice(`Removed flags from ${changed} photo${changed === 1 ? "" : "s"}`);
      } else if (kind === "stars") {
        const changed = await clearStars(currentDir);
        const fresh = await getMarks(currentDir);
        setMarks(fresh);
        showNotice(`Removed stars from ${changed} photo${changed === 1 ? "" : "s"}`);
      } else {
        const summary = await writeStarsToExif(currentDir);
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

  const listingLoaded = entries !== null && directories !== null;
  const folderCount = directories?.length ?? 0;
  const hasBrowsableContent = listingLoaded && (folderCount > 0 || baseEntries.length > 0);

  return (
    <div className={`ph-gallery${hasSelection ? " ph-gallery-has-selection" : ""}`}>
      {galleryNotice && (
        <div className="ph-gallery-notice" key={galleryNotice.id}>
          {galleryNotice.text}
        </div>
      )}
      <header className="ph-gallery-head">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleHeadBack}
          title={browseDepth > 0 ? "Back to parent folder" : "Back to menu"}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="ph-gallery-title">
          <span className="ph-gallery-name" title={currentDir}>
            {dirName(currentDir)}
          </span>
          {listingLoaded ? (
            <span className="ph-gallery-count">
              {filtersActive
                ? `${visiblePhotos.length} of ${baseEntries.length} photo${baseEntries.length === 1 ? "" : "s"}`
                : [
                    folderCount > 0 ? `${folderCount} folder${folderCount === 1 ? "" : "s"}` : null,
                    `${baseEntries.length} photo${baseEntries.length === 1 ? "" : "s"}`,
                  ]
                    .filter(Boolean)
                    .join(", ")}
            </span>
          ) : unreadable ? null : (
            <span className="ph-gallery-count ph-gallery-loading">Reading folder…</span>
          )}
        </div>

        {hasBrowsableContent && (
          <div className="ph-gallery-controls">
            <div className="ph-gallery-select-wrap" ref={selectionMenuRef}>
              <button
                type="button"
                className={`ph-select-toggle${selectionMode || hasSelection ? " ph-select-toggle-on" : ""}`}
                onClick={toggleSelectionMode}
                title={selectionMode || hasSelection ? "Exit selection" : "Select photos"}
                aria-pressed={selectionMode || hasSelection}
              >
                <SquareCheck className="h-4 w-4" />
                <span className="ph-select-toggle-label">Select</span>
              </button>
              {(selectionMode || hasSelection) && (
                <>
                  <button
                    type="button"
                    className="ph-select-menu-button"
                    onClick={() => {
                      setBrowseMenuOpen(false);
                      setActionMenuOpen(false);
                      setSelectionMenuOpen((v) => !v);
                    }}
                    aria-haspopup="menu"
                    aria-expanded={selectionMenuOpen}
                    title="Selection options"
                  >
                    <span className="ph-select-menu-count">
                      {hasSelection ? `${selectedItems.length} selected` : "Selection"}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </button>
                  {selectionMenuOpen && (
                    <div className="ph-browse-menu ph-select-menu" role="menu" aria-label="Selection options">
                      <button type="button" className="ph-browse-menu-item" onClick={selectAllVisible} role="menuitem">
                        Select all
                      </button>
                      <button type="button" className="ph-browse-menu-item" onClick={selectNone} role="menuitem">
                        Select none
                      </button>
                      <button type="button" className="ph-browse-menu-item" onClick={invertSelection} role="menuitem">
                        Invert selection
                      </button>
                      <div className="ph-browse-menu-sep" />
                      <button type="button" className="ph-browse-menu-item" onClick={() => selectByFlag(true)} role="menuitem">
                        Select flagged
                      </button>
                      <button type="button" className="ph-browse-menu-item" onClick={() => selectByFlag(false)} role="menuitem">
                        Select unflagged
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
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

      {unreadable ? (
        <div className="ph-gallery-message ph-gallery-unreadable">
          <ImageOff className="h-5 w-5 shrink-0" />
          <div className="ph-gallery-unreadable-body">
            <p>This folder could not be read.</p>
            <p className="ph-gallery-unreadable-q">Remove from Last Locations?</p>
            <div className="ph-gallery-unreadable-actions">
              <button
                type="button"
                className="ph-gallery-unreadable-remove"
                disabled={removingUnreachable || !onRemoveUnreachable}
                onClick={() => {
                  if (!onRemoveUnreachable) return;
                  setRemovingUnreachable(true);
                  void Promise.resolve(onRemoveUnreachable()).catch(() => setRemovingUnreachable(false));
                }}
              >
                <Check className="h-4 w-4" />
                <span>Remove</span>
              </button>
              <button type="button" className="ph-gallery-unreadable-keep" onClick={onBack}>
                <X className="h-4 w-4" />
                <span>Keep</span>
              </button>
            </div>
          </div>
        </div>
      ) : !listingLoaded ? (
        <GallerySkeleton columnCount={columnCount} />
      ) : !hasBrowsableContent ? (
        <div className="ph-gallery-message">
          <ImageOff className="h-5 w-5" />
          <span>No folders or supported photos here.</span>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="ph-gallery-message">
          <ImageOff className="h-5 w-5" />
          <span>No photos match the filter.</span>
        </div>
      ) : viewMode === "list" ? (
        <ul className="ph-gallery-list">
          {visibleItems.map((item) => {
            if (!isPhotoItem(item)) {
              const selected = selectedPaths.has(item.path);
              return (
                <li key={item.path} className="ph-gallery-list-item">
                  <DirectoryListRow
                    data={item}
                    previewDepth={previewDepth}
                    selectionMode={selectionMode}
                    selected={selected}
                    onOpen={openDirectory}
                    onToggleSelect={(path) => toggleListSelection(path)}
                  />
                </li>
              );
            }
            const entry = item.entry;
            const i = photoIndexByPath.get(entry.path) ?? -1;
            const selected = selectedPaths.has(entry.path);
            return (
              <li
                key={entry.path}
                className={`ph-gallery-list-item${selected ? " ph-gallery-list-item-selected" : ""}${ghostPath === entry.path ? " ph-gallery-list-item-ghost" : ""}`}
              >
                {selectionMode ? (
                  <div
                    className="ph-gallery-list-row"
                    data-photo-path={photoPathAttr(entry.path)}
                  >
                    <button
                      type="button"
                      className="ph-gallery-list-hit"
                      onClick={() => toggleListSelection(entry.path)}
                      title={entry.name}
                      aria-pressed={selected}
                    >
                      <span className={`ph-list-check${selected ? " ph-list-check-on" : ""}`} aria-hidden>
                        {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
                      </span>
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
                    <button
                      type="button"
                      className="ph-gallery-list-open"
                      onClick={() => setOpenIndex(i)}
                      title="Open fullscreen"
                    >
                      Open
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="ph-gallery-list-row"
                    data-photo-path={photoPathAttr(entry.path)}
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
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <VirtuosoMasonry
          key={`${currentDir}:${viewMode}:${sortMode}:${rawCoupling ? "coupled" : "plain"}:${minRating}:${flaggedOnly ? "flagged" : "all"}`}
          useWindowScroll
          columnCount={columnCount}
          data={visibleItems}
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

      {hasSelection && (
        <GallerySelectionBar
          dir={currentDir}
          selected={selectedItems}
          marks={marks}
          actionPathsByPath={rawCoupling ? rawCouplingMeta.actionPathsByPath : {}}
          onRemoved={handleRemoved}
          onEntryUpdated={handleEntryUpdated}
          onMarksChanged={setMarks}
          onDone={clearSelection}
          onNotice={showNotice}
        />
      )}

      {closeFlight && (
        <LightboxCloseFlight
          fromRect={closeFlight.fromRect}
          toRect={closeFlight.toRect}
          imageSrc={closeFlight.imageSrc}
          onComplete={finishCloseFlight}
        />
      )}

      {openIndex !== null && visiblePhotos[openIndex] && (
        <Lightbox
          dir={currentDir}
          entries={visiblePhotos}
          index={openIndex}
          onIndex={setOpenIndex}
          onClose={closeLightbox}
          onAnimateClose={animateCloseLightbox}
          onRemoved={handleRemoved}
          onEntryUpdated={handleEntryUpdated}
          actionPathsByPath={rawCoupling ? rawCouplingMeta.actionPathsByPath : {}}
          selectionMode={selectionMode}
          selectedPaths={selectedPaths}
          onToggleSelected={toggleSelectedPath}
        />
      )}
    </div>
  );
}
