import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Flag,
  FolderInput,
  FolderOutput,
  FolderSearch,
  Loader2,
  RotateCcw,
  RotateCw,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { origUrl, thumbUrl, type ImageEntry } from "@/lib/thumbnails";
import { prefersReducedMotion } from "@/lib/photoScroll";
import { getExifInfo, overlayHasData, type ExifInfo, type ExifOverlay } from "@/lib/exif";
import { useGamepad } from "@/lib/gamepad";
import { shortenPath } from "@/lib/utils";
import { type Config, menuIndexForConfig, persistLastTargetDirectory } from "@/lib/config";
import { EMPTY_MARK, copyToTarget, deleteFile, getMarks, moveToTarget, rotateImage, setMark, type Mark } from "@/lib/marks";

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
  onAnimateClose,
  onRemoved,
  onEntryUpdated,
  actionPathsByPath,
  selectionMode = false,
  selectedPaths,
  onToggleSelected,
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
}) {
  const entry = entries[index];
  const isSelected = selectedPaths?.has(entry.path) ?? false;

  const [marks, setMarks] = useState<Record<string, Mark>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [toolbarShown, setToolbarShown] = useState(false);
  const [edges, setEdges] = useState({ top: false, left: false, right: false });
  const [infoFlash, setInfoFlash] = useState(true); // counter shows on open + after switching
  const [menuMode, setMenuMode] = useState<SendMode | null>(null);
  const [menuIndex, setMenuIndex] = useState(0); // highlighted destination in the chooser
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [lightboxInFullscreen, setLightboxInFullscreen] = useState<boolean | null>(null);
  const [rotateNonceByPath, setRotateNonceByPath] = useState<Record<string, number>>({});
  const [exifModalOpen, setExifModalOpen] = useState(false);
  const [exifInfo, setExifInfo] = useState<ExifInfo | null>(null);
  const [exifLoading, setExifLoading] = useState(false);
  const [exifOverlayEnabled, setExifOverlayEnabled] = useState(false);
  const [savingExifOverlay, setSavingExifOverlay] = useState(false);
  const [exiting, setExiting] = useState(false);
  const closingRef = useRef(false);

  const mark = marks[entry.name] ?? EMPTY_MARK;
  const showToolbar = !exiting && (toolbarShown || menuMode !== null || confirmingDelete || exifModalOpen);
  const rotateNonce = rotateNonceByPath[entry.path] ?? 0;
  const showInfo = !exiting && (infoFlash || toolbarShown);

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
      if (onAnimateClose && !prefersReducedMotion()) {
        setExiting(true);
        setMenuMode(null);
        setConfirmingDelete(false);
        setExifModalOpen(false);

        if (lightboxInFullscreen) {
          try {
            await getCurrentWindow().setFullscreen(false);
          } catch {
            /* still animate back to the tile */
          }
        }

        const imageSrc = `${thumbUrl(entry, 512)}&r=${rotateNonce}`;
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

  // Load this directory's saved marks + the configured copy targets.
  useEffect(() => {
    let alive = true;
    getMarks(dir).then(
      (m) => alive && setMarks(m),
      () => alive && setMarks({}),
    );
    invoke<Config>("get_config").then(
      (cfg) => {
        if (!alive) return;
        setTargets(cfg.targetDirectories);
        setMenuIndex(menuIndexForConfig(cfg));
        setLightboxInFullscreen(cfg.lightboxInFullscreen);
        setExifOverlayEnabled(cfg.exifOverlayEnabled);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [dir]);

  // Load EXIF when the modal is open or the always-on overlay is enabled.
  useEffect(() => {
    if (!exifModalOpen && !exifOverlayEnabled) {
      setExifInfo(null);
      setExifLoading(false);
      return;
    }
    let alive = true;
    setExifLoading(true);
    getExifInfo(entry.path)
      .then((info) => {
        if (alive) setExifInfo(info);
      })
      .catch(() => {
        if (alive) setExifInfo(null);
      })
      .finally(() => {
        if (alive) setExifLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [entry.path, exifModalOpen, exifOverlayEnabled, rotateNonce]);

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
    setExifOverlayEnabled(next);
    try {
      const cfg = await invoke<Config>("get_config");
      const updated: Config = { ...cfg, exifOverlayEnabled: next };
      await invoke("save_config", { config: updated });
    } catch {
      setExifOverlayEnabled((prev) => !prev);
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
  const canRotate = !entry.raw;

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

  async function sendTo(target: string, mode: SendMode) {
    setMenuMode(null);
    persistLastTargetDirectory(target);
    const acted = entry; // the photo at action time — frozen across the await
    const actedPaths = actionPathsFor(acted);
    const dest = shortenPath(target);
    setStatus(`${mode === "copy" ? "Copying" : "Moving"} ${actedPaths.length} file${actedPaths.length === 1 ? "" : "s"} to ${dest}…`);
    try {
      if (mode === "copy") {
        for (const path of actedPaths) {
          await copyToTarget(path, target);
        }
        setStatus(`Copied ${actedPaths.length} file${actedPaths.length === 1 ? "" : "s"} to ${dest}`);
      } else {
        for (const path of actedPaths) {
          await moveToTarget(path, target);
        }
        // Moved files left the folder: drop their marks and tiles.
        for (const path of actedPaths) {
          const name = path.split(/[/\\]/).pop();
          if (name) void setMark(dir, name, EMPTY_MARK).catch(() => {});
        }
        onRemoved(actedPaths);
        setStatus(`Moved ${actedPaths.length} file${actedPaths.length === 1 ? "" : "s"} to ${dest}`);
      }
    } catch (e) {
      setStatus(`${mode === "copy" ? "Copy" : "Move"} failed: ${String(e)}`);
    }
  }
  // The chooser lists the saved targets, then a final "Browse…" entry.
  const browseIndex = targets.length;
  const itemCount = targets.length + 1;
  const selIndex = Math.min(menuIndex, itemCount - 1);

  const cycleMenu = (delta: number) => {
    const next = (((menuIndex + delta) % itemCount) + itemCount) % itemCount;
    setMenuIndex(next);
    if (next < targets.length) persistLastTargetDirectory(targets[next]);
  };

  // "Browse…" — pick any folder via the native dialog, then send there.
  async function browseAndSend(mode: SendMode) {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    try {
      const cfg = await invoke<Config>("add_target_directory", { dir: selected });
      setTargets(cfg.targetDirectories);
      const idx = cfg.targetDirectories.findIndex((d) => d === selected);
      if (idx >= 0) setMenuIndex(idx);
    } catch {
      // If persisting the target fails, still allow this one-off send.
    }
    void sendTo(selected, mode);
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
    const actedPaths = actionPathsFor(acted);
    setConfirmingDelete(false);
    setStatus(`Deleting ${actedPaths.length} file${actedPaths.length === 1 ? "" : "s"}…`);
    try {
      for (const path of actedPaths) {
        await deleteFile(path);
      }
      for (const path of actedPaths) {
        const name = path.split(/[/\\]/).pop();
        if (name) void setMark(dir, name, EMPTY_MARK).catch(() => {});
      }
      onRemoved(actedPaths);
      setStatus(`Deleted ${actedPaths.length} file${actedPaths.length === 1 ? "" : "s"}`);
    } catch (e) {
      setStatus(`Delete failed: ${String(e)}`);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (exifModalOpen) {
        if (e.key === "Escape") return setExifModalOpen(false);
        return;
      }
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
        return confirmingDelete ? setConfirmingDelete(false) : void handleClose();
      }
      if (e.key === "ArrowLeft") return goPrev();
      if (e.key === "ArrowRight") return goNext();
      if (k === "c") return requestSend("copy");
      if (k === "m") return requestSend("move");
      if (k === "f") return toggleFlag();
      if (selectionMode && k === "s") return toggleSelected();
      if (k === "0") return applyMark({ ...mark, rating: 0 });
      if (k >= "1" && k <= "5") return setRating(Number(k));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, mark, targets, menuMode, menuIndex, confirmingDelete, exifModalOpen, hasPrev, hasNext, onClose, onIndex]);

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
    if (menuMode) {
      if (button === "up") cycleMenu(-1);
      else if (button === "down") cycleMenu(1);
      else if (button === "a") confirmSelection(menuMode);
      else if (button === "b") setMenuMode(null);
      return;
    }
    if (button === "left" || button === "up") goPrev();
    else if (button === "right" || button === "down") goNext();
    else if (button === "b") void handleClose();
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
          nonce={rotateNonceByPath[entries[i].path] ?? 0}
          overlay={exifOverlayEnabled && i === index ? exifInfo?.overlay ?? null : null}
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

/**
 * One photo in the kept-mounted window: a stretched thumbnail placeholder with
 * the full-resolution original fading in over it. Inactive slides stay mounted
 * (hidden) so their decoded original is retained for instant navigation.
 */
function Slide({
  entry,
  active,
  nonce,
  overlay,
}: {
  entry: ImageEntry;
  active: boolean;
  nonce: number;
  overlay: ExifOverlay | null;
}) {
  const MIN_ZOOM = 1;
  const MAX_ZOOM = 8;
  const WHEEL_ZOOM_SENSITIVITY = 0.0015;
  const GESTURE_ZOOM_SENSITIVITY = 0.015;

  const [fullLoaded, setFullLoaded] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragState, setDragState] = useState<{
    id: number;
    startX: number;
    startY: number;
    startOffsetX: number;
    startOffsetY: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const thumbSrc = `${thumbUrl(entry, 256)}&r=${nonce}`;
  const fullSrc = entry.raw ? `${thumbUrl(entry, 2048)}&r=${nonce}` : `${origUrl(entry)}?r=${nonce}`;

  function clampScale(next: number) {
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
  }

  function panBounds(nextScale: number) {
    const el = containerRef.current;
    if (!el || nextScale <= 1) return { x: 0, y: 0 };
    const x = ((nextScale - 1) * el.clientWidth) / 2;
    const y = ((nextScale - 1) * el.clientHeight) / 2;
    return { x, y };
  }

  function clampOffset(nextOffset: { x: number; y: number }, nextScale: number) {
    const bounds = panBounds(nextScale);
    return {
      x: Math.min(bounds.x, Math.max(-bounds.x, nextOffset.x)),
      y: Math.min(bounds.y, Math.max(-bounds.y, nextOffset.y)),
    };
  }

  function applyScale(nextScale: number) {
    const clampedScale = clampScale(nextScale);
    setScale(clampedScale);
    setOffset((prev) => clampOffset(clampedScale <= 1 ? { x: 0, y: 0 } : prev, clampedScale));
  }

  function zoomBy(delta: number) {
    if (!active) return;
    applyScale(scale * (1 + delta));
  }

  useEffect(() => {
    setFullLoaded(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setDragState(null);
  }, [entry.path, nonce]);

  useEffect(() => {
    if (active) return;
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setDragState(null);
  }, [active]);

  useEffect(() => {
    const onResize = () => setOffset((prev) => clampOffset(prev, scale));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [scale]);

  useEffect(() => {
    if (!active) return;
    const node = containerRef.current;
    if (!node) return;

    type GestureEventLike = Event & { scale?: number };

    const onGestureStart = (ev: Event) => {
      ev.preventDefault();
    };
    const onGestureChange = (ev: Event) => {
      const e = ev as GestureEventLike;
      if (typeof e.scale !== "number") return;
      ev.preventDefault();
      const delta = (e.scale - 1) * GESTURE_ZOOM_SENSITIVITY;
      if (delta !== 0) zoomBy(delta);
    };
    const onGestureEnd = (ev: Event) => {
      ev.preventDefault();
    };

    node.addEventListener("gesturestart", onGestureStart, { passive: false });
    node.addEventListener("gesturechange", onGestureChange, { passive: false });
    node.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      node.removeEventListener("gesturestart", onGestureStart);
      node.removeEventListener("gesturechange", onGestureChange);
      node.removeEventListener("gestureend", onGestureEnd);
    };
  }, [active, scale]);

  const zoomed = scale > 1.01;
  const dragging = dragState !== null;

  return (
    <div
      ref={containerRef}
      className={`ph-lb-slide${active ? " ph-lb-slide-active" : ""}${zoomed ? " ph-lb-slide-zoomed" : ""}${dragging ? " ph-lb-slide-dragging" : ""}`}
      aria-hidden={!active}
      onWheel={(e) => {
        if (!active) return;
        e.preventDefault();
        const delta = -e.deltaY * WHEEL_ZOOM_SENSITIVITY;
        if (delta !== 0) zoomBy(delta);
      }}
      onDoubleClick={() => {
        if (!active) return;
        if (zoomed) {
          setScale(1);
          setOffset({ x: 0, y: 0 });
        } else {
          setScale(2);
        }
      }}
      onPointerDown={(e) => {
        if (!active || !zoomed || e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setDragState({
          id: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startOffsetX: offset.x,
          startOffsetY: offset.y,
        });
      }}
      onPointerMove={(e) => {
        if (!dragState || dragState.id !== e.pointerId) return;
        const dx = e.clientX - dragState.startX;
        const dy = e.clientY - dragState.startY;
        setOffset(clampOffset({ x: dragState.startOffsetX + dx, y: dragState.startOffsetY + dy }, scale));
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
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        draggable={false}
      />
      {/* The real, full-resolution photo — fades in once decoded. */}
      <img
        src={fullSrc}
        alt={entry.name}
        className="ph-lb-img ph-lb-full"
        style={{
          opacity: fullLoaded ? 1 : 0,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
        draggable={false}
        onLoad={() => setFullLoaded(true)}
      />
      {active && !fullLoaded && (
        <div className="ph-lb-loading">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      )}
      {active && overlay && overlayHasData(overlay) && (
        <div className="ph-lb-exif-overlay" aria-hidden>
          {overlay.lens && <span>{overlay.lens}</span>}
          {(overlay.aperture || overlay.shutter || overlay.iso || overlay.focusDistance) && (
            <span>
              {[overlay.aperture, overlay.shutter, overlay.iso, overlay.focusDistance]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
