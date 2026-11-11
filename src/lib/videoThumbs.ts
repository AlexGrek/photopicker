import { LruMap } from "./lru";
import { videoUrl } from "./thumbnails";

/**
 * Client-side video poster frames.
 *
 * Rust carries no video codec (pure-Rust image crates, no ffmpeg), so grid
 * thumbnails for videos are produced here using the webview's native media
 * decoder: an offscreen `<video>` is seeked to an early frame and drawn onto a
 * `<canvas>`, which is exported as a JPEG object URL.
 *
 * Decoding is slow and reads the file off (possibly slow) storage, so:
 *
 * - at most {@link MAX_CONCURRENT} posters decode at once;
 * - the queue is **last-in, first-out** — the tiles requested most recently are
 *   the ones on screen now, so they must not wait behind everything the user has
 *   already scrolled past;
 * - a request nobody is waiting for any more (its tile unmounted before its turn
 *   came) is dropped without ever touching the file;
 * - finished posters are kept in a bounded LRU, and a poster's blob URL is
 *   revoked when it is evicted — but never while a mounted tile still shows it.
 */

/** Longest edge of the generated poster, in px (matches the grid tile request). */
const MAX_EDGE = 512;
/** How many posters to decode at once — small, so scrolling stays smooth. */
const MAX_CONCURRENT = 2;
/** Give up on a stubborn/corrupt file rather than holding a decode slot forever. */
const TIMEOUT_MS = 15000;
/** How many finished posters to keep around (each is a few tens of KB). */
const MAX_CACHED = 400;

interface Poster {
  url: string;
  /** Mounted tiles currently displaying this poster; it is evictable only at 0. */
  refs: number;
}

interface Job {
  key: string;
  path: string;
  modified: number | null;
  /** Handles still waiting on this job. */
  interested: number;
  started: boolean;
  settled: boolean;
  poster: Poster | null;
  promise: Promise<string>;
  resolve: (url: string) => void;
  reject: (reason: unknown) => void;
}

/** A claim on a poster: await `promise`, and `release()` when the tile unmounts. */
export interface PosterHandle {
  promise: Promise<string>;
  release: () => void;
}

const posters = new LruMap<string, Poster>(
  MAX_CACHED,
  (poster) => URL.revokeObjectURL(poster.url),
  (poster) => poster.refs === 0,
);
const jobs = new Map<string, Job>();
/** Jobs not yet started; the end of the array is served first. */
const queue: Job[] = [];
let active = 0;

function posterKey(path: string, modified: number | null): string {
  return `${path}?v=${modified ?? 0}`;
}

function generate(path: string, modified: number | null): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.crossOrigin = "anonymous"; // keep the canvas untainted (scheme sends ACAO: *)
    video.preload = "auto";
    video.playsInline = true;
    video.src = videoUrl({ path, modified });

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
      reject(err);
    };
    const succeed = (url: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
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
  });
}

function finish(job: Job): void {
  job.settled = true;
  jobs.delete(job.key);
}

function pump(): void {
  while (active < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.pop() as Job;
    if (job.interested === 0) {
      // Every tile that wanted this poster is gone — skip it without reading the file.
      finish(job);
      job.reject(new Error("video poster cancelled"));
      continue;
    }
    job.started = true;
    active += 1;
    generate(job.path, job.modified)
      .then(
        (url) => {
          job.poster = { url, refs: job.interested };
          posters.set(job.key, job.poster);
          finish(job);
          job.resolve(url);
        },
        (err) => {
          finish(job);
          job.reject(err);
        },
      )
      .finally(() => {
        active -= 1;
        pump();
      });
  }
}

function createJob(key: string, path: string, modified: number | null): Job {
  let resolve!: (url: string) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A cancelled job may have no listener left; don't surface that as unhandled.
  promise.catch(() => {});
  return {
    key,
    path,
    modified,
    interested: 0,
    started: false,
    settled: false,
    poster: null,
    promise,
    resolve,
    reject,
  };
}

/**
 * Claims the poster frame for a video (cached or freshly generated). The caller
 * must `release()` the handle when it no longer shows the poster — that is what
 * lets a queued request be cancelled and a cached poster be evicted.
 */
export function acquireVideoPoster(path: string, modified: number | null): PosterHandle {
  const key = posterKey(path, modified);
  let released = false;

  const cached = posters.get(key);
  if (cached) {
    cached.refs += 1;
    return {
      promise: Promise.resolve(cached.url),
      release: () => {
        if (released) return;
        released = true;
        cached.refs -= 1;
        posters.trim();
      },
    };
  }

  let job = jobs.get(key);
  if (!job) {
    job = createJob(key, path, modified);
    jobs.set(key, job);
    queue.push(job);
  } else if (!job.started) {
    // Asked for again: move it to the front of the line (the end of the array).
    const at = queue.indexOf(job);
    if (at >= 0) {
      queue.splice(at, 1);
      queue.push(job);
    }
  }
  job.interested += 1;
  const claimed = job;
  pump();

  return {
    promise: claimed.promise,
    release: () => {
      if (released) return;
      released = true;
      if (claimed.poster) {
        claimed.poster.refs -= 1;
        posters.trim();
      } else if (!claimed.settled) {
        claimed.interested -= 1;
      }
    },
  };
}
