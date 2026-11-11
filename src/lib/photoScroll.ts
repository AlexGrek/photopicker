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

/** How many extra positions to probe around the estimate before giving up. */
const MAX_PROBES = 8;

/**
 * The scroll offsets to probe when the estimated position did not mount the tile:
 * alternating one step below / above the estimate, moving outward, clamped to the
 * scrollable range and without repeats. Bounded by `maxProbes`, so a miss costs a
 * handful of frames rather than a walk over the entire grid.
 */
export function probeOffsets(estimate: number, step: number, maxScroll: number, maxProbes = MAX_PROBES): number[] {
  const offsets: number[] = [];
  const seen = new Set<number>([Math.round(estimate)]);
  for (let ring = 1; offsets.length < maxProbes && ring <= maxProbes; ring++) {
    for (const direction of [1, -1]) {
      const y = Math.min(maxScroll, Math.max(0, estimate + direction * ring * step));
      const rounded = Math.round(y);
      if (seen.has(rounded)) continue;
      seen.add(rounded);
      offsets.push(y);
      if (offsets.length >= maxProbes) break;
    }
  }
  return offsets;
}

async function settle(el: HTMLElement): Promise<HTMLElement> {
  if (!isComfortablyVisible(el)) el.scrollIntoView({ block: "center", behavior: "instant" });
  await nextFrame();
  return el;
}

/**
 * Brings a gallery tile into view and resolves to its element, or to `null` if it
 * could not be located (the scroll position is then restored).
 *
 * Tiles are virtualized, so one that is far from the viewport is not in the DOM.
 * We jump to its estimated offset — `index / total` of the way down — and, if it
 * did not mount there, probe a few positions around that estimate. The search is
 * deliberately bounded: every probe mounts a screenful of tiles and requests
 * their thumbnails, which on slow storage must not turn into a scan of the whole
 * folder.
 *
 * @param index position of the tile among *all* items in the grid (folders included)
 * @param total number of items in the grid
 */
export async function scrollToPhoto(path: string, index: number, total: number): Promise<HTMLElement | null> {
  let el = findPhotoElement(path);
  if (el) return isComfortablyVisible(el) ? el : settle(el);
  if (total <= 1 || index < 0) return null;

  const startY = window.scrollY;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const estimate = (index / (total - 1)) * maxScroll;
  const step = Math.max(240, window.innerHeight * 0.75);

  for (const y of [estimate, ...probeOffsets(estimate, step, maxScroll)]) {
    window.scrollTo({ top: y, behavior: "instant" });
    // Two frames: one for the virtualizer to react to the scroll, one to render.
    await nextFrame();
    await nextFrame();
    el = findPhotoElement(path);
    if (el) return settle(el);
  }

  window.scrollTo({ top: startY, behavior: "instant" });
  return null;
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
