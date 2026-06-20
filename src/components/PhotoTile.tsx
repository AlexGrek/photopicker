import { useState } from "react";
import { Check, ImageOff } from "lucide-react";
import { thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { photoPathAttr } from "@/lib/photoScroll";

/** Shared data the masonry passes to every tile. */
export interface TileContext {
  onOpen: (index: number) => void;
  mode: "masonry" | "grid";
  selectionMode: boolean;
  selectedPaths: ReadonlySet<string>;
  /** Tile hidden while the close-flight animation targets it. */
  ghostPath: string | null;
  onToggleSelect: (path: string) => void;
}

/**
 * A single masonry cell. The thumbnail is a normal lazy `<img>` pointed at the
 * `thumb://` scheme, so the webview fetches, decodes and caches it natively —
 * only tiles the virtualizer has mounted (near the viewport) ever load. The cell
 * starts square and adopts the photo's real aspect ratio once the image reports
 * its natural size, which the masonry then re-measures.
 */
export function PhotoTile({
  data,
  index,
  context,
}: {
  data: ImageEntry;
  index: number;
  context: TileContext;
}) {
  const [aspectRatio, setAspectRatio] = useState("1 / 1");
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const isGrid = context.mode === "grid";
  const selected = context.selectedPaths.has(data.path);
  const showSelection = context.selectionMode || selected;
  const ghost = context.ghostPath === data.path;

  function handleMainClick() {
    if (context.selectionMode) context.onToggleSelect(data.path);
    else context.onOpen(index);
  }

  return (
    <div className={`ph-cell${selected ? " ph-cell-selected" : ""}${ghost ? " ph-cell-ghost" : ""}`}>
      <div
        className={`ph-tile${selected ? " ph-tile-selected" : ""}`}
        data-photo-path={photoPathAttr(data.path)}
        style={{ aspectRatio: isGrid ? "1 / 1" : aspectRatio }}
      >
        <button
          type="button"
          className="ph-tile-hit"
          onClick={handleMainClick}
          title={data.name}
          aria-label={selected ? `${data.name} (selected)` : data.name}
          aria-pressed={context.selectionMode ? selected : undefined}
        >
          {status !== "error" && (
            <img
              src={thumbUrl(data, 256)}
              alt={data.name}
              className="ph-tile-img"
              loading="lazy"
              decoding="async"
              draggable={false}
              style={{ opacity: status === "loaded" ? 1 : 0 }}
              onLoad={(e) => {
                const img = e.currentTarget;
                if (!isGrid && img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setAspectRatio(`${img.naturalWidth} / ${img.naturalHeight}`);
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
        </button>
        {showSelection && (
          <span className={`ph-tile-check${selected ? " ph-tile-check-on" : ""}`} aria-hidden>
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        )}
        {context.selectionMode && (
          <button
            type="button"
            className="ph-tile-open"
            onClick={() => context.onOpen(index)}
            title="Open fullscreen"
            aria-label={`Open ${data.name}`}
          >
            Open
          </button>
        )}
      </div>
    </div>
  );
}
