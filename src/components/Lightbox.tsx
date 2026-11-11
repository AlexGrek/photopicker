import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Flag,
  FolderOutput,
  Loader2,
  RotateCcw,
  RotateCw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { origUrl, thumbUrl, videoUrl, type ImageEntry } from "@/lib/thumbnails";
import { prefersReducedMotion } from "@/lib/photoScroll";
import { getExifInfo, overlayHasData, type ExifInfo, type ExifOverlay } from "@/lib/exif";
import { useGamepad } from "@/lib/gamepad";
import { hasCommandModifier, useWindowKeydown } from "@/lib/hooks";
import { lockPageScroll } from "@/lib/scrollLock";
import { baseName, plural, shortenPath } from "@/lib/utils";
import { updateConfig, useConfig } from "@/lib/config";
import { EMPTY_MARK, copyToTarget, deleteFile, getMarks, moveToTarget, rotateImage, setMark, type Mark } from "@/lib/marks";
import { DestinationChooser, useDestinationChooser, type SendMode } from "./DestinationChooser";

/** How close to an edge (px) the cursor must be to reveal that edge's controls. */
const EDGE_REVEAL_PX = 120;
/** How long the image counter stays up after switching photos, before fading. */
const INFO_FLASH_MS = 2200;
/**
 * How long a photo must stay current before its original starts loading. Key
 * repeat fires every ~30 ms, so while the user is flicking through photos with a
 * held arrow key nothing but thumbnails is read; the original is requested only
 * once they stop. (An `orig://` read of a huge file cannot be cancelled once the
 * backend has started it, so not starting it is the only real saving.)
 */
const NAV_SETTLE_MS = 90;
/** How long to rest on a photo — after it has loaded — before preloading its neighbours. */
const NEIGHBOUR_IDLE_MS = 300;

/**
 * Real fullscreen view of the **full-resolution** photo.
 *
 * While open it puts the OS window into fullscreen (no title bar / borders) and
 * the image fills the whole screen. Opening a 100 MP file off slow storage takes
 * a moment, so the cached grid thumbnail is shown first — stretched to fill the
 * screen — then the original streams in via `orig://` and fades in over it.
 *
 * The current photo and its immediate neighbours are kept mounted (see
 * {@link Slide}) so stepping to an already-decoded neighbour is instant. The
 * neighbours' originals are requested only after the current photo has finished
 * loading and the user has paused on it, so they never compete with it for a slow
 * card's bandwidth.
 *
 * A bottom toolbar (revealed when the cursor nears the bottom edge) carries the
 * culling controls: navigate, Copy to a target location, rate 1–5, flag. Marks
 * persist per photo. Arrow keys / chevrons / gamepad d-pad navigate; the toolbar
 * actions also have keyboard shortcuts (C, M, 1–5, F); Escape / the close button /
 * gamepad B exit.
 */
export function Lightbox({
  dir,
  entries,
  index,
  onIndex,
  onClose,
  onAnimateClose,
  onRemoved,
  onEntryUpdated,
  actionPathsByPath,
  selectionMode = false,
  selectedPaths,
  onToggleSelected,
  onSessionSent,
}: {
  dir: string;
  entries: ImageEntry[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** When set, close runs scroll + shrink-back instead of an instant dismiss. */
  onAnimateClose?: (info: {
    path: string;
    index: number;
    getSourceRect: () => DOMRect | null;
    imageSrc: string;
  }) => Promise<void>;
  /** Called with photo paths after they leave the directory (moved or deleted),
   *  so the host can drop that tile from the grid. */
  onRemoved: (paths: string[]) => void;
  /** Called after in-place metadata edits (e.g. rotation) to refresh cache version. */
  onEntryUpdated: (path: string, modified: number | null) => void;
  /** Optional action override (e.g. RAW coupling) keyed by visible entry path. */
  actionPathsByPath: Record<string, string[]>;
  /** Gallery selection mode — shows a select toggle in the toolbar. */
  selectionMode?: boolean;
  selectedPaths?: ReadonlySet<string>;
  onToggleSelected?: (path: string) => void;
  /** Called after a successful copy or move (tracks visible entry path). */
  onSessionSent?: (paths: string[]) => void;
}) {
  const entry = entries[index];
  const isSelected = selectedPaths?.has(entry.path) ?? false;

  const config = useConfig();
  const lightboxInFullscreen = config?.lightboxInFullscreen ?? null;
  const exifOverlayEnabled = config?.exifOverlayEnabled ?? false;

  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [toolbarShown, setToolbarShown] = useState(false);
  const [edges, setEdges] = useState({ top: false, left: false, right: false });
  const [infoFlash, setInfoFlash] = useState(true); // counter shows on open + after switching
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [rotateNonceByPath, setRotateNonceByPath] = useState<Record<string, number>>({});
  const [exifModalOpen, setExifModalOpen] = useState(false);
  const [exif, setExif] = useState<{ path: string; info: ExifInfo | null } | null>(null);
  const [exifLoading, setExifLoading] = useState(false);
  const [savingExifOverlay, setSavingExifOverlay] = useState(false);
  const [exiting, setExiting] = useState(false);
  const closingRef = useRef(false);

  // Loading schedule (see NAV_SETTLE_MS / NEIGHBOUR_IDLE_MS). `settledPath` starts
  // as the opening photo, so the photo the user clicked loads without any delay.
  const [settledPath, setSettledPath] = useState(entry.path);
  const [idlePath, setIdlePath] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const chooser = useDestinationChooser((target, mode) => void sendTo(target, mode));
  const menuMode = chooser.mode;

  const mark = marks[entry.name] ?? EMPTY_MARK;
  const showToolbar = !exiting && (toolbarShown || menuMode !== null || confirmingDelete || exifModalOpen);
  const rotateNonce = rotateNonceByPath[entry.path] ?? 0;
  const showInfo = !exiting && (infoFlash || toolbarShown);
  // Only ever show EXIF that belongs to the photo on screen.
  const exifInfo = exif?.path === entry.path ? exif.info : null;

  const settled = settledPath === entry.path;
  const activeKey = slideKey(entry.path, rotateNonce);
  const preloadNeighbours = idlePath === entry.path && (entry.video || loadedKey === activeKey);

  useEffect(() => {
    const path = entry.path;
    const settle = setTimeout(() => setSettledPath(path), NAV_SETTLE_MS);
    const idle = setTimeout(() => setIdlePath(path), NEIGHBOUR_IDLE_MS);
    return () => {
      clearTimeout(settle);
      clearTimeout(idle);
    };
  }, [entry.path]);

  // Freeze the page underneath: the gallery scrolls the document, and a wheel or
  // arrow-key gesture over the lightbox must not move the grid behind it.
  const unlockScrollRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    const unlock = lockPageScroll();
    unlockScrollRef.current = unlock;
    return unlock;
  }, []);

  function getActiveImageRect(): DOMRect | null {
    const slide = document.querySelector(".ph-lb-slide-active");
    if (!slide) return null;
    const full = slide.querySelector(".ph-lb-full") as HTMLImageElement | null;
    const placeholder = slide.querySelector(".ph-lb-placeholder") as HTMLImageElement | null;
    const img = full && full.naturalWidth > 0 ? full : (placeholder ?? full);
    return img?.getBoundingClientRect() ?? null;
  }

  async function handleClose() {
    if (closingRef.current || exiting) return;
    closingRef.current = true;
    try {
      if (onAnimateClose && !prefersReducedMotion() && !entry.video) {
        setExiting(true);
        chooser.close();
        setConfirmingDelete(false);
        setExifModalOpen(false);

        if (lightboxInFullscreen) {
          try {
            await getCurrentWindow().setFullscreen(false);
          } catch {
            /* still animate back to the tile */
          }
        }

        // The close animation scrolls the grid to the photo's tile and measures it,
        // so the page has to be scrollable (and laid out normally) again first.
        unlockScrollRef.current?.();

        // Same URL the grid tile uses, so the flying clone paints from the image
        // cache instead of waiting on a fresh read from slow storage.
        const imageSrc = thumbUrl(entry, 256, rotateNonce);
        await onAnimateClose({
          path: entry.path,
          index,
          getSourceRect: getActiveImageRect,
          imageSrc,
        });
        return;
      }
      onClose();
    } finally {
      closingRef.current = false;
    }
  }

  // Load this directory's saved marks.
  useEffect(() => {
    let alive = true;
    getMarks(dir).then(
      (m) => alive && setMarks(m),
      () => alive && setMarks({}),
    );
    return () => {
      alive = false;
    };
  }, [dir]);

  // Load EXIF when the modal is open or the always-on overlay is enabled — but
  // only once the user has settled on a photo, not for every one flicked past.
  useEffect(() => {
    if (!exifModalOpen && !exifOverlayEnabled) {
      setExif(null);
      setExifLoading(false);
      return;
    }
    if (!settled) return;
    const path = entry.path;
    let alive = true;
    setExifLoading(true);
    getExifInfo(path)
      .then((info) => {
        if (alive) setExif({ path, info });
      })
      .catch(() => {
        if (alive) setExif({ path, info: null });
      })
      .finally(() => {
        if (alive) setExifLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [entry.path, exifModalOpen, exifOverlayEnabled, rotateNonce, settled]);

  // Drive the OS window into fullscreen for as long as the lightbox is open,
  // restoring the previous state on close (unless the user was already fullscreen).
  useEffect(() => {
    if (lightboxInFullscreen !== true) return;
    const win = getCurrentWindow();
    let cancelled = false;
    let enteredFullscreen = false;
    (async () => {
      try {
        const wasFullscreen = await win.isFullscreen();
        if (!cancelled && !wasFullscreen) {
          await win.setFullscreen(true);
          enteredFullscreen = true;
        }
      } catch {
        /* fullscreen not permitted — the overlay still fills the window */
      }
    })();
    return () => {
      cancelled = true;
      if (enteredFullscreen) void win.setFullscreen(false).catch(() => {});
    };
  }, [lightboxInFullscreen]);

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
    setExifModalOpen(false);
    const t = setTimeout(() => setInfoFlash(false), INFO_FLASH_MS);
    return () => clearTimeout(t);
  }, [index]);

  async function toggleExifOverlay(next: boolean) {
    if (savingExifOverlay) return;
    setSavingExifOverlay(true);
    try {
      await updateConfig({ exifOverlayEnabled: next });
    } catch {
      /* updateConfig restored the saved value */
    } finally {
      setSavingExifOverlay(false);
    }
  }

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
  const actionPathsFor = (e: ImageEntry) => actionPathsByPath[e.path] ?? [e.path];
  const canRotate = !entry.raw && !entry.video;

  async function rotateCurrent(clockwise: boolean) {
    if (!canRotate) return;
    try {
      const res = await rotateImage(entry.path, clockwise);
      onEntryUpdated(entry.path, res.modified);
      setRotateNonceByPath((prev) => ({ ...prev, [entry.path]: (prev[entry.path] ?? 0) + 1 }));
      setStatus(`Rotated ${clockwise ? "clockwise" : "counter-clockwise"}`);
    } catch (e) {
      setStatus(`Rotate failed: ${String(e)}`);
    }
  }

  function applyMark(next: Mark) {
    setMarks((m) => ({ ...m, [entry.name]: next }));
    void setMark(dir, entry.name, next).catch(() => {});
    setToolbarShown(true); // keep visible so the change is seen on keyboard use
  }
  const setRating = (r: number) => applyMark({ ...mark, rating: mark.rating === r ? 0 : r });
  const toggleFlag = () => applyMark({ ...mark, flag: !mark.flag });
  const toggleSelected = () => onToggleSelected?.(entry.path);

  /** Marks live outside the photos, so a file that left the folder leaves an orphan to clear. */
  function clearMarksFor(paths: string[]) {
    for (const path of paths) void setMark(dir, baseName(path), EMPTY_MARK).catch(() => {});
  }

  async function sendTo(target: string, mode: SendMode) {
    const acted = entry; // the photo at action time — frozen across the await
    const actedPaths = actionPathsFor(acted);
    const dest = shortenPath(target);
    const files = plural(actedPaths.length, "file");
    setStatus(`${mode === "copy" ? "Copying" : "Moving"} ${files} to ${dest}…`);
    try {
      if (mode === "copy") {
        for (const path of actedPaths) {
          await copyToTarget(path, target);
        }
        onSessionSent?.([acted.path]);
        setStatus(`Copied ${files} to ${dest}`);
      } else {
        for (const path of actedPaths) {
          await moveToTarget(path, target);
        }
        onSessionSent?.([acted.path]);
        // Moved files left the folder: drop their marks and tiles.
        clearMarksFor(actedPaths);
        onRemoved(actedPaths);
        setStatus(`Moved ${files} to ${dest}`);
      }
    } catch (e) {
      setStatus(`${mode === "copy" ? "Copy" : "Move"} failed: ${String(e)}`);
    }
  }

  // First press of C/M opens the destination chooser in that mode; pressing the
  // same key again (or Enter) acts on the highlighted entry — a saved target, or
  // "Browse…". So "C, C" copies fast and "M, M" moves fast, while ↑/↓ pick a
  // different destination in between.
  function requestSend(mode: SendMode) {
    setToolbarShown(true);
    chooser.request(mode);
  }

  async function doDelete() {
    const acted = entry;
    const actedPaths = actionPathsFor(acted);
    const files = plural(actedPaths.length, "file");
    setConfirmingDelete(false);
    setStatus(`Deleting ${files}…`);
    try {
      for (const path of actedPaths) {
        await deleteFile(path);
      }
      clearMarksFor(actedPaths);
      onRemoved(actedPaths);
      setStatus(`Deleted ${files}`);
    } catch (e) {
      setStatus(`Delete failed: ${String(e)}`);
    }
  }

  useWindowKeydown((e) => {
    // Leave OS / webview shortcuts (Ctrl+C, Cmd+M, Alt+F4 …) alone.
    if (hasCommandModifier(e)) return;
    const k = e.key.toLowerCase();
    if (exifModalOpen) {
      if (e.key === "Escape") setExifModalOpen(false);
      return;
    }
    // While the destination chooser is open, ↑/↓ cycle it and Enter confirms.
    if (chooser.handleKey(e)) return;
    if (e.key === "Escape") {
      // Escape backs out of a pending delete confirmation before closing.
      return confirmingDelete ? setConfirmingDelete(false) : void handleClose();
    }
    if (e.key === "ArrowLeft") return void goPrev();
    if (e.key === "ArrowRight") return void goNext();
    if (k === "c") return requestSend("copy");
    if (k === "m") return requestSend("move");
    if (k === "f") return toggleFlag();
    if (selectionMode && k === "s") return toggleSelected();
    if (k === "0") return applyMark({ ...mark, rating: 0 });
    if (k >= "1" && k <= "5") return setRating(Number(k));
  });

  useGamepad((button) => {
    if (exifModalOpen) {
      if (button === "b") setExifModalOpen(false);
      return;
    }
    // Y mirrors the C key everywhere (open the copy chooser / confirm a copy).
    if (button === "y") return requestSend("copy");
    if (selectionMode && button === "x") return toggleSelected();
    if (button === "lb") return void rotateCurrent(false);
    if (button === "rb") return void rotateCurrent(true);
    // In the chooser, the d-pad cycles destinations, A confirms, B cancels.
    if (chooser.handleGamepad(button)) return;
    if (button === "left" || button === "up") goPrev();
    else if (button === "right" || button === "down") goNext();
    else if (button === "b") {
      // B backs out of a pending delete confirmation before closing, like Escape.
      if (confirmingDelete) setConfirmingDelete(false);
      else void handleClose();
    }
  });

  // Keep the current photo and its neighbours mounted so prev/next stay decoded.
  const window_ = [index - 1, index, index + 1].filter((i) => i >= 0 && i < entries.length);

  return (
    <div className={`ph-lightbox${exiting ? " ph-lightbox-exiting" : ""}`}>
      {window_.map((i) => (
        <Slide
          key={entries[i].path}
          entry={entries[i]}
          active={i === index}
          load={i === index ? settled : preloadNeighbours}
          nonce={rotateNonceByPath[entries[i].path] ?? 0}
          overlay={exifOverlayEnabled && i === index && !entries[i].video ? exifInfo?.overlay ?? null : null}
          onFullLoaded={setLoadedKey}
        />
      ))}

      {!exiting && (
        <button
          type="button"
          className={`ph-lb-close${edges.top ? "" : " ph-lb-chrome-hidden"}`}
          onClick={() => void handleClose()}
          aria-label="Close"
        >
          <X className="h-5 w-5" />
        </button>
      )}

      {!exiting && hasPrev && (
        <button
          type="button"
          className={`ph-lb-nav ph-lb-prev${edges.left ? "" : " ph-lb-chrome-hidden"}`}
          onClick={goPrev}
          aria-label="Previous"
        >
          <ChevronLeft className="h-7 w-7" />
        </button>
      )}
      {!exiting && hasNext && (
        <button
          type="button"
          className={`ph-lb-nav ph-lb-next${edges.right ? "" : " ph-lb-chrome-hidden"}`}
          onClick={goNext}
          aria-label="Next"
        >
          <ChevronRight className="h-7 w-7" />
        </button>
      )}

      {!exiting && (
        <div className={`ph-lb-bar${showInfo ? "" : " ph-lb-bar-hidden"}`}>
          <span className="ph-lb-count">
            {index + 1} / {entries.length}
          </span>
          <span className="ph-lb-name">{entry.name}</span>
        </div>
      )}

      {!exiting && status && <div className="ph-lb-status">{status}</div>}

      {!exiting && exifModalOpen && (
        <div className="ph-lb-exif-backdrop" onClick={() => setExifModalOpen(false)}>
          <div className="ph-lb-exif-panel" onClick={(e) => e.stopPropagation()}>
            <div className="ph-lb-exif-header">
              <span className="ph-lb-exif-title">EXIF</span>
              <button
                type="button"
                className="ph-lb-exif-close"
                onClick={() => setExifModalOpen(false)}
                aria-label="Close EXIF"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="ph-lb-exif-toggle-row">
              <span>Enable EXIF overlay</span>
              <button
                type="button"
                role="switch"
                aria-checked={exifOverlayEnabled}
                className={`ph-lb-exif-toggle${exifOverlayEnabled ? " ph-lb-exif-toggle-on" : ""}`}
                disabled={savingExifOverlay}
                onClick={() => void toggleExifOverlay(!exifOverlayEnabled)}
              >
                <span className="ph-lb-exif-toggle-knob" />
              </button>
            </label>
            <div className="ph-lb-exif-body">
              {exifLoading ? (
                <div className="ph-lb-exif-loading">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </div>
              ) : !exifInfo?.fields.length ? (
                <p className="ph-lb-exif-empty">No EXIF data found for this file.</p>
              ) : (
                <table className="ph-lb-exif-table">
                  <tbody>
                    {exifInfo.fields.map((f) => (
                      <tr key={f.label}>
                        <th scope="row">{f.label}</th>
                        <td>{f.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {!exiting && menuMode && (
        <DestinationChooser
          chooser={chooser}
          title={menuMode === "copy" ? "Copy to…" : "Move to…"}
          hint={`↑↓ choose · Enter or ${menuMode === "copy" ? "C" : "M"} to ${menuMode}`}
          backdropClassName="ph-lb-menu-backdrop"
        />
      )}

      {!exiting && (
        <div className={`ph-lb-toolbar${showToolbar ? "" : " ph-lb-toolbar-hidden"}`}>
        <button type="button" className="ph-lb-tbtn" onClick={goPrev} disabled={!hasPrev} title="Previous (←)">
          <ChevronLeft className="h-5 w-5" />
        </button>

        <span className="ph-lb-tsep" />

        {selectionMode && (
          <>
            <button
              type="button"
              className={`ph-lb-tbtn ph-lb-select${isSelected ? " ph-lb-tbtn-on" : ""}`}
              onClick={toggleSelected}
              title={isSelected ? "Deselect (S)" : "Select (S)"}
              aria-pressed={isSelected}
              aria-label={isSelected ? "Deselect photo" : "Select photo"}
            >
              <span className={`ph-lb-select-box${isSelected ? " ph-lb-select-box-on" : ""}`} aria-hidden>
                {isSelected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
              </span>
              <span>{isSelected ? "Selected" : "Select"}</span>
              <kbd>S</kbd>
            </button>
            <span className="ph-lb-tsep" />
          </>
        )}

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

        <button
          type="button"
          className={`ph-lb-tbtn${exifModalOpen ? " ph-lb-tbtn-on" : ""}`}
          onClick={() => {
            setToolbarShown(true);
            setExifModalOpen(true);
          }}
          title="EXIF info"
          aria-label="EXIF info"
        >
          <Camera className="h-4 w-4" />
        </button>

        <button
          type="button"
          className="ph-lb-tbtn"
          onClick={() => rotateCurrent(false)}
          disabled={!canRotate}
          title="Rotate counter-clockwise"
          aria-label="Rotate counter-clockwise"
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="ph-lb-tbtn"
          onClick={() => rotateCurrent(true)}
          disabled={!canRotate}
          title="Rotate clockwise"
          aria-label="Rotate clockwise"
        >
          <RotateCw className="h-4 w-4" />
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
      )}
    </div>
  );
}

/** Identifies one loaded image: a photo at a particular rotation. */
function slideKey(path: string, nonce: number): string {
  return `${path}#${nonce}`;
}

const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const GESTURE_ZOOM_SENSITIVITY = 0.015;

/** Zoom factor plus pan offset (px) of a slide. */
interface View {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY_VIEW: View = { scale: 1, x: 0, y: 0 };

/** Clamps a view to the zoom range, and its pan so the image cannot leave `container`. */
function clampView(container: HTMLElement | null, scale: number, x: number, y: number): View {
  const s = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  if (!container || s <= 1) return s === 1 ? IDENTITY_VIEW : { scale: s, x: 0, y: 0 };
  const boundX = ((s - 1) * container.clientWidth) / 2;
  const boundY = ((s - 1) * container.clientHeight) / 2;
  return {
    scale: s,
    x: Math.min(boundX, Math.max(-boundX, x)),
    y: Math.min(boundY, Math.max(-boundY, y)),
  };
}

/**
 * One photo in the kept-mounted window: a stretched thumbnail placeholder with
 * the full-resolution original fading in over it. Inactive slides stay mounted
 * (hidden) so their decoded original is retained for instant navigation.
 *
 * The original is requested only once `load` is true (the host decides when — see
 * {@link Lightbox}); from then on it stays, so a photo that was current keeps its
 * decoded image when it becomes a neighbour. When the slide leaves the window the
 * request is aborted, so an original the user has moved away from stops loading.
 */
function Slide({
  entry,
  active,
  load,
  nonce,
  overlay,
  onFullLoaded,
}: {
  entry: ImageEntry;
  active: boolean;
  /** Whether the original may start loading now. */
  load: boolean;
  nonce: number;
  overlay: ExifOverlay | null;
  /** Reports the {@link slideKey} of the active slide once its original is on screen. */
  onFullLoaded: (key: string) => void;
}) {
  const [started, setStarted] = useState(load);
  if (load && !started) setStarted(true);

  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const [dragState, setDragState] = useState<{
    id: number;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The placeholder reuses the grid tile's exact URL, so it comes from the cache.
  const thumbSrc = thumbUrl(entry, 256, nonce);
  const fullSrc = entry.raw ? thumbUrl(entry, 2048, nonce) : origUrl(entry, nonce);
  const fullLoaded = loadedSrc === fullSrc;
  const loadKey = slideKey(entry.path, nonce);

  // Abort the (possibly multi-megabyte) request when this slide unmounts: without
  // this the webview keeps downloading an original nobody is going to look at.
  const abortOnUnmount = useCallback((node: HTMLImageElement | null) => {
    if (!node) return;
    return () => node.removeAttribute("src");
  }, []);

  useEffect(() => {
    if (active && fullLoaded) onFullLoaded(loadKey);
  }, [active, fullLoaded, loadKey, onFullLoaded]);

  // A different image (or rotation) starts un-zoomed; so does a slide that is
  // no longer the one on screen.
  useEffect(() => {
    setView(IDENTITY_VIEW);
    setDragState(null);
  }, [entry.path, nonce, active]);

  useEffect(() => {
    const onResize = () => setView((v) => clampView(containerRef.current, v.scale, v.x, v.y));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Wheel / pinch zoom. These are native listeners because they must be able to
  // `preventDefault()`: React attaches `wheel` passively, where that is a no-op.
  useEffect(() => {
    if (!active) return;
    const node = containerRef.current;
    if (!node) return;

    type GestureEventLike = Event & { scale?: number };

    // Functional update: several wheel events can arrive within one frame, and
    // each must build on the previous one rather than on a stale render's scale.
    const zoomBy = (delta: number) => {
      if (delta !== 0) setView((v) => clampView(node, v.scale * (1 + delta), v.x, v.y));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(-e.deltaY * WHEEL_ZOOM_SENSITIVITY);
    };
    const onGestureStart = (ev: Event) => {
      ev.preventDefault();
    };
    const onGestureChange = (ev: Event) => {
      const e = ev as GestureEventLike;
      if (typeof e.scale !== "number") return;
      ev.preventDefault();
      zoomBy((e.scale - 1) * GESTURE_ZOOM_SENSITIVITY);
    };
    const onGestureEnd = (ev: Event) => {
      ev.preventDefault();
    };

    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("gesturestart", onGestureStart, { passive: false });
    node.addEventListener("gesturechange", onGestureChange, { passive: false });
    node.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("gesturestart", onGestureStart);
      node.removeEventListener("gesturechange", onGestureChange);
      node.removeEventListener("gestureend", onGestureEnd);
    };
  }, [active]);

  const zoomed = view.scale > 1.01;
  const dragging = dragState !== null;
  const transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;

  // Videos play natively with the webview's media element (with built-in controls).
  // Only the active slide mounts the <video> so neighbours don't preload/autoplay.
  if (entry.video) {
    return (
      <div
        className={`ph-lb-slide${active ? " ph-lb-slide-active" : ""}`}
        aria-hidden={!active}
      >
        {active && (
          <video
            key={entry.path}
            className="ph-lb-video"
            src={videoUrl(entry)}
            controls
            autoPlay
            playsInline
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`ph-lb-slide${active ? " ph-lb-slide-active" : ""}${zoomed ? " ph-lb-slide-zoomed" : ""}${dragging ? " ph-lb-slide-dragging" : ""}`}
      aria-hidden={!active}
      onDoubleClick={() => {
        if (!active) return;
        setView(zoomed ? IDENTITY_VIEW : clampView(containerRef.current, 2, 0, 0));
      }}
      onPointerDown={(e) => {
        if (!active || !zoomed || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragState({
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startOffsetX: view.x,
          startOffsetY: view.y,
        });
      }}
      onPointerMove={(e) => {
        if (!dragState || dragState.id !== e.pointerId) return;
        const x = dragState.startOffsetX + e.clientX - dragState.startX;
        const y = dragState.startOffsetY + e.clientY - dragState.startY;
        setView((v) => clampView(containerRef.current, v.scale, x, y));
      }}
      onPointerUp={(e) => {
        if (!dragState || dragState.id !== e.pointerId) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragState(null);
      }}
      onPointerCancel={(e) => {
        if (!dragState || dragState.id !== e.pointerId) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        setDragState(null);
      }}
      style={{ touchAction: "none" }}
    >
      {/* Instant, stretched placeholder (cached grid thumbnail). */}
      <img
        src={thumbSrc}
        alt=""
        aria-hidden
        className="ph-lb-img ph-lb-placeholder"
        style={{ transform }}
        draggable={false}
      />
      {/* The real, full-resolution photo — fades in once decoded. */}
      {started && (
        <img
          ref={abortOnUnmount}
          src={fullSrc}
          alt={entry.name}
          className="ph-lb-img ph-lb-full"
          style={{ opacity: fullLoaded ? 1 : 0, transform }}
          draggable={false}
          onLoad={() => setLoadedSrc(fullSrc)}
        />
      )}
      {active && !fullLoaded && (
        <div className="ph-lb-loading">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {active && overlay && overlayHasData(overlay) && (
        <div className="ph-lb-exif-overlay" aria-hidden>
          {overlay.lens && <span>{overlay.lens}</span>}
          {(overlay.focalLength || overlay.aperture || overlay.shutter || overlay.iso || overlay.focusDistance) && (
            <span>
              {[overlay.focalLength, overlay.aperture, overlay.shutter, overlay.iso, overlay.focusDistance]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
