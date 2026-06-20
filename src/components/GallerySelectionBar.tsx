import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  Copy,
  Flag,
  FolderInput,
  FolderOutput,
  FolderSearch,
  RotateCcw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { type Config, menuIndexForConfig, persistLastTargetDirectory } from "@/lib/config";
import { useGamepad } from "@/lib/gamepad";
import {
  EMPTY_MARK,
  copyToTarget,
  deleteFile,
  moveToTarget,
  rotateImage,
  setMark,
  type Mark,
} from "@/lib/marks";
import { shortenPath } from "@/lib/utils";
import { type BrowserItem, isPhotoItem } from "@/lib/browse";

type SendMode = "copy" | "move";
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
}: {
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

  const [targets, setTargets] = useState<string[]>([]);
  const [menuMode, setMenuMode] = useState<SendMode | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    invoke<Config>("get_config").then(
      (cfg) => {
        if (!alive) return;
        setTargets(cfg.targetDirectories);
        setMenuIndex(menuIndexForConfig(cfg));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setPending(null);
    setMenuMode(null);
  }, [count]);

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

  const itemLabel = (count: number) =>
    `${count} item${count === 1 ? "" : "s"}`;

  const browseIndex = targets.length;
  const itemCount = targets.length + 1;
  const selIndex = Math.min(menuIndex, itemCount - 1);
  const cycleMenu = (delta: number) => {
    const next = (((menuIndex + delta) % itemCount) + itemCount) % itemCount;
    setMenuIndex(next);
    if (next < targets.length) persistLastTargetDirectory(targets[next]);
  };

  async function sendTo(target: string, mode: SendMode) {
    setMenuMode(null);
    persistLastTargetDirectory(target);
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
        for (const item of photoSelected) {
          void setMark(dir, item.entry.name, EMPTY_MARK).catch(() => {});
        }
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

  async function browseAndSend(mode: SendMode) {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      const cfg = await invoke<Config>("add_target_directory", { dir: picked });
      setTargets(cfg.targetDirectories);
      const idx = cfg.targetDirectories.findIndex((d) => d === picked);
      if (idx >= 0) setMenuIndex(idx);
    } catch {
      /* one-off send still allowed */
    }
    void sendTo(picked, mode);
  }

  function confirmSelection(mode: SendMode) {
    if (selIndex === browseIndex) void browseAndSend(mode);
    else void sendTo(targets[selIndex], mode);
  }

  function requestSend(mode: SendMode) {
    setPending(null);
    if (menuMode === mode) confirmSelection(mode);
    else setMenuMode(mode);
  }

  async function doDelete() {
    const paths = uniqueActionPaths();
    setPending(null);
    setBusy(true);
    onNotice(`Deleting ${itemLabel(paths.length)}…`);
    try {
      for (const path of paths) await deleteFile(path);
      for (const item of photoSelected) {
        void setMark(dir, item.entry.name, EMPTY_MARK).catch(() => {});
      }
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
    setMenuMode(null);
    setPending((cur) => (cur === action ? null : action));
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (menuMode) {
        if (e.key === "Escape") return setMenuMode(null);
        if (e.key === "ArrowUp") {
          e.preventDefault();
          return cycleMenu(-1);
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          return cycleMenu(1);
        }
        if (e.key === "Enter") {
          e.preventDefault();
          confirmSelection(menuMode);
        }
        return;
      }
      if (pending && e.key === "Escape") setPending(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuMode, menuIndex, pending]);

  useGamepad((button) => {
    if (menuMode) {
      if (button === "b") setMenuMode(null);
      if (button === "up") cycleMenu(-1);
      if (button === "down") cycleMenu(1);
      if (button === "a") confirmSelection(menuMode);
      return;
    }
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
  });

  const barRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {menuMode && (
        <div className="ph-sel-menu-backdrop" onClick={() => setMenuMode(null)}>
          <div className="ph-lb-menu ph-sel-menu" onClick={(e) => e.stopPropagation()}>
            <div className="ph-lb-menu-title">
              {menuMode === "copy" ? `Copy ${count} to…` : `Move ${count} to…`}
            </div>
            {targets.map((t, i) => (
              <button
                key={t}
                type="button"
                className={`ph-lb-menu-item${i === selIndex ? " ph-lb-menu-item-selected" : ""}`}
                onClick={() => sendTo(t, menuMode)}
                onMouseEnter={() => setMenuIndex(i)}
                title={t}
              >
                <FolderInput className="h-4 w-4 shrink-0" />
                <span className="ph-lb-menu-label">{shortenPath(t)}</span>
              </button>
            ))}
            <button
              type="button"
              className={`ph-lb-menu-item ph-lb-menu-browse${selIndex === browseIndex ? " ph-lb-menu-item-selected" : ""}`}
              onClick={() => browseAndSend(menuMode)}
              onMouseEnter={() => setMenuIndex(browseIndex)}
            >
              <FolderSearch className="h-4 w-4 shrink-0" />
              <span className="ph-lb-menu-label">Browse…</span>
            </button>
            <div className="ph-lb-menu-hint">↑↓ choose · Enter to confirm</div>
          </div>
        </div>
      )}

      <div className="ph-sel-bar-wrap" ref={barRef}>
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
