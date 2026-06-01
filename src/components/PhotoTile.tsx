import { useState } from "react";
import { ImageOff } from "lucide-react";
import { thumbUrl, type ImageEntry } from "@/lib/thumbnails";

/** Shared data the masonry passes to every tile. */
export interface TileContext {
  onOpen: (index: number) => void;
  mode: "masonry" | "grid";
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

  return (
    <div className="ph-cell">
      <button
        type="button"
        className="ph-tile"
        style={{ aspectRatio: isGrid ? "1 / 1" : aspectRatio }}
        onClick={() => context.onOpen(index)}
        title={data.name}
        aria-label={data.name}
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
    </div>
  );
}
