# Photo gallery

A virtualized, infinite-scrolling masonry gallery for browsing a directory of
JPEGs straight off **slow storage** (memory cards, network shares) where photos
can be **100 MP**. Two hard rules shape the whole design:

1. **Never read a whole file when a few KB of its header will do.**
2. **Never decode the full-size original to show a preview** — not for a tile,
   not for the lightbox.

## Flow

1. The main menu (`App.tsx`) opens a directory — clicking a recent location or
   adding a new one calls `openDirectory`, which records it via
   `push_recent_directory` and switches to the [`Gallery`](../src/components/Gallery.tsx).
2. `Gallery` calls **`list_images(dir)`** once. This only enumerates directory
   entries (path, name, size, mtime) — **no file contents are read** — so even a
   card with thousands of photos lists instantly.
3. The list is handed to [`VirtuosoMasonry`](https://virtuoso.dev) (`@virtuoso.dev/masonry`,
   the same component the `consens_family` feed uses), with a responsive column
   count and `useWindowScroll`. Only tiles near the viewport are mounted.
4. Each [`PhotoTile`](../src/components/PhotoTile.tsx) is just a lazy `<img>`
   pointed at a `thumb://` URL. The browser fetches/decodes/caches it; the tile
   adopts the photo's real aspect ratio from the loaded image's natural size.
5. Clicking a tile opens the [`Lightbox`](../src/components/Lightbox.tsx), which
   puts the OS window into **real fullscreen** (no title bar / borders) and shows
   the **full-resolution** photo edge to edge. Because that can take a moment off a
   slow card, the cached grid thumbnail is shown first — stretched to fill the
   screen — then the original streams in via `orig://` and fades in over it. Arrow
   keys / chevrons navigate, Escape closes (and restores the previous window state).
   This needs the `core:window:allow-set-fullscreen` / `allow-is-fullscreen`
   permissions in [capabilities/default.json](../src-tauri/capabilities/default.json).

## Serving thumbnails — the `thumb://` scheme (no base64)

Thumbnails are **not** returned from a command as base64 data URLs. Instead
[lib.rs](../src-tauri/src/lib.rs) registers an asynchronous `thumb://` URI scheme,
and the frontend builds URLs with `convertFileSrc(path, "thumb")`:

```
thumb://localhost/<urlencoded path>?max=256&v=<mtime>
```

The handler streams raw `image/jpeg` bytes with a long `Cache-Control`. Benefits:

- **No base64 inflation** and no giant strings retained in JS.
- The **webview** handles lazy-loading, decoding and an on-disk image cache, so
  re-scrolling — and the lightbox's instant placeholder — comes from cache.
- A `tokio::Semaphore` caps concurrent decodes (`THUMB_CONCURRENCY`, 8) so a slow
  card is never hammered by a burst of parallel reads.
- `?v=<mtime>` cache-busts when a file changes; `?max=` selects the size.

### `orig://` — the full-resolution original

The lightbox opens the actual photo, so a second scheme streams the original file
verbatim (`convertFileSrc(path, "orig")`): no decode or re-encode in Rust — the
webview decodes the full JPEG itself. Originals can be tens of MB, so the response
is sent `Cache-Control: no-store` rather than retained in the image cache. This is
the **only** path that touches a full-size file, and it runs solely on an explicit
lightbox open — never while browsing the grid.

## Producing a thumbnail — [`images.rs`](../src-tauri/src/images.rs)

`render_thumbnail(path, maxEdge)` returns small upright JPEG bytes. Cost order:

| Step | What happens | Cost on a slow card |
|---|---|---|
| Bounded prefix read | Read at most **2 MiB** from the front of the file | one short sequential read |
| EXIF (`kamadak-exif`) | Orientation + the embedded thumbnail's offset/length | parses the prefix only |
| **Preview path** | For `maxEdge ≤ 512` (every tile and the lightbox) decode the tiny embedded EXIF thumbnail, rotate upright, downscale, re-encode (`jpeg-encoder`) | trivial |
| Fallback | Only when a JPEG has **no** embedded thumbnail (e.g. a stripped web image): read + full-decode with `zune-jpeg` | the expensive case — never hit by camera files |

Camera JPEGs are required by the DCF/Exif standard to embed a thumbnail, so the
preview path covers essentially every photo off a memory card; the full file is
read only as a last resort for thumbnail-less images, and **previews never request
a size that would force a full decode** (`maxEdge` stays ≤ 512).

Orientation is **baked into the returned pixels**, so the frontend never rotates
anything — it just lets the image's natural size set the tile's `aspect-ratio`.

## The split: fast grid, full-quality lightbox

- **Grid tiles** are served from the embedded EXIF thumbnail only — never a
  full-size read — which is what makes browsing a card of 100 MP photos fast. The
  thumbnails are small (~160 px, larger on some phones), so tiles are not
  pixel-sharp, and the lightbox's stretched placeholder is briefly soft.
- **The lightbox** loads the real original (`orig://`), so the user gets full
  quality when they actually choose a photo — with the stretched thumbnail
  bridging the load on slow storage so it never feels blank.

## Tuning

- Tile size: `thumbUrl(data, 256)` in `PhotoTile.tsx`.
- Lightbox placeholder size: `thumbUrl(entry, 256)` in `Lightbox.tsx`; the full
  image comes from `origUrl(entry)`.
- Decode concurrency: `THUMB_CONCURRENCY` in `lib.rs`.
- Header budget and the embedded-vs-decode threshold: `PREFIX_CAP` and
  `EXIF_THUMB_MAX_EDGE` in `images.rs`.
