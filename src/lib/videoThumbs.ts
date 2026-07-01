import { videoUrl, type ImageEntry } from "./thumbnails";

/**
 * Client-side video poster frames.
 *
 * Rust carries no video codec (pure-Rust image crates, no ffmpeg), so grid
 * thumbnails for videos are produced here using the webview's native media
 * decoder: an offscreen `<video>` is seeked to an early frame and drawn onto a
 * `<canvas>`, which is exported as a JPEG object URL. Results are cached per
 * `path?v=<modified>` and generation is concurrency-limited so scrolling a folder
 * full of clips doesn't thrash the decoder.
 */

/** Longest edge of the generated poster, in px (matches the grid tile request). */
const MAX_EDGE = 512;
/** How many posters to decode at once — small, so scrolling stays smooth. */
const MAX_CONCURRENT = 2;
/** Give up on a stubborn/corrupt file rather than holding a decode slot forever. */
const TIMEOUT_MS = 15000;

const cache = new Map<string, string>(); // key -> blob object URL
const inflight = new Map<string, Promise<string>>();

let active = 0;
const waiters: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  active -= 1;
  const next = waiters.shift();
  if (next) {
    active += 1;
    next();
  }
}

function posterKey(entry: ImageEntry): string {
  return `${entry.path}?v=${entry.modified ?? 0}`;
}

function generate(entry: ImageEntry): Promise<string> {
  return acquire().then(
    () =>
      new Promise<string>((resolve, reject) => {
        const video = document.createElement("video");
        video.muted = true;
        video.crossOrigin = "anonymous"; // keep the canvas untainted (scheme sends ACAO: *)
        video.preload = "auto";
        video.playsInline = true;
        video.src = videoUrl(entry);

        let done = false;
        const cleanup = () => {
          video.removeAttribute("src");
          video.load();
        };
        const fail = (err: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          release();
          reject(err);
        };
        const succeed = (url: string) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cleanup();
          release();
          resolve(url);
        };

        const timer = setTimeout(() => fail(new Error("video poster timeout")), TIMEOUT_MS);

        const capture = () => {
          if (done) return;
          const { videoWidth: w, videoHeight: h } = video;
          if (!w || !h) return fail(new Error("no video dimensions"));
          const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
          const cw = Math.max(1, Math.round(w * scale));
          const ch = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext("2d");
          if (!ctx) return fail(new Error("no 2d context"));
          try {
            ctx.drawImage(video, 0, 0, cw, ch);
          } catch (e) {
            return fail(e);
          }
          canvas.toBlob(
            (blob) => {
              if (!blob) return fail(new Error("toBlob failed"));
              succeed(URL.createObjectURL(blob));
            },
            "image/jpeg",
            0.82,
          );
        };

        video.addEventListener("loadeddata", () => {
          // Skip a little past the start to dodge black lead-in frames; the actual
          // grab happens on `seeked`. Fall back to grabbing frame 0 if we can't seek.
          const target = Math.min(0.5, (video.duration || 0) * 0.1);
          if (target > 0 && Number.isFinite(target)) video.currentTime = target;
          else capture();
        });
        video.addEventListener("seeked", capture);
        video.addEventListener("error", () => fail(video.error ?? new Error("video error")));
      }),
  );
}

/** Resolves to a cached (or freshly generated) poster-frame object URL for `entry`. */
export function getVideoPoster(entry: ImageEntry): Promise<string> {
  const key = posterKey(entry);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = generate(entry)
    .then((url) => {
      cache.set(key, url);
      inflight.delete(key);
      return url;
    })
    .catch((e) => {
      inflight.delete(key);
      throw e;
    });
  inflight.set(key, p);
  return p;
}
