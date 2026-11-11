import { useEffect, useRef, type RefObject } from "react";

/**
 * A ref that always holds the latest `value`. Lets long-lived listeners (window
 * events, gamepad polling, timers) call the current closure without having to be
 * torn down and re-subscribed on every render — and without a hand-maintained
 * dependency list that can silently go stale.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Subscribes `handler` to window `keydown` while `enabled`. The latest handler is
 * always used, so callers need not memoize it.
 */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const latest = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, latest]);
}

/**
 * Dismisses a popover: while `open`, a mousedown outside `ref` or an Escape press
 * calls `onDismiss`. Escape is consumed (`stopPropagation` in the capture phase)
 * so it closes only the popover rather than also triggering whatever "back"
 * binding the screen underneath has.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
): void {
  const latest = useLatest(onDismiss);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) latest.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      latest.current();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, ref, latest]);
}

/** True when a key event carries a modifier that makes it an OS/browser shortcut. */
export function hasCommandModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey || e.altKey;
}
