import { useEffect, useState } from "react";
import { Check, Film, Folder } from "lucide-react";
import { directoryPreview } from "@/lib/browse";
import { thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { photoPathAttr } from "@/lib/photoScroll";

export interface DirectoryTileContext {
  previewDepth: number;
  selectionMode: boolean;
  selectedPaths: ReadonlySet<string>;
  onOpen: (path: string) => void;
  onToggleSelect: (path: string) => void;
}

function DirectoryPreviewGrid({
  path,
  previewDepth,
  className,
}: {
  path: string;
  previewDepth: number;
  className?: string;
}) {
  const [previews, setPreviews] = useState<ImageEntry[] | null>(null);

  useEffect(() => {
    let alive = true;
    setPreviews(null);
    directoryPreview(path, previewDepth).then(
      (items) => alive && setPreviews(items),
      () => alive && setPreviews([]),
    );
    return () => {
      alive = false;
    };
  }, [path, previewDepth]);

  const slots = Array.from({ length: 4 }, (_, i) => previews?.[i] ?? null);

  return (
    <div className={`ph-dir-preview${className ? ` ${className}` : ""}`} aria-hidden>
      {slots.map((preview, i) => (
        <div key={i} className="ph-dir-preview-cell">
          {preview ? (
            <img
              src={thumbUrl(preview, 128)}
              alt=""
              className="ph-dir-preview-img"
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          ) : previews !== null ? (
            <span className="ph-dir-preview-blank" />
          ) : (
            <span className="ph-dir-preview-blank ph-dir-preview-loading" />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A masonry/grid cell for a subdirectory. Shows a 2×2 mosaic of up to four child
 * previews (lazy-loaded), cropped to squares with a heavy inset vignette.
 */
export function DirectoryTile({
  data,
  context,
}: {
  data: { path: string; name: string };
  context: DirectoryTileContext;
}) {
  const selected = context.selectedPaths.has(data.path);
  const showSelection = context.selectionMode || selected;

  function handleMainClick() {
    if (context.selectionMode) context.onToggleSelect(data.path);
    else context.onOpen(data.path);
  }

  return (
    <div className={`ph-cell${selected ? " ph-cell-selected" : ""}`}>
      <div
        className={`ph-tile ph-dir-tile${selected ? " ph-tile-selected" : ""}`}
        data-photo-path={photoPathAttr(data.path)}
        style={{ aspectRatio: "1 / 1" }}
      >
        <button
          type="button"
          className="ph-tile-hit"
          onClick={handleMainClick}
          title={data.name}
          aria-label={selected ? `${data.name} folder (selected)` : `${data.name} folder`}
          aria-pressed={context.selectionMode ? selected : undefined}
        >
          <div className="ph-dir-preview-wrap" aria-hidden>
            <DirectoryPreviewGrid path={data.path} previewDepth={context.previewDepth} />
            <div className="ph-dir-vignette" />
          </div>
          <div className="ph-dir-label">
            <Folder className="h-3.5 w-3.5 shrink-0" />
            <span className="ph-dir-label-text">{data.name}</span>
          </div>
        </button>
        {showSelection && (
          <span className={`ph-tile-check${selected ? " ph-tile-check-on" : ""}`} aria-hidden>
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        )}
      </div>
    </div>
  );
}

/** List-view row for a subdirectory (same 2×2 preview mosaic as grid tiles). */
export function DirectoryListRow({
  data,
  previewDepth,
  selectionMode,
  selected,
  onOpen,
  onToggleSelect,
}: {
  data: { path: string; name: string };
  previewDepth: number;
  selectionMode: boolean;
  selected: boolean;
  onOpen: (path: string) => void;
  onToggleSelect: (path: string) => void;
}) {
  function handleMainClick() {
    if (selectionMode) onToggleSelect(data.path);
    else onOpen(data.path);
  }

  return (
    <div
      className={`ph-gallery-list-row ph-gallery-list-dir${selected ? " ph-gallery-list-item-selected" : ""}`}
      data-photo-path={photoPathAttr(data.path)}
    >
      <button
        type="button"
        className="ph-gallery-list-hit"
        onClick={handleMainClick}
        title={data.name}
        aria-pressed={selectionMode ? selected : undefined}
      >
        {selectionMode && (
          <span className={`ph-list-check${selected ? " ph-list-check-on" : ""}`} aria-hidden>
            {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
          </span>
        )}
        <div className="ph-gallery-list-dir-thumb">
          <DirectoryPreviewGrid path={data.path} previewDepth={previewDepth} />
          <div className="ph-dir-vignette" />
        </div>
        <span className="ph-gallery-list-text">
          <span className="ph-gallery-list-name">
            <Folder className="ph-gallery-list-dir-icon" />
            {data.name}
          </span>
          <span className="ph-gallery-list-date">Folder</span>
        </span>
      </button>
    </div>
  );
}
