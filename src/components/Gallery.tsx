import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { VirtuosoMasonry } from "@virtuoso.dev/masonry";
import { ArrowLeft, CalendarDays, Check, ChevronLeft, ChevronRight, ChevronDown, Ellipsis, Film, Flag, ImageOff, Play, SlidersHorizontal, SquareCheck, Star, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listImages, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import {
  invalidateDirectoryPreviews,
  listDirectories,
  PREVIEW_RECURSION_LIMIT,
  type BrowserItem,
  type DirectoryEntry,
  itemPath,
  isPhotoItem,
} from "@/lib/browse";
import { loadConfig, getConfig } from "@/lib/config";
import { EMPTY_MARK, clearFlags, clearStars, getMarks, writeStarsToExif, type Mark } from "@/lib/marks";
import { bucketByDay, dateFromDayKey, dayKeyForEntry, dayKeyFromTimestamp, DAY_LABEL_FORMAT, formatCreated, MONTH_LABEL_FORMAT, monthStart, WEEKDAY_LABELS } from "@/lib/dates";
import { buildRawCouplingMeta, detectRawCouplingBySample, stemKey } from "@/lib/rawCoupling";
import { isShotSort, SORT_LABEL, sortEntries, type SortMode } from "@/lib/sort";
import { useGamepad } from "@/lib/gamepad";
import { hasCommandModifier, useDismiss, useLatest, useWindowKeydown } from "@/lib/hooks";
import { baseName, compareNames, plural, toggleInSet } from "@/lib/utils";
import { BrowserTile, type BrowserTileContext } from "./BrowserTile";
import { VideoThumb } from "./VideoThumb";
import { DirectoryListRow } from "./DirectoryTile";
import { Lightbox } from "./Lightbox";
import { GallerySelectionBar } from "./GallerySelectionBar";
import { LightboxCloseFlight } from "./LightboxCloseFlight";
import { findPhotoElement, photoPathAttr, scrollToPhoto } from "@/lib/photoScroll";

/** Pick a column count that keeps tiles a comfortable size at any window width. */
function columnsForWidth(w: number): number {
  if (w < 480) return 2;
  if (w < 768) return 3;
  if (w < 1100) return 4;
  if (w < 1500) return 5;
  return 6;
}

function useColumnCount(): number {
  const [count, setCount] = useState(() => columnsForWidth(window.innerWidth));
  useEffect(() => {
    const calc = () => setCount(columnsForWidth(window.innerWidth));
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return count;
}

/** List-row thumbnail: a `thumb://` image for photos, a client poster + ▶ badge for videos. */
function ListThumb({ entry }: { entry: ImageEntry }) {
  if (entry.video) {
    return (
      <span className="ph-gallery-list-thumb ph-gallery-list-thumb-video">
        <VideoThumb entry={entry} className="ph-media-fill" />
        <span className="ph-tile-video-badge ph-video-badge-sm" aria-hidden>
          <Play className="h-3 w-3" fill="currentColor" />
        </span>
      </span>
    );
  }
  return (
    <img
      src={thumbUrl(entry, 128)}
      alt={entry.name}
      className="ph-gallery-list-thumb"
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}

type ViewMode = "masonry" | "grid" | "list";

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
  /** True while the selection bar has its own chooser / confirmation open (it then owns the keys and pad). */
  const [selectionBarModal, setSelectionBarModal] = useState(false);
  /** Photo paths successfully copied or moved during this gallery visit. */
  const [sessionSentPaths, setSessionSentPaths] = useState<Set<string>>(() => new Set());
  const [ghostPath, setGhostPath] = useState<string | null>(null);
  /** Item carrying the keyboard/gamepad focus ring (null until the user navigates). */
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
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
    setSessionSentPaths(new Set());
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
    setFocusedPath(null);
    setCloseFlight(null);
    setMarks({});
    setShotDateByPath({});
    setShotDateKeyLoaded(null);
    openedFileRef.current = undefined;
    Promise.all([
      listImages(currentDir),
      listDirectories(currentDir),
      loadConfig().catch(() => getConfig()),
    ]).then(
      ([list, dirs, cfg]) => {
        if (!alive) return;
        const detectionEnabled = cfg?.enableRawCouplingDetection ?? true;
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

  const shotSort = isShotSort(sortMode);
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

  const rawCouplingMeta = useMemo(() => buildRawCouplingMeta(entries), [entries]);

  const baseEntries = useMemo(() => {
    if (!entries) return [];
    if (!rawCoupling) return entries;
    return entries.filter((e) => !rawCouplingMeta.hiddenRawPaths.has(e.path));
  }, [entries, rawCoupling, rawCouplingMeta]);

  // Sorting is the expensive step and depends on neither the marks nor the filters,
  // so it runs first: rating or flagging a photo only re-filters, never re-sorts.
  const sortedBase = useMemo(
    () => sortEntries(baseEntries, sortMode, shotDateByPath),
    [baseEntries, sortMode, shotDateByPath],
  );

  const byMarkFilter = useMemo<ImageEntry[]>(() => {
    if (minRating === 0 && !flaggedOnly) return sortedBase;
    return sortedBase.filter((e) => {
      const m = marks[e.name] ?? EMPTY_MARK;
      if (flaggedOnly && !m.flag) return false;
      return m.rating >= minRating;
    });
  }, [sortedBase, marks, minRating, flaggedOnly]);

  const dateBuckets = useMemo(() => bucketByDay(byMarkFilter), [byMarkFilter]);

  const dayRows = useMemo(
    () =>
      Array.from(dateBuckets.entries())
        .map(([day, data]) => ({ day, ...data }))
        .sort((a, b) => b.day.localeCompare(a.day)),
    [dateBuckets],
  );

  // The photos actually shown — the grid and the lightbox both navigate this list,
  // so `openIndex` always indexes the filtered photo set (directories are separate).
  const visiblePhotos = useMemo<ImageEntry[]>(
    () => (selectedDay ? byMarkFilter.filter((e) => dayKeyForEntry(e) === selectedDay) : byMarkFilter),
    [byMarkFilter, selectedDay],
  );

  const visibleDirectories = useMemo<DirectoryEntry[]>(() => {
    if (!directories) return [];
    const dirSign = sortMode === "nameDesc" ? -1 : 1;
    return [...directories].sort((a, b) => dirSign * compareNames(a.name, b.name));
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

  // Position of every item in `visibleItems` (folders first), for focus movement.
  const itemIndexByPath = useMemo(() => {
    const map = new Map<string, number>();
    visibleItems.forEach((item, i) => map.set(itemPath(item), i));
    return map;
  }, [visibleItems]);

  // Latest values for callbacks that must keep a stable identity.
  const visiblePhotosRef = useLatest(visiblePhotos);
  const visibleItemsRef = useLatest(visibleItems);
  const photoIndexByPathRef = useLatest(photoIndexByPath);
  const itemIndexByPathRef = useLatest(itemIndexByPath);
  const currentDirRef = useLatest(currentDir);

  // Filtering can drastically shrink the list; with window-scroll virtualization,
  // keeping an old deep scroll offset may leave the viewport beyond the new data.
  // Reset to top whenever the filter state changes.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [minRating, flaggedOnly, selectedDay, sortMode, viewMode, rawCoupling, currentDir]);

  const closeBrowseMenu = useCallback(() => setBrowseMenuOpen(false), []);
  const closeActionMenu = useCallback(() => setActionMenuOpen(false), []);
  const closeDateDrawer = useCallback(() => setDateDrawerOpen(false), []);
  const closeSelectionMenu = useCallback(() => setSelectionMenuOpen(false), []);
  useDismiss(browseMenuRef, browseMenuOpen, closeBrowseMenu);
  useDismiss(actionMenuRef, actionMenuOpen, closeActionMenu);
  useDismiss(dateDrawerRef, dateDrawerOpen, closeDateDrawer);
  useDismiss(selectionMenuRef, selectionMenuOpen, closeSelectionMenu);

  // Drop selections (and focus) that are no longer visible after filter/sort changes.
  useEffect(() => {
    setSelectedPaths((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set<string>();
      for (const path of prev) if (itemIndexByPath.has(path)) next.add(path);
      return next.size === prev.size ? prev : next;
    });
    setFocusedPath((prev) => (prev !== null && !itemIndexByPath.has(prev) ? null : prev));
  }, [itemIndexByPath]);

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

  const openDirectory = useCallback((path: string) => {
    setOpenIndex(null);
    setFocusedPath(null);
    setBrowseStack((prev) => [...prev, path]);
  }, []);

  function goUpOneDirectory() {
    setOpenIndex(null);
    setBrowseStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  }

  function handleHeadBack() {
    if (browseDepth > 0) goUpOneDirectory();
    else onBack();
  }

  const openPhoto = useCallback(
    (path: string) => {
      const i = photoIndexByPathRef.current.get(path);
      if (i !== undefined) setOpenIndex(i);
    },
    [photoIndexByPathRef],
  );

  const toggleSelectedPath = useCallback((path: string) => {
    setSelectedPaths((prev) => toggleInSet(prev, path));
  }, []);

  const context = useMemo<BrowserTileContext>(
    () => ({
      mode: viewMode === "grid" ? "grid" : "masonry",
      selectionMode,
      selectedPaths,
      ghostPath,
      focusedPath,
      previewDepth,
      onOpenPhoto: openPhoto,
      onOpenDirectory: openDirectory,
      onToggleSelect: toggleSelectedPath,
    }),
    [viewMode, selectionMode, selectedPaths, ghostPath, focusedPath, previewDepth, openPhoto, openDirectory, toggleSelectedPath],
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

  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionMode(false);
    setSelectionMenuOpen(false);
    setSelectionBarModal(false);
  }, []);

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

  const noteSessionSent = useCallback((paths: string[]) => {
    setSessionSentPaths((prev) => {
      const next = new Set(prev);
      for (const path of paths) next.add(path);
      return next;
    });
  }, []);

  function selectSessionSent() {
    setSelectionMode(true);
    setSelectedPaths(
      new Set(visiblePhotos.filter((e) => sessionSentPaths.has(e.path)).map((e) => e.path)),
    );
    setSelectionMenuOpen(false);
  }

  function toggleListSelection(path: string) {
    if (!selectionMode && !selectedPaths.has(path)) enterSelectionMode();
    toggleSelectedPath(path);
  }

  // A photo left this folder (moved or deleted): drop its tile and keep the lightbox
  // on whatever slides into its place (closing if nothing visible is left).
  const handleRemoved = useCallback(
    (paths: string[]) => {
      const removed = new Set(paths);
      invalidateDirectoryPreviews(); // a cached folder preview may show a file that is gone
      setSelectedPaths((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set<string>();
        for (const path of prev) if (!removed.has(path)) next.add(path);
        return next.size === prev.size ? prev : next;
      });
      setEntries((prev) => (prev ? prev.filter((e) => !removed.has(e.path)) : prev));
      setDirectories((prev) => {
        if (!prev) return prev;
        const remaining = prev.filter((d) => !removed.has(d.path));
        return remaining.length === prev.length ? prev : remaining;
      });
      // Back-to-back removals fire from async callbacks; the ref always holds the
      // latest visible list, so a stale list can't resurrect an already-removed photo.
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
    },
    [visiblePhotosRef],
  );

  // Re-read marks after culling in the lightbox so the filters reflect new ratings/flags.
  const refreshMarks = useCallback(() => {
    const forDir = currentDirRef.current;
    getMarks(forDir).then(
      (m) => {
        // The user may have navigated to another folder while this was in flight.
        if (currentDirRef.current === forDir) setMarks(m);
      },
      () => {},
    );
  }, [currentDirRef]);

  const closeLightbox = useCallback(() => {
    setOpenIndex(null);
    refreshMarks();
  }, [refreshMarks]);

  const animateCloseLightbox = useCallback(
    async (info: {
      path: string;
      index: number;
      getSourceRect: () => DOMRect | null;
      imageSrc: string;
    }) => {
      const { path, getSourceRect, imageSrc } = info;
      // The tile's place among *all* grid items — folders come first, so the photo
      // index alone would aim the scroll estimate too high.
      const itemIndex = itemIndexByPathRef.current.get(path) ?? -1;
      const total = visibleItemsRef.current.length;

      setGhostPath(path);
      await scrollToPhoto(path, itemIndex, total);

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
    [closeLightbox, itemIndexByPathRef, visibleItemsRef],
  );

  function finishCloseFlight() {
    setCloseFlight(null);
    setGhostPath(null);
    refreshMarks();
  }

  const handleEntryUpdated = useCallback((path: string, modified: number | null) => {
    setEntries((prev) => (prev ? prev.map((e) => (e.path === path ? { ...e, modified } : e)) : prev));
  }, []);

  const monthStartDate = monthStart(calendarMonth);
  const monthStartWeekday = monthStartDate.getDay();
  const monthDays = new Date(monthStartDate.getFullYear(), monthStartDate.getMonth() + 1, 0).getDate();
  const selectedDayMonthKey = selectedDay ? selectedDay.slice(0, 7) : null;

  function jumpMonth(delta: number) {
    setCalendarMonth((prev) => monthStart(new Date(prev.getFullYear(), prev.getMonth() + delta, 1)));
  }

  function pickDay(day: string) {
    setSelectedDay(day);
    setBrowseMenuOpen(false);
  }

  const showNotice = useCallback((text: string) => {
    setGalleryNotice({ id: Date.now(), text });
  }, []);

  async function runBulkAction(kind: "flags" | "stars" | "write") {
    if (busyAction) return;
    setBusyAction(kind);
    try {
      if (kind === "flags") {
        const changed = await clearFlags(currentDir);
        setMarks(await getMarks(currentDir));
        showNotice(`Removed flags from ${plural(changed, "photo")}`);
      } else if (kind === "stars") {
        const changed = await clearStars(currentDir);
        setMarks(await getMarks(currentDir));
        showNotice(`Removed stars from ${plural(changed, "photo")}`);
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

  // ---- Keyboard / gamepad navigation of the grid ---------------------------
  // Active only while nothing covers the grid: not under the lightbox or the
  // close animation, not with a popover open, and not while the selection bar has
  // a chooser or confirmation up (it owns the keys and pad then).
  const navActive =
    openIndex === null &&
    closeFlight === null &&
    !dateDrawerOpen &&
    !browseMenuOpen &&
    !actionMenuOpen &&
    !selectionMenuOpen &&
    !selectionBarModal &&
    listingLoaded &&
    visibleItems.length > 0;

  function moveFocus(delta: number) {
    const items = visibleItemsRef.current;
    if (items.length === 0) return;
    const current = focusedPath !== null ? (itemIndexByPathRef.current.get(focusedPath) ?? -1) : -1;
    const next = current < 0 ? 0 : Math.min(items.length - 1, Math.max(0, current + delta));
    const path = itemPath(items[next]);
    setFocusedPath(path);
    void scrollToPhoto(path, next, items.length);
  }

  const rowStep = viewMode === "list" ? 1 : columnCount;

  /** Enter / A on the focused item: open the folder or photo (or toggle it in selection mode). */
  function activateFocused() {
    if (focusedPath === null) return moveFocus(0);
    const item = visibleItemsRef.current[itemIndexByPathRef.current.get(focusedPath) ?? -1];
    if (!item) return;
    if (selectionMode) toggleSelectedPath(focusedPath);
    else if (isPhotoItem(item)) openPhoto(focusedPath);
    else openDirectory(focusedPath);
  }

  useWindowKeydown((e) => {
    if (hasCommandModifier(e)) return;
    // Real controls (buttons, inputs) keep their own Enter/Space behaviour.
    const onControl = e.target instanceof HTMLElement && /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/.test(e.target.tagName);
    if (e.key === "ArrowLeft") moveFocus(-1);
    else if (e.key === "ArrowRight") moveFocus(1);
    else if (e.key === "ArrowUp") moveFocus(-rowStep);
    else if (e.key === "ArrowDown") moveFocus(rowStep);
    else if (e.key === "Enter" && !onControl) activateFocused();
    else if (e.key === " " && !onControl && focusedPath !== null) toggleSelectedPath(focusedPath);
    else if (e.key === "Escape") {
      if (hasSelection || selectionMode) clearSelection();
      else handleHeadBack();
    } else return;
    e.preventDefault();
  }, navActive);

  useGamepad((button) => {
    // With a selection, A/B belong to the selection bar (confirm / cancel); the
    // pad then only moves focus, and X toggles the focused item like in the lightbox.
    if (button === "left") moveFocus(-1);
    else if (button === "right") moveFocus(1);
    else if (button === "up") moveFocus(-rowStep);
    else if (button === "down") moveFocus(rowStep);
    else if (button === "x" && focusedPath !== null) toggleSelectedPath(focusedPath);
    else if (hasSelection) return;
    else if (button === "a") activateFocused();
    else if (button === "b") handleHeadBack();
  }, navActive);

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
            {baseName(currentDir)}
          </span>
          {listingLoaded ? (
            <span className="ph-gallery-count">
              {filtersActive
                ? `${visiblePhotos.length} of ${plural(baseEntries.length, "photo")}`
                : [
                    folderCount > 0 ? plural(folderCount, "folder") : null,
                    plural(baseEntries.length, "photo"),
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
                      <div className="ph-browse-menu-sep" />
                      <button
                        type="button"
                        className="ph-browse-menu-item"
                        onClick={selectSessionSent}
                        disabled={sessionSentPaths.size === 0}
                        role="menuitem"
                      >
                        Select copied/moved in session
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
              return (
                <li
                  key={item.path}
                  className={`ph-gallery-list-item${focusedPath === item.path ? " ph-gallery-list-item-focused" : ""}`}
                >
                  <DirectoryListRow
                    path={item.path}
                    name={item.name}
                    previewDepth={previewDepth}
                    selectionMode={selectionMode}
                    selected={selectedPaths.has(item.path)}
                    onOpen={openDirectory}
                    onToggleSelect={toggleListSelection}
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
                className={`ph-gallery-list-item${selected ? " ph-gallery-list-item-selected" : ""}${ghostPath === entry.path ? " ph-gallery-list-item-ghost" : ""}${focusedPath === entry.path ? " ph-gallery-list-item-focused" : ""}`}
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
                      <ListThumb entry={entry} />
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
                    <ListThumb entry={entry} />
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
          ItemContent={BrowserTile}
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
                      title={count > 0 ? plural(count, "photo") : "No photos"}
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
                        title={plural(row.count, "photo")}
                      >
                        {row.preview.video ? (
                          <span className="ph-date-day-row-thumb ph-date-day-row-thumb-video" aria-hidden>
                            <Film className="h-4 w-4" />
                          </span>
                        ) : (
                          <img
                            src={thumbUrl(row.preview, 96)}
                            alt={row.preview.name}
                            className="ph-date-day-row-thumb"
                            loading="lazy"
                            decoding="async"
                            draggable={false}
                          />
                        )}
                        <span className="ph-date-day-row-text">
                          <span className="ph-date-day-row-date">{DAY_LABEL_FORMAT.format(dateFromDayKey(row.day))}</span>
                          <span className="ph-date-day-row-count">
                            {plural(row.count, "photo")}
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
          onModalChange={setSelectionBarModal}
          active={openIndex === null}
          onDone={clearSelection}
          onNotice={showNotice}
          onSessionSent={noteSessionSent}
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
          onSessionSent={noteSessionSent}
        />
      )}
    </div>
  );
}
