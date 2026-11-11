import { useEffect } from "react";
import { useLatest } from "./hooks";

/**
 * Logical buttons we react to, mapped to indices in the W3C "standard" gamepad
 * mapping (https://w3c.github.io/gamepad/#remapping). The d-pad is buttons
 * 12–15; the face buttons are 0–3; bumpers are 4/5.
 */
export type GamepadButton = "up" | "down" | "left" | "right" | "a" | "b" | "x" | "y" | "lb" | "rb";

const BUTTON_INDEX: Record<GamepadButton, number> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  lb: 4,
  rb: 5,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
};
const BUTTONS = Object.keys(BUTTON_INDEX) as GamepadButton[];

// Treat the left analog stick / d-pad hat axes as the d-pad too, so controllers
// that report direction on an axis instead of buttons 12–15 still navigate.
const AXIS_THRESHOLD = 0.5;

// ---------------------------------------------------------------------------
// One shared poller
//
// The browser has no gamepad button events, so presses are detected by polling
// each animation frame. There is exactly one loop for the whole app, and it only
// runs while a controller is connected *and* something is listening — with no
// pad plugged in the webview stays idle. Sharing the loop also means press edges
// are tracked globally: a component that mounts while a button is still held
// does not see that held button as a fresh press.
// ---------------------------------------------------------------------------

type Listener = (button: GamepadButton) => void;

const listeners = new Set<Listener>();
// Keyed by `${padIndex}:${button}` so two controllers don't cancel each other.
const wasPressed = new Map<string, boolean>();
let raf = 0;
let watchingConnections = false;

function connectedPads(): Gamepad[] {
  if (typeof navigator === "undefined" || !("getGamepads" in navigator)) return [];
  return Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => pad !== null);
}

function poll(): void {
  raf = 0;
  const pads = connectedPads();
  if (pads.length === 0 || listeners.size === 0) {
    wasPressed.clear();
    return; // stop; a `gamepadconnected` event or a new listener restarts the loop
  }

  for (const pad of pads) {
    const ax = pad.axes;
    const axisLeft = (ax[0] ?? 0) < -AXIS_THRESHOLD;
    const axisRight = (ax[0] ?? 0) > AXIS_THRESHOLD;
    const axisUp = (ax[1] ?? 0) < -AXIS_THRESHOLD;
    const axisDown = (ax[1] ?? 0) > AXIS_THRESHOLD;

    for (const button of BUTTONS) {
      let pressed = pad.buttons[BUTTON_INDEX[button]]?.pressed ?? false;
      if (button === "left") pressed ||= axisLeft;
      else if (button === "right") pressed ||= axisRight;
      else if (button === "up") pressed ||= axisUp;
      else if (button === "down") pressed ||= axisDown;

      const key = `${pad.index}:${button}`;
      const before = wasPressed.get(key) ?? false;
      wasPressed.set(key, pressed);
      if (pressed && !before) {
        // Snapshot: a handler may mount/unmount other listeners as it runs.
        for (const listener of Array.from(listeners)) listener(button);
      }
    }
  }
  raf = requestAnimationFrame(poll);
}

function ensurePolling(): void {
  if (raf === 0 && listeners.size > 0 && connectedPads().length > 0) {
    raf = requestAnimationFrame(poll);
  }
}

function addListener(listener: Listener): () => void {
  listeners.add(listener);
  if (!watchingConnections && typeof window !== "undefined") {
    watchingConnections = true;
    window.addEventListener("gamepadconnected", ensurePolling);
  }
  ensurePolling();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Invokes `onPress` once per button press (edge-triggered — holding a button does
 * not repeat) while `enabled`. The latest `onPress` is always used, so callers
 * need not memoize it.
 *
 * Several components can listen at once, and every enabled listener receives each
 * press. A surface that is covered by another one (the gallery under the
 * lightbox, the selection bar under the lightbox) must pass `enabled = false`
 * while covered, so a single press never acts on two layers.
 */
export function useGamepad(onPress: (button: GamepadButton) => void, enabled = true): void {
  const handler = useLatest(onPress);
  useEffect(() => {
    if (!enabled) return;
    return addListener((button) => handler.current(button));
  }, [enabled, handler]);
}
