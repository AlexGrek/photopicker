import { useEffect, useState } from "react";
import { Check, Copy, Flag, FolderOutput, RotateCcw, RotateCw, Trash2, X } from "lucide-react";
import { useGamepad } from "@/lib/gamepad";
import { useWindowKeydown } from "@/lib/hooks";
import { DestinationChooser, useDestinationChooser, type SendMode } from "./DestinationChooser";
import {
  EMPTY_MARK,
  copyToTarget,
  deleteFile,
  moveToTarget,
  rotateImage,
  setMark,
  type Mark,
} from "@/lib/marks";
import { baseName, plural, shortenPath } from "@/lib/utils";
import { type BrowserItem, isPhotoItem } from "@/lib/browse";

type PendingAction = "delete" | "rotate-ccw" | "rotate-cw" | "flag" | "unflag";

/**
 * Bottom action bar shown when one or more gallery photos are selected.
 * Keeps controls compact (icon-first, labels hidden on narrow viewports) and
 * requires inline confirmation before destructive or metadata bulk edits.
 */
export function GallerySelectionBar({
  dir,
  selected,
  marks,
  actionPathsByPath,
  onRemoved,
  onEntryUpdated,
  onMarksChanged,
  onDone,
  onNotice,
  onSessionSent,
  onModalChange,
  active = true,
}: {
  /** Reports whether the bar has a chooser or confirmation open (it then owns the keys and pad). */
  onModalChange?: (open: boolean) => void;
  /** False while another surface (the lightbox) covers the bar: it must then ignore the gamepad and keys. */
  active?: boolean;
  dir: string;
  selected: BrowserItem[];
  marks: Record<string, Mark>;
  actionPathsByPath: Record<string, string[]>;
  onRemoved: (paths: string[]) => void;
  onEntryUpdated: (path: string, modified: number | null) => void;
  onMarksChanged: (marks: Record<string, Mark>) => void;
  onDone: () => void;
  onNotice: (text: string) => void;
  onSessionSent?: (paths: string[]) => void;
}) {
  const count = selected.length;
  const anyFlagged = selected.some(
    (item) => isPhotoItem(item) && (marks[item.entry.name] ?? EMPTY_MARK).flag,
  );
  const rotatable = selected.filter(
    (item): item is Extract<BrowserItem, { kind: "photo" }> =>
      isPhotoItem(item) && !item.entry.raw,
  );
  const photoSelected = selected.filter(isPhotoItem);
  const hasPhotos = photoSelected.length > 0;

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const chooser = useDestinationChooser((target, mode) => void sendTo(target, mode));
  const menuMode = chooser.mode;
  const { close: closeChooser } = chooser;

  useEffect(() => {
    setPending(null);
    closeChooser();
  }, [count, closeChooser]);

  const modalOpen = menuMode !== null || pending !== null;
  useEffect(() => {
    onModalChange?.(modalOpen);
    return () => onModalChange?.(false);
  }, [modalOpen, onModalChange]);

  const actionPathsFor = (item: BrowserItem) => {
    if (!isPhotoItem(item)) return [item.path];
    return actionPathsByPath[item.entry.path] ?? [item.entry.path];
  };

  const uniqueActionPaths = () => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of selected) {
      for (const path of actionPathsFor(item)) {
        if (!seen.has(path)) {
          seen.add(path);
          out.push(path);
        }
      }
    }
    return out;
  };

  const itemLabel = (n: number) => plural(n, "item");

  async function sendTo(target: string, mode: SendMode) {
    const paths = uniqueActionPaths();
    const dest = shortenPath(target);
    setBusy(true);
    onNotice(`${mode === "copy" ? "Copying" : "Moving"} ${itemLabel(paths.length)} to ${dest}…`);
    try {
      if (mode === "copy") {
        for (const path of paths) await copyToTarget(path, target);
        onSessionSent?.(photoSelected.map((item) => item.entry.path));
        onNotice(`Copied ${itemLabel(paths.length)} to ${dest}`);
      } else {
        for (const path of paths) await moveToTarget(path, target);
        onSessionSent?.(photoSelected.map((item) => item.entry.path));
        for (const path of paths) void setMark(dir, baseName(path), EMPTY_MARK).catch(() => {});
        onRemoved(paths);
        onNotice(`Moved ${itemLabel(paths.length)} to ${dest}`);
        onDone();
      }
    } catch (e) {
      onNotice(`${mode === "copy" ? "Copy" : "Move"} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function requestSend(mode: SendMode) {
    setPending(null);
    chooser.request(mode);
  }

  async function doDelete() {
    const paths = uniqueActionPaths();
    setPending(null);
    setBusy(true);
    onNotice(`Deleting ${itemLabel(paths.length)}…`);
    try {
      for (const path of paths) await deleteFile(path);
      for (const path of paths) void setMark(dir, baseName(path), EMPTY_MARK).catch(() => {});
      onRemoved(paths);
      onNotice(`Deleted ${itemLabel(paths.length)}`);
      onDone();
    } catch (e) {
      onNotice(`Delete failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function doRotate(clockwise: boolean) {
    if (rotatable.length === 0) return;
    setPending(null);
    setBusy(true);
    const label = clockwise ? "clockwise" : "counter-clockwise";
    onNotice(`Rotating ${rotatable.length} photo${rotatable.length === 1 ? "" : "s"} ${label}…`);
    let ok = 0;
    let fail = 0;
    for (const entry of rotatable) {
      try {
        const res = await rotateImage(entry.entry.path, clockwise);
        onEntryUpdated(entry.entry.path, res.modified);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    onNotice(
      fail === 0
        ? `Rotated ${ok} photo${ok === 1 ? "" : "s"} ${label}`
        : `Rotated ${ok}, failed ${fail}`,
    );
    setBusy(false);
  }

  async function doFlagToggle(flag: boolean) {
    setPending(null);
    setBusy(true);
    const next = { ...marks };
    for (const item of photoSelected) {
      const cur = next[item.entry.name] ?? EMPTY_MARK;
      next[item.entry.name] = { ...cur, flag };
      await setMark(dir, item.entry.name, next[item.entry.name]).catch(() => {});
    }
    onMarksChanged(next);
    onNotice(`${flag ? "Flagged" : "Unflagged"} ${photoSelected.length} photo${photoSelected.length === 1 ? "" : "s"}`);
    setBusy(false);
  }

  function requestConfirm(action: PendingAction) {
    closeChooser();
    setPending((cur) => (cur === action ? null : action));
  }

  useWindowKeydown((e) => {
    if (chooser.handleKey(e)) return;
    if (pending && e.key === "Escape") setPending(null);
  }, active);

  useGamepad((button) => {
    if (chooser.handleGamepad(button)) return;
    if (pending) {
      if (button === "b") setPending(null);
      if (button === "a") {
        if (pending === "delete") void doDelete();
        else if (pending === "rotate-ccw") void doRotate(false);
        else if (pending === "rotate-cw") void doRotate(true);
        else if (pending === "flag") void doFlagToggle(true);
        else if (pending === "unflag") void doFlagToggle(false);
      }
      return;
    }
    if (button === "y") requestSend("copy");
  }, active);

  return (
    <>
      {menuMode && (
        <DestinationChooser
          chooser={chooser}
          title={menuMode === "copy" ? `Copy ${count} to…` : `Move ${count} to…`}
          hint="↑↓ choose · Enter to confirm"
          backdropClassName="ph-sel-menu-backdrop"
          menuClassName="ph-lb-menu ph-sel-menu"
        />
      )}

      <div className="ph-sel-bar-wrap">
        <div className="ph-sel-bar" role="toolbar" aria-label="Selection actions">
          <span className="ph-sel-count">
            {count} selected
          </span>

          <span className="ph-sel-sep" aria-hidden />

          <button
            type="button"
            className="ph-sel-btn"
            onClick={() => requestSend("copy")}
            disabled={busy}
            title="Copy to target location"
          >
            <Copy className="h-4 w-4" />
            <span className="ph-sel-btn-label">Copy</span>
          </button>
          <button
            type="button"
            className="ph-sel-btn"
            onClick={() => requestSend("move")}
            disabled={busy}
            title="Move to target location"
          >
            <FolderOutput className="h-4 w-4" />
            <span className="ph-sel-btn-label">Move</span>
          </button>

          <span className="ph-sel-sep" aria-hidden />

          <div className={`ph-sel-confirm-wrap${pending === "rotate-ccw" ? " ph-sel-confirm-armed" : ""}`}>
            {pending === "rotate-ccw" ? (
              <>
                <span className="ph-sel-confirm-q">Rotate {rotatable.length}?</span>
                <button type="button" className="ph-sel-confirm-yes" onClick={() => void doRotate(false)} title="Confirm">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" className="ph-sel-confirm-no" onClick={() => setPending(null)} title="Cancel">
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ph-sel-btn"
                onClick={() => requestConfirm("rotate-ccw")}
                disabled={busy || rotatable.length === 0}
                title="Rotate counter-clockwise"
                aria-label="Rotate counter-clockwise"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            )}
          </div>
          <div className={`ph-sel-confirm-wrap${pending === "rotate-cw" ? " ph-sel-confirm-armed" : ""}`}>
            {pending === "rotate-cw" ? (
              <>
                <span className="ph-sel-confirm-q">Rotate {rotatable.length}?</span>
                <button type="button" className="ph-sel-confirm-yes" onClick={() => void doRotate(true)} title="Confirm">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" className="ph-sel-confirm-no" onClick={() => setPending(null)} title="Cancel">
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ph-sel-btn"
                onClick={() => requestConfirm("rotate-cw")}
                disabled={busy || rotatable.length === 0}
                title="Rotate clockwise"
                aria-label="Rotate clockwise"
              >
                <RotateCw className="h-4 w-4" />
              </button>
            )}
          </div>

          <span className="ph-sel-sep" aria-hidden />

          <div
            className={`ph-sel-confirm-wrap${pending === (anyFlagged ? "unflag" : "flag") ? " ph-sel-confirm-armed ph-sel-confirm-flag" : ""}`}
          >
            {pending === (anyFlagged ? "unflag" : "flag") ? (
              <>
                <span className="ph-sel-confirm-q">{anyFlagged ? "Unflag" : "Flag"} {count}?</span>
                <button
                  type="button"
                  className="ph-sel-confirm-yes"
                  onClick={() => void doFlagToggle(!anyFlagged)}
                  title="Confirm"
                >
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" className="ph-sel-confirm-no" onClick={() => setPending(null)} title="Cancel">
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className={`ph-sel-btn${anyFlagged ? " ph-sel-btn-on" : ""}`}
                onClick={() => requestConfirm(anyFlagged ? "unflag" : "flag")}
                disabled={busy || !hasPhotos}
                title={anyFlagged ? "Unflag selected photos" : "Flag selected photos"}
              >
                <Flag className="h-4 w-4" />
                <span className="ph-sel-btn-label">{anyFlagged ? "Unflag" : "Flag"}</span>
              </button>
            )}
          </div>

          <span className="ph-sel-sep" aria-hidden />

          <div className={`ph-sel-confirm-wrap ph-sel-confirm-danger${pending === "delete" ? " ph-sel-confirm-armed" : ""}`}>
            {pending === "delete" ? (
              <>
                <span className="ph-sel-confirm-q">Delete {count}?</span>
                <button type="button" className="ph-sel-confirm-yes" onClick={() => void doDelete()} title="Confirm delete">
                  <Check className="h-4 w-4" />
                </button>
                <button type="button" className="ph-sel-confirm-no" onClick={() => setPending(null)} title="Cancel">
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ph-sel-btn ph-sel-btn-danger"
                onClick={() => requestConfirm("delete")}
                disabled={busy}
                title="Delete selected"
              >
                <Trash2 className="h-4 w-4" />
                <span className="ph-sel-btn-label">Delete</span>
              </button>
            )}
          </div>

          <button
            type="button"
            className="ph-sel-dismiss"
            onClick={onDone}
            title="Clear selection"
            aria-label="Clear selection"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    </>
  );
}
