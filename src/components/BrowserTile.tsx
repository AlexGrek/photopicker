import { type ItemContent } from "@virtuoso.dev/masonry";
import { type BrowserItem, isPhotoItem } from "@/lib/browse";
import { DirectoryTile } from "./DirectoryTile";
import { PhotoTile } from "./PhotoTile";

/**
 * Shared data the virtualizer passes to every tile/row. The callbacks must be
 * referentially stable: the tiles are memoized, and an unstable callback would
 * re-render every mounted tile on each gallery render.
 */
export interface BrowserTileContext {
  mode: "masonry" | "grid";
  selectionMode: boolean;
  selectedPaths: ReadonlySet<string>;
  /** Tile hidden while the close-flight animation targets it. */
  ghostPath: string | null;
  /** Item carrying the keyboard/gamepad focus ring. */
  focusedPath: string | null;
  previewDepth: number;
  onOpenPhoto: (path: string) => void;
  onOpenDirectory: (path: string) => void;
  onToggleSelect: (path: string) => void;
}

/**
 * Adapts the virtualizer's `(data, context)` call to the memoized tiles: it
 * resolves the per-tile booleans here, so a change to the selection or focus
 * re-renders only the tiles whose own state actually changed.
 */
export const BrowserTile: ItemContent<BrowserItem, BrowserTileContext> = ({ data, context }) => {
  if (isPhotoItem(data)) {
    const path = data.entry.path;
    return (
      <PhotoTile
        key={path}
        entry={data.entry}
        grid={context.mode === "grid"}
        selectionMode={context.selectionMode}
        selected={context.selectedPaths.has(path)}
        ghost={context.ghostPath === path}
        focused={context.focusedPath === path}
        onOpen={context.onOpenPhoto}
        onToggleSelect={context.onToggleSelect}
      />
    );
  }
  return (
    <DirectoryTile
      key={data.path}
      path={data.path}
      name={data.name}
      previewDepth={context.previewDepth}
      selectionMode={context.selectionMode}
      selected={context.selectedPaths.has(data.path)}
      focused={context.focusedPath === data.path}
      onOpen={context.onOpenDirectory}
      onToggleSelect={context.onToggleSelect}
    />
  );
};
