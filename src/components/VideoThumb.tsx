import { useEffect, useState } from "react";
import { Film } from "lucide-react";
import { type ImageEntry } from "@/lib/thumbnails";
import { acquireVideoPoster } from "@/lib/videoThumbs";

/**
 * Renders a video's poster frame (generated client-side — see `videoThumbs.ts`) as a
 * plain `<img>`, with a shimmer while it decodes and a film-icon fallback if it can't.
 * The play badge is drawn by the parent, which owns the tile's positioning.
 *
 * The poster is claimed while this component is mounted and released when it
 * unmounts, so a tile that scrolls away before its poster was generated drops out
 * of the decode queue instead of holding up the tiles now on screen.
 *
 * `onAspect` reports the poster's natural aspect ratio so the masonry can size the cell,
 * mirroring how {@link PhotoTile} reacts to a photo `<img>`'s `onLoad`.
 */
export function VideoThumb({
  entry,
  className = "ph-tile-img",
  onAspect,
}: {
  entry: ImageEntry;
  className?: string;
  onAspect?: (ratio: string) => void;
}) {
  const { path, modified } = entry;
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  useEffect(() => {
    let alive = true;
    setStatus("loading");
    setSrc(null);
    const handle = acquireVideoPoster(path, modified);
    handle.promise.then(
      (url) => alive && setSrc(url),
      () => alive && setStatus("error"),
    );
    return () => {
      alive = false;
      handle.release();
    };
  }, [path, modified]);

  return (
    <>
      {status !== "error" && src && (
        <img
          src={src}
          alt={entry.name}
          className={className}
          draggable={false}
          style={{ opacity: status === "loaded" ? 1 : 0 }}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (onAspect && img.naturalWidth > 0 && img.naturalHeight > 0) {
              onAspect(`${img.naturalWidth} / ${img.naturalHeight}`);
            }
            setStatus("loaded");
          }}
          onError={() => setStatus("error")}
        />
      )}
      {status === "loading" && <div className="ph-tile-state ph-tile-skeleton" />}
      {status === "error" && (
        <div className="ph-tile-state ph-tile-failed">
          <Film className="h-5 w-5" />
        </div>
      )}
    </>
  );
}
