import { type ItemContent } from "@virtuoso.dev/masonry";
import { type BrowserItem, isPhotoItem } from "@/lib/browse";
import { DirectoryTile } from "./DirectoryTile";
import { PhotoTile, type TileContext } from "./PhotoTile";

export type BrowserTileContext = TileContext & {
  previewDepth: number;
  photoIndexForPath: (path: string) => number;
  onOpenDirectory: (path: string) => void;
};

export const BrowserTile: ItemContent<BrowserItem, BrowserTileContext> = ({
  data,
  context,
}) => {
  if (isPhotoItem(data)) {
    const photoIndex = context.photoIndexForPath(data.entry.path);
    return (
      <PhotoTile
        data={data.entry}
        index={photoIndex}
        context={context}
      />
    );
  }
  return (
    <DirectoryTile
      data={data}
      context={{
        previewDepth: context.previewDepth,
        selectionMode: context.selectionMode,
        selectedPaths: context.selectedPaths,
        onOpen: context.onOpenDirectory,
        onToggleSelect: context.onToggleSelect,
      }}
    />
  );
};
