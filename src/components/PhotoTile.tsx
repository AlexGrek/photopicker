import { memo, useState } from "react";
import { Check, ImageOff, Play } from "lucide-react";
import { cachedAspectRatio, rememberAspectRatio } from "@/lib/aspectCache";
import { thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { photoPathAttr } from "@/lib/photoScroll";
import { VideoThumb } from "./VideoThumb";

/**
 * A single masonry cell. The thumbnail is a normal lazy `<img>` pointed at the
 * `thumb://` scheme, so the webview fetches, decodes and caches it natively —
 * only tiles the virtualizer has mounted (near the viewport) ever load.
 *
 * The cell adopts the photo's real aspect ratio once the image reports its
 * natural size. That ratio is remembered (see `aspectCache.ts`), so a tile that is
 * virtualized away and scrolls back mounts at its final size straight away
 * instead of starting square and shifting the column when it reloads.
 *
 * Memoized, and given only primitive/stable props: selecting or focusing one tile
 * re-renders that tile, not every mounted tile. The host must key this component
 * by `entry.path` so its load state never leaks onto a different photo.
 */
export const PhotoTile = memo(function PhotoTile({
  entry,
  grid,
  selectionMode,
  selected,
  ghost,
  focused,
  onOpen,
  onToggleSelect,
}: {
  entry: ImageEntry;
  /** Square-grid mode: every cell is 1:1 regardless of the photo's shape. */
  grid: boolean;
  selectionMode: boolean;
  selected: boolean;
  /** Tile hidden while the close-flight animation targets it. */
  ghost: boolean;
  /** Keyboard/gamepad focus ring. */
  focused: boolean;
  onOpen: (path: string) => void;
  onToggleSelect: (path: string) => void;
}) {
  const [aspectRatio, setAspectRatio] = useState(() => cachedAspectRatio(entry) ?? "1 / 1");
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const showSelection = selectionMode || selected;

  function adoptAspect(ratio: string) {
    rememberAspectRatio(entry, ratio);
    setAspectRatio(ratio);
  }

  function handleMainClick() {
    if (selectionMode) onToggleSelect(entry.path);
    else onOpen(entry.path);
  }

  return (
    <div className={`ph-cell${selected ? " ph-cell-selected" : ""}${ghost ? " ph-cell-ghost" : ""}`}>
      <div
        className={`ph-tile${selected ? " ph-tile-selected" : ""}${focused ? " ph-tile-focused" : ""}`}
        data-photo-path={photoPathAttr(entry.path)}
        style={{ aspectRatio: grid ? "1 / 1" : aspectRatio }}
      >
        <button
          type="button"
          className="ph-tile-hit"
          onClick={handleMainClick}
          title={entry.name}
          aria-label={selected ? `${entry.name} (selected)` : entry.name}
          aria-pressed={selectionMode ? selected : undefined}
        >
          {entry.video ? (
            <VideoThumb entry={entry} onAspect={adoptAspect} />
          ) : (
            <>
              {status !== "error" && (
                <img
                  src={thumbUrl(entry, 256)}
                  alt={entry.name}
                  className="ph-tile-img"
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  style={{ opacity: status === "loaded" ? 1 : 0 }}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                      adoptAspect(`${img.naturalWidth} / ${img.naturalHeight}`);
                    }
                    setStatus("loaded");
                  }}
                  onError={() => setStatus("error")}
                />
              )}
              {status === "loading" && <div className="ph-tile-state ph-tile-skeleton" />}
              {status === "error" && (
                <div className="ph-tile-state ph-tile-failed">
                  <ImageOff className="h-5 w-5" />
                </div>
              )}
            </>
          )}
          {entry.video && (
            <span className="ph-tile-video-badge" aria-hidden>
              <Play className="h-4 w-4" fill="currentColor" />
            </span>
          )}
        </button>
        {showSelection && (
          <span className={`ph-tile-check${selected ? " ph-tile-check-on" : ""}`} aria-hidden>
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        )}
        {selectionMode && (
          <button
            type="button"
            className="ph-tile-open"
            onClick={() => onOpen(entry.path)}
            title="Open fullscreen"
            aria-label={`Open ${entry.name}`}
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
});
