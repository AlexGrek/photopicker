import { useEffect, useMemo, useRef, useState } from "react";
import { VirtuosoMasonry, type ItemContent } from "@virtuoso.dev/masonry";
import { ArrowLeft, Flag, ImageOff, Star } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listImages, type ImageEntry } from "@/lib/thumbnails";
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

function dirName(dir: string): string {
  const parts = dir.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || dir;
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
  // Which `initialFile` we've already auto-opened, so later list changes (e.g. a
  // move/delete dropping a tile) never yank the lightbox back to the opened photo.
  const openedFileRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setEntries(null);
    setError(null);
    setOpenIndex(null);
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

  const filtersActive = minRating > 0 || flaggedOnly;

  // The photos actually shown — the grid and the lightbox both navigate this list,
  // so `openIndex` always indexes the filtered set.
  const visible = useMemo<ImageEntry[]>(() => {
    if (!entries) return [];
    if (!filtersActive) return entries;
    return entries.filter((e) => {
      const m = marks[e.name] ?? EMPTY_MARK;
      if (flaggedOnly && !m.flag) return false;
      return m.rating >= minRating;
    });
  }, [entries, marks, minRating, flaggedOnly, filtersActive]);

  // Once the directory's entries are in, jump to the OS-opened file — exactly once
  // per requested file. Clears any active filter first so the file always shows.
  useEffect(() => {
    if (!initialFile || !entries) return;
    if (openedFileRef.current === initialFile) return;
    openedFileRef.current = initialFile;
    const i = entries.findIndex((e) => e.name === initialFile);
    if (i >= 0) {
      setMinRating(0);
      setFlaggedOnly(false);
      setOpenIndex(i);
    }
  }, [initialFile, entries]);

  const context = useMemo<TileContext>(
    () => ({ onOpen: (i) => setOpenIndex(i) }),
    [],
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
      ) : (
        <VirtuosoMasonry
          useWindowScroll
          columnCount={columnCount}
          data={visible}
          context={context}
          ItemContent={TileItem}
          className="ph-masonry"
        />
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
