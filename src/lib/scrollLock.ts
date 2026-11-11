/**
 * Freezes page scrolling while a fullscreen overlay (the lightbox) is open.
 *
 * The gallery scrolls the document itself, so without this a wheel, trackpad or
 * arrow-key gesture over the overlay scrolls the grid hidden underneath it.
 * `overflow: hidden` removes the scrollbar, which would widen the viewport and
 * reflow the grid — so the scrollbar's width is put back as padding and the
 * layout underneath does not move at all.
 *
 * Locks nest; the page is released when the last one is. The returned release
 * function is idempotent.
 */
let locks = 0;
let previousPaddingRight = "";

export function lockPageScroll(): () => void {
  const root = document.documentElement;
  if (locks === 0) {
    const scrollbarWidth = window.innerWidth - root.clientWidth;
    previousPaddingRight = root.style.paddingRight;
    if (scrollbarWidth > 0) root.style.paddingRight = `${scrollbarWidth}px`;
    root.classList.add("ph-scroll-locked");
  }
  locks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    locks -= 1;
    if (locks === 0) {
      root.classList.remove("ph-scroll-locked");
      root.style.paddingRight = previousPaddingRight;
    }
  };
}
