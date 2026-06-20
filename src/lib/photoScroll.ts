/** URL-safe `data-photo-path` value (paths may contain `\`, spaces, etc.). */
export function photoPathAttr(path: string): string {
  return encodeURIComponent(path);
}

export function findPhotoElement(path: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-photo-path="${photoPathAttr(path)}"]`);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function isComfortablyVisible(el: HTMLElement, margin = 48): boolean {
  const r = el.getBoundingClientRect();
  return r.top >= margin && r.bottom <= window.innerHeight - margin;
}

/**
 * Brings a gallery tile into view. List rows are always mounted; masonry tiles may
 * virtualize, so we jump by index then scan until the element appears.
 */
export async function scrollToPhoto(path: string, index: number, total: number): Promise<HTMLElement | null> {
  let el = findPhotoElement(path);
  if (el && isComfortablyVisible(el)) return el;

  if (el) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    await nextFrame();
    return el;
  }

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  if (total > 1 && index >= 0) {
    window.scrollTo({ top: (index / (total - 1)) * maxScroll, behavior: "auto" });
    await nextFrame();
    await nextFrame();
    el = findPhotoElement(path);
    if (el) {
      if (!isComfortablyVisible(el)) el.scrollIntoView({ block: "center", behavior: "instant" });
      await nextFrame();
      return el;
    }
  }

  // Progressive scan for virtualized masonry tiles.
  const step = Math.max(240, window.innerHeight * 0.75);
  for (let y = 0; y <= maxScroll; y += step) {
    window.scrollTo({ top: y, behavior: "auto" });
    await nextFrame();
    el = findPhotoElement(path);
    if (el) {
      if (!isComfortablyVisible(el)) el.scrollIntoView({ block: "center", behavior: "instant" });
      await nextFrame();
      return el;
    }
  }

  return findPhotoElement(path);
}

/** Duration of the lightbox-to-tile shrink animation (ms). Keep in sync with CSS. */
export const CLOSE_FLIGHT_MS = 240;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** FLIP transform from a source rect to a destination rect (center-aligned). */
export function flipTransform(from: DOMRect, to: DOMRect): string {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  const cx1 = from.left + from.width / 2;
  const cy1 = from.top + from.height / 2;
  const cx2 = to.left + to.width / 2;
  const cy2 = to.top + to.height / 2;
  return `translate(${cx2 - cx1}px, ${cy2 - cy1}px) scale(${sx}, ${sy})`;
}
