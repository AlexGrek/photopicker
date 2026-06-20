import { useEffect, useRef } from "react";
import { CLOSE_FLIGHT_MS, flipTransform } from "@/lib/photoScroll";

/**
 * Fixed-position clone that shrinks from the lightbox image bounds into the grid tile.
 */
export function LightboxCloseFlight({
  fromRect,
  toRect,
  imageSrc,
  onComplete,
}: {
  fromRect: DOMRect;
  toRect: DOMRect;
  imageSrc: string;
  onComplete: () => void;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    const end = flipTransform(fromRect, toRect);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      onCompleteRef.current();
      return;
    }

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      onCompleteRef.current();
    };

    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target === shell && e.propertyName === "transform") finish();
    };

    shell.addEventListener("transitionend", onTransitionEnd);
    const fallback = window.setTimeout(finish, CLOSE_FLIGHT_MS + 60);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        shell.style.transform = end;
        shell.style.borderRadius = "6px";
      });
    });

    return () => {
      shell.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(fallback);
    };
  }, [fromRect, toRect, imageSrc]);

  return (
    <div className="ph-close-flight-layer" aria-hidden style={{ ["--ph-close-flight-ms" as string]: `${CLOSE_FLIGHT_MS}ms` }}>
      <div
        ref={shellRef}
        className="ph-close-flight"
        style={{
          top: fromRect.top,
          left: fromRect.left,
          width: fromRect.width,
          height: fromRect.height,
        }}
      >
        <img src={imageSrc} alt="" className="ph-close-flight-img" draggable={false} />
      </div>
    </div>
  );
}
