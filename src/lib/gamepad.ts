import { useEffect, useRef } from "react";

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

// Treat the left analog stick / d-pad hat axes as the d-pad too, so controllers
// that report direction on an axis instead of buttons 12–15 still navigate.
const AXIS_THRESHOLD = 0.5;

/**
 * Polls connected gamepads each animation frame and invokes `onPress` once per
 * button press (edge-triggered — holding a button does not repeat). The latest
 * `onPress` is always used, so callers need not memoize it. No-op when the
 * browser has no Gamepad API.
 */
export function useGamepad(onPress: (button: GamepadButton) => void): void {
  const handler = useRef(onPress);
  handler.current = onPress;

  useEffect(() => {
    if (typeof navigator === "undefined" || !("getGamepads" in navigator)) return;

    let raf = 0;
    // Keyed by `${padIndex}:${button}` so two controllers don't cancel each other.
    const wasPressed = new Map<string, boolean>();

    const poll = () => {
      for (const pad of navigator.getGamepads()) {
        if (!pad) continue;
        const ax = pad.axes;
        const axisLeft = (ax[0] ?? 0) < -AXIS_THRESHOLD;
        const axisRight = (ax[0] ?? 0) > AXIS_THRESHOLD;
        const axisUp = (ax[1] ?? 0) < -AXIS_THRESHOLD;
        const axisDown = (ax[1] ?? 0) > AXIS_THRESHOLD;

        for (const button of Object.keys(BUTTON_INDEX) as GamepadButton[]) {
          const idx = BUTTON_INDEX[button];
          let pressed = pad.buttons[idx]?.pressed ?? false;
          if (button === "left") pressed ||= axisLeft;
          else if (button === "right") pressed ||= axisRight;
          else if (button === "up") pressed ||= axisUp;
          else if (button === "down") pressed ||= axisDown;

          const key = `${pad.index}:${button}`;
          if (pressed && !wasPressed.get(key)) handler.current(button);
          wasPressed.set(key, pressed);
        }
      }
      raf = requestAnimationFrame(poll);
    };

    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, []);
}
