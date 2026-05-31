import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Flag,
  FolderInput,
  FolderOutput,
  FolderSearch,
  Loader2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { origUrl, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { useGamepad } from "@/lib/gamepad";
import { shortenPath } from "@/lib/utils";
import { type Config } from "@/lib/config";
import { EMPTY_MARK, copyToTarget, deleteFile, getMarks, moveToTarget, setMark, type Mark } from "@/lib/marks";

/** How close to an edge (px) the cursor must be to reveal that edge's controls. */
const EDGE_REVEAL_PX = 120;
/** How long the image counter stays up after switching photos, before fading. */
const INFO_FLASH_MS = 2200;

/**
 * Real fullscreen view of the **full-resolution** photo.
 *
 * While open it puts the OS window into fullscreen (no title bar / borders) and
 * the image fills the whole screen. Opening a 100 MP file off slow storage takes
 * a moment, so the cached grid thumbnail is shown first — stretched to fill the
 * screen — then the original streams in via `orig://` and fades in over it. The
 * current photo plus its immediate neighbours are kept mounted (see {@link Slide})
 * so stepping to an already-decoded neighbour is instant.
 *
 * A bottom toolbar (revealed when the cursor nears the bottom edge) carries the
 * culling controls: navigate, Copy to a target location, rate 1–5, flag. Marks
 * persist per photo. Arrow keys / chevrons / gamepad d-pad navigate; the toolbar
 * actions also have keyboard shortcuts (C, 1–5, F); Escape / the close button /
 * gamepad B exit.
 */
type SendMode = "copy" | "move";

export function Lightbox({
  dir,
  entries,
  index,
  onIndex,
  onClose,
  onRemoved,
}: {
  dir: string;
  entries: ImageEntry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Called with a photo's path after it leaves the directory (moved or deleted),
   *  so the host can drop that tile from the grid. */
  onRemoved: (path: string) => void;
}) {
  const entry = entries[index];

  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [toolbarShown, setToolbarShown] = useState(false);
  const [edges, setEdges] = useState({ top: false, left: false, right: false });
  const [infoFlash, setInfoFlash] = useState(true); // counter shows on open + after switching
  const [menuMode, setMenuMode] = useState<SendMode | null>(null);
  const [menuIndex, setMenuIndex] = useState(0); // highlighted destination in the chooser
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const mark = marks[entry.name] ?? EMPTY_MARK;
  const showToolbar = toolbarShown || menuMode !== null || confirmingDelete;
  const showInfo = infoFlash || toolbarShown;

  // Load this directory's saved marks + the configured copy targets.
  useEffect(() => {
    let alive = true;
    getMarks(dir).then(
      (m) => alive && setMarks(m),
      () => alive && setMarks({}),
    );
    invoke<Config>("get_config").then(
      (cfg) => alive && setTargets(cfg.targetDirectories),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [dir]);

  // Drive the OS window into fullscreen for as long as the lightbox is open,
  // restoring the previous state on close (unless the user was already fullscreen).
  useEffect(() => {
    const win = getCurrentWindow();
    let wasFullscreen = false;
    let cancelled = false;
    (async () => {
      try {
        wasFullscreen = await win.isFullscreen();
        if (!cancelled) await win.setFullscreen(true);
      } catch {
        /* fullscreen not permitted — the overlay still fills the window */
      }
    })();
    return () => {
      cancelled = true;
      if (!wasFullscreen) void win.setFullscreen(false).catch(() => {});
    };
  }, []);

  // Reveal each edge's controls only while the cursor is near that edge.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const { innerWidth: w, innerHeight: h } = window;
      const bottom = e.clientY >= h - EDGE_REVEAL_PX;
      const top = e.clientY <= EDGE_REVEAL_PX;
      const left = e.clientX <= EDGE_REVEAL_PX;
      const right = e.clientX >= w - EDGE_REVEAL_PX;
      setToolbarShown((prev) => (prev === bottom ? prev : bottom));
      setEdges((prev) =>
        prev.top === top && prev.left === left && prev.right === right
          ? prev
          : { top, left, right },
      );
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Flash the image counter on open and whenever the photo changes, then fade it.
  // Switching photos also cancels any pending delete confirmation.
  useEffect(() => {
    setInfoFlash(true);
    setConfirmingDelete(false);
    const t = setTimeout(() => setInfoFlash(false), INFO_FLASH_MS);
    return () => clearTimeout(t);
  }, [index]);

  // Auto-dismiss the transient status toast.
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 2600);
    return () => clearTimeout(t);
  }, [status]);

  const hasPrev = index > 0;
  const hasNext = index < entries.length - 1;
  const goPrev = () => hasPrev && onIndex(index - 1);
  const goNext = () => hasNext && onIndex(index + 1);

  function applyMark(next: Mark) {
    setMarks((m) => ({ ...m, [entry.name]: next }));
    void setMark(dir, entry.name, next).catch(() => {});
    setToolbarShown(true); // keep visible so the change is seen on keyboard use
  }
  const setRating = (r: number) => applyMark({ ...mark, rating: mark.rating === r ? 0 : r });
  const toggleFlag = () => applyMark({ ...mark, flag: !mark.flag });

  async function sendTo(target: string, mode: SendMode) {
    setMenuMode(null);
    const acted = entry; // the photo at action time — frozen across the await
    const dest = shortenPath(target);
    setStatus(`${mode === "copy" ? "Copying" : "Moving"} to ${dest}…`);
    try {
      if (mode === "copy") {
        await copyToTarget(acted.path, target);
        setStatus(`Copied to ${dest}`);
      } else {
        await moveToTarget(acted.path, target);
        // The original left the folder: drop its (now-orphaned) mark and tile.
        void setMark(dir, acted.name, EMPTY_MARK).catch(() => {});
        onRemoved(acted.path);
        setStatus(`Moved to ${dest}`);
      }
    } catch (e) {
      setStatus(`${mode === "copy" ? "Copy" : "Move"} failed: ${String(e)}`);
    }
  }
  // The chooser lists the saved targets, then a final "Browse…" entry.
  const browseIndex = targets.length;
  const itemCount = targets.length + 1;
  const selIndex = Math.min(menuIndex, itemCount - 1);

  const cycleMenu = (delta: number) =>
    setMenuIndex((i) => (((i + delta) % itemCount) + itemCount) % itemCount);

  // "Browse…" — pick any folder via the native dialog, then send there.
  async function browseAndSend(mode: SendMode) {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") void sendTo(selected, mode);
  }

  function confirmSelection(mode: SendMode) {
    if (selIndex === browseIndex) void browseAndSend(mode);
    else void sendTo(targets[selIndex], mode);
  }

  // First press of C/M opens the destination chooser in that mode; pressing the
  // same key again (or Enter) acts on the highlighted entry — a saved target, or
  // "Browse…". So "C, C" copies fast and "M, M" moves fast, while ↑/↓ pick a
  // different destination in between.
  function requestSend(mode: SendMode) {
    setToolbarShown(true);
    if (menuMode === mode) confirmSelection(mode);
    else setMenuMode(mode);
  }

  async function doDelete() {
    const acted = entry;
    setConfirmingDelete(false);
    setStatus(`Deleting ${acted.name}…`);
    try {
      await deleteFile(acted.path);
      void setMark(dir, acted.name, EMPTY_MARK).catch(() => {});
      onRemoved(acted.path);
      setStatus(`Deleted ${acted.name}`);
    } catch (e) {
      setStatus(`Delete failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // While the destination chooser is open, ↑/↓ cycle it and Enter confirms.
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
          return;
        }
      } else if (e.key === "Escape") {
        // Escape backs out of a pending delete confirmation before closing.
        return confirmingDelete ? setConfirmingDelete(false) : onClose();
      }
      if (e.key === "ArrowLeft") return goPrev();
      if (e.key === "ArrowRight") return goNext();
      if (k === "c") return requestSend("copy");
      if (k === "m") return requestSend("move");
      if (k === "f") return toggleFlag();
      if (k === "0") return applyMark({ ...mark, rating: 0 });
      if (k >= "1" && k <= "5") return setRating(Number(k));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mark, targets, menuMode, menuIndex, confirmingDelete, hasPrev, hasNext, onClose, onIndex]);

  useGamepad((button) => {
    // Y mirrors the C key everywhere (open the copy chooser / confirm a copy).
    if (button === "y") return requestSend("copy");
    // In the chooser, the d-pad cycles destinations, A confirms, B cancels.
    if (menuMode) {
      if (button === "up") cycleMenu(-1);
      else if (button === "down") cycleMenu(1);
      else if (button === "a") confirmSelection(menuMode);
      else if (button === "b") setMenuMode(null);
      return;
    }
    if (button === "left" || button === "up") goPrev();
    else if (button === "right" || button === "down") goNext();
    else if (button === "b") onClose();
  });

  // Keep the current photo and its neighbours mounted so prev/next stay decoded.
  const window_ = [index - 1, index, index + 1].filter((i) => i >= 0 && i < entries.length);

  return (
    <div className="ph-lightbox">
      {window_.map((i) => (
        <Slide key={entries[i].path} entry={entries[i]} active={i === index} />
      ))}

      <button
        type="button"
        className={`ph-lb-close${edges.top ? "" : " ph-lb-chrome-hidden"}`}
        onClick={onClose}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>

      {hasPrev && (
        <button
          type="button"
          className={`ph-lb-nav ph-lb-prev${edges.left ? "" : " ph-lb-chrome-hidden"}`}
          onClick={goPrev}
          aria-label="Previous"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>
      )}
      {hasNext && (
        <button
          type="button"
          className={`ph-lb-nav ph-lb-next${edges.right ? "" : " ph-lb-chrome-hidden"}`}
          onClick={goNext}
          aria-label="Next"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      )}

      <div className={`ph-lb-bar${showInfo ? "" : " ph-lb-bar-hidden"}`}>
        <span className="ph-lb-count">
          {index + 1} / {entries.length}
        </span>
        <span className="ph-lb-name">{entry.name}</span>
      </div>

      {status && <div className="ph-lb-status">{status}</div>}

      {menuMode && (
        <div className="ph-lb-menu-backdrop" onClick={() => setMenuMode(null)}>
          <div className="ph-lb-menu" onClick={(e) => e.stopPropagation()}>
            <div className="ph-lb-menu-title">{menuMode === "copy" ? "Copy to…" : "Move to…"}</div>
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
            <div className="ph-lb-menu-hint">
              ↑↓ choose · Enter or {menuMode === "copy" ? "C" : "M"} to {menuMode}
            </div>
          </div>
        </div>
      )}

      <div className={`ph-lb-toolbar${showToolbar ? "" : " ph-lb-toolbar-hidden"}`}>
        <button type="button" className="ph-lb-tbtn" onClick={goPrev} disabled={!hasPrev} title="Previous (←)">
          <ChevronLeft className="h-5 w-5" />
        </button>

        <span className="ph-lb-tsep" />

        <button type="button" className="ph-lb-tbtn" onClick={() => requestSend("copy")} title="Copy to target location">
          <Copy className="h-4 w-4" />
          <span>Copy</span>
          <kbd>C</kbd>
        </button>
        <button type="button" className="ph-lb-tbtn" onClick={() => requestSend("move")} title="Move to target location">
          <FolderOutput className="h-4 w-4" />
          <span>Move</span>
          <kbd>M</kbd>
        </button>

        <span className="ph-lb-tsep" />

        <div className="ph-lb-marks" title="Rate 1–5 (press 0 to clear)">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`ph-lb-star${mark.rating >= n ? " ph-lb-star-on" : ""}`}
              onClick={() => setRating(n)}
              aria-label={`${n} star${n > 1 ? "s" : ""}`}
            >
              <Star className="h-4 w-4" />
            </button>
          ))}
        </div>

        <button
          type="button"
          className={`ph-lb-tbtn${mark.flag ? " ph-lb-tbtn-on" : ""}`}
          onClick={toggleFlag}
          title="Flag"
        >
          <Flag className="h-4 w-4" />
          <span>Flag</span>
          <kbd>F</kbd>
        </button>

        <span className="ph-lb-tsep" />

        {/* Delete morphs in place into a confirm/cancel panel — no hotkey, on purpose. */}
        <div className={`ph-lb-delete${confirmingDelete ? " ph-lb-delete-armed" : ""}`}>
          {confirmingDelete ? (
            <>
              <span className="ph-lb-delete-q">Delete?</span>
              <button type="button" className="ph-lb-delete-yes" onClick={doDelete} title="Confirm delete">
                <Check className="h-4 w-4" />
              </button>
              <button
                type="button"
                className="ph-lb-delete-no"
                onClick={() => setConfirmingDelete(false)}
                title="Cancel"
              >
                <X className="h-4 w-4" />
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ph-lb-tbtn"
              onClick={() => setConfirmingDelete(true)}
              title="Delete photo"
            >
              <Trash2 className="h-4 w-4" />
              <span>Delete</span>
            </button>
          )}
        </div>

        <span className="ph-lb-tsep" />

        <button type="button" className="ph-lb-tbtn" onClick={goNext} disabled={!hasNext} title="Next (→)">
          <ChevronRight className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}

/**
 * One photo in the kept-mounted window: a stretched thumbnail placeholder with
 * the full-resolution original fading in over it. Inactive slides stay mounted
 * (hidden) so their decoded original is retained for instant navigation.
 */
function Slide({ entry, active }: { entry: ImageEntry; active: boolean }) {
  const [fullLoaded, setFullLoaded] = useState(false);
  return (
    <div className={`ph-lb-slide${active ? " ph-lb-slide-active" : ""}`} aria-hidden={!active}>
      {/* Instant, stretched placeholder (cached grid thumbnail). */}
      <img
        src={thumbUrl(entry, 256)}
        alt=""
        aria-hidden
        className="ph-lb-img ph-lb-placeholder"
        draggable={false}
      />
      {/* The real, full-resolution photo — fades in once decoded. */}
      <img
        src={origUrl(entry)}
        alt={entry.name}
        className="ph-lb-img ph-lb-full"
        style={{ opacity: fullLoaded ? 1 : 0 }}
        draggable={false}
        onLoad={() => setFullLoaded(true)}
      />
      {active && !fullLoaded && (
        <div className="ph-lb-loading">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
    </div>
  );
}
