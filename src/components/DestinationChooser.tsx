import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderInput, FolderSearch } from "lucide-react";
import { configCommand, getConfig, menuIndexForConfig, persistLastTargetDirectory, useConfig } from "@/lib/config";
import { type GamepadButton } from "@/lib/gamepad";
import { shortenPath } from "@/lib/utils";

export type SendMode = "copy" | "move";

const NO_TARGETS: string[] = [];

/**
 * State and behaviour of the copy/move destination chooser, shared by the
 * lightbox (one photo) and the gallery selection bar (many).
 *
 * The chooser lists the saved Target Locations followed by a final "Browse…"
 * entry. Requesting a mode opens it; requesting the *same* mode again confirms
 * the highlighted entry — so "C, C" copies fast and "M, M" moves fast. The
 * highlight follows the last-used destination, which is persisted in the config,
 * so repeated culling into one folder stays a single keypress.
 *
 * @param onSend called with the chosen destination once the user confirms
 */
export function useDestinationChooser(onSend: (target: string, mode: SendMode) => void) {
  const config = useConfig();
  const targets = config?.targetDirectories ?? NO_TARGETS;
  const [mode, setMode] = useState<SendMode | null>(null);
  const [index, setIndex] = useState(() => (config ? menuIndexForConfig(config) : 0));

  // Adopt the saved highlight if the config only arrives after this mounted.
  const configLoaded = config !== null;
  useEffect(() => {
    const cfg = getConfig();
    if (cfg) setIndex(menuIndexForConfig(cfg));
  }, [configLoaded]);

  const browseIndex = targets.length;
  const itemCount = targets.length + 1;
  const selectedIndex = Math.min(index, itemCount - 1);

  function sendTo(target: string, sendMode: SendMode) {
    setMode(null);
    persistLastTargetDirectory(target);
    onSend(target, sendMode);
  }

  /** "Browse…" — pick any folder via the native dialog, save it as a target, send there. */
  async function browse(sendMode: SendMode) {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    try {
      const cfg = await configCommand("add_target_directory", { dir: picked });
      const at = cfg.targetDirectories.indexOf(picked);
      if (at >= 0) setIndex(at);
    } catch {
      // If persisting the target fails, still allow this one-off send.
    }
    sendTo(picked, sendMode);
  }

  function confirm(sendMode: SendMode) {
    if (selectedIndex === browseIndex) void browse(sendMode);
    else sendTo(targets[selectedIndex], sendMode);
  }

  function cycle(delta: number) {
    const next = (((selectedIndex + delta) % itemCount) + itemCount) % itemCount;
    setIndex(next);
    if (next < targets.length) persistLastTargetDirectory(targets[next]);
  }

  return {
    /** The mode the chooser is open in, or null while closed. */
    mode,
    targets,
    selectedIndex,
    browseIndex,
    close: () => setMode(null),
    highlight: setIndex,
    sendTo,
    browse,
    /** Opens the chooser in `sendMode`, or confirms if it is already open in it. */
    request(sendMode: SendMode) {
      if (mode === sendMode) confirm(sendMode);
      else setMode(sendMode);
    },
    /**
     * Keyboard handling while the chooser is open: Escape cancels, ↑/↓ move the
     * highlight, Enter confirms. Returns true when the key was consumed.
     */
    handleKey(e: KeyboardEvent): boolean {
      if (!mode) return false;
      if (e.key === "Escape") setMode(null);
      else if (e.key === "ArrowUp") cycle(-1);
      else if (e.key === "ArrowDown") cycle(1);
      else if (e.key === "Enter") confirm(mode);
      else return false;
      e.preventDefault();
      return true;
    },
    /**
     * Gamepad handling while the chooser is open: d-pad ↑/↓ move the highlight,
     * A confirms, B cancels. Returns true when the chooser is open (it owns the
     * pad then, so every other button is swallowed).
     */
    handleGamepad(button: GamepadButton): boolean {
      if (!mode) return false;
      if (button === "up") cycle(-1);
      else if (button === "down") cycle(1);
      else if (button === "a") confirm(mode);
      else if (button === "b") setMode(null);
      return true;
    },
  };
}

export type DestinationChooserState = ReturnType<typeof useDestinationChooser>;

/** The chooser popup. Renders nothing while closed. */
export function DestinationChooser({
  chooser,
  title,
  hint,
  backdropClassName,
  menuClassName = "ph-lb-menu",
}: {
  chooser: DestinationChooserState;
  title: string;
  hint: string;
  backdropClassName: string;
  menuClassName?: string;
}) {
  const { mode } = chooser;
  if (!mode) return null;
  return (
    <div className={backdropClassName} onClick={chooser.close}>
      <div className={menuClassName} onClick={(e) => e.stopPropagation()}>
        <div className="ph-lb-menu-title">{title}</div>
        {chooser.targets.map((target, i) => (
          <button
            key={target}
            type="button"
            className={`ph-lb-menu-item${i === chooser.selectedIndex ? " ph-lb-menu-item-selected" : ""}`}
            onClick={() => chooser.sendTo(target, mode)}
            onMouseEnter={() => chooser.highlight(i)}
            title={target}
          >
            <FolderInput className="h-4 w-4 shrink-0" />
            <span className="ph-lb-menu-label">{shortenPath(target)}</span>
          </button>
        ))}
        <button
          type="button"
          className={`ph-lb-menu-item ph-lb-menu-browse${chooser.selectedIndex === chooser.browseIndex ? " ph-lb-menu-item-selected" : ""}`}
          onClick={() => void chooser.browse(mode)}
          onMouseEnter={() => chooser.highlight(chooser.browseIndex)}
        >
          <FolderSearch className="h-4 w-4 shrink-0" />
          <span className="ph-lb-menu-label">Browse…</span>
        </button>
        <div className="ph-lb-menu-hint">{hint}</div>
      </div>
    </div>
  );
}
