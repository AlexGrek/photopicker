# PhotoPicker — codebase guide

## What this app does

PhotoPicker is a desktop application built with **Tauri 2 + React**. Its purpose is to let users browse directories of photos that may live on **slow storage** (memory cards, network shares) and be **very high resolution** (100 MP is normal). It has three screens:

- **Main menu** — a "Last Locations" list of recently-used directories, with a native system folder-picker to add new ones. A gear button opens **Settings**.
- **Settings** — curate "Target Locations" (destination folders that selected photos can be sent to), added/removed via the native folder picker and persisted in config.
- **Gallery** — opening a directory shows a virtualized, infinite-scrolling masonry of JPEG thumbnails plus a lightbox preview. Thumbnails come from the embedded EXIF thumbnail whenever possible (reading only a few KB of each file), so the grid fills fast without ever decoding a full photo. See [docs/gallery.md](docs/gallery.md).

## Repository layout

```
photopicker/
├── src/                        # React frontend (TypeScript)
│   ├── main.tsx                # React entry point, imports index.css
│   ├── App.tsx                 # Root component — main menu / settings / gallery view switch
│   ├── index.css               # Tailwind v4 entry + CSS variables + gallery/lightbox styles
│   ├── components/
│   │   ├── ui/                 # shadcn/ui components (Button, Card, Separator)
│   │   ├── Gallery.tsx         # VirtuosoMasonry grid for a directory + lightbox host
│   │   ├── PhotoTile.tsx       # One masonry cell: lazy thumbnail, aspect placeholder
│   │   ├── Lightbox.tsx        # Fullscreen preview: neighbour preload, keyboard/gamepad nav, culling toolbar
│   │   └── Settings.tsx        # Target Locations editor (add/remove destination folders)
│   └── lib/
│       ├── utils.ts            # cn() + shortenPath() helpers
│       ├── config.ts           # Shared Config TS type (mirrors the Rust struct)
│       ├── gamepad.ts          # useGamepad() — polls gamepads, edge-triggered d-pad/buttons
│       ├── marks.ts            # Mark type + get/set marks + copy_to_target wrappers
│       └── thumbnails.ts       # list_images + thumb:// URL builder (convertFileSrc)
│
├── src-tauri/                  # Rust backend (Tauri 2)
│   ├── src/
│   │   ├── main.rs             # Binary entry point (do not edit)
│   │   ├── lib.rs              # Tauri commands + plugin registration
│   │   ├── config.rs           # Config struct, load/save, recent + target directories
│   │   ├── images.rs           # list_images + get_thumbnail (EXIF thumb fast path, zune fallback)
│   │   └── marks.rs            # sled-backed per-photo marks (rating + flag), one tree per directory
│   ├── Cargo.toml              # Rust dependencies
│   ├── tauri.conf.json         # App metadata, window config, bundle settings
│   └── capabilities/
│       └── default.json        # Tauri permission grants for the main window
│
├── docs/
│   ├── config.md               # Config schema, file path, Tauri commands, TS types
│   ├── gallery.md              # Gallery architecture: slow-storage thumbnail pipeline
│   └── image-processing.md     # EXIF reading and JPEG decoding guide (kamadak-exif, zune-jpeg)
│
├── components.json             # shadcn/ui config (style, aliases, icon library)
├── vite.config.ts              # Vite config: @tailwindcss/vite plugin, @ path alias
└── tsconfig.json               # TS config: paths alias (@/* → src/*), bundler resolution
```

## Tech stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri 2 |
| Frontend framework | React 19 |
| Language (frontend) | TypeScript 5.8 |
| Bundler | Vite 7 |
| CSS | Tailwind CSS v4 (Vite plugin, no config file) |
| UI components | shadcn/ui (Radix + CVA) |
| Icons | lucide-react |
| Animation | framer-motion |
| Language (backend) | Rust (2021 edition) |

## Key concepts

### Tauri command bridge
The frontend talks to Rust via `invoke()` from `@tauri-apps/api/core`. Every callable function in `src-tauri/src/lib.rs` annotated with `#[tauri::command]` and registered in `tauri::generate_handler![]` becomes available to the frontend.

### Config persistence
User config lives in `~/.photopicker/config.json` (macOS/Linux) or `%USERPROFILE%\.photopicker\config.json` (Windows). It is managed entirely in Rust (`config.rs`) and exposed through these commands:

| Command | Description |
|---|---|
| `get_config()` | Load and return current config (returns defaults if file absent) |
| `save_config(config)` | Overwrite config on disk |
| `push_recent_directory(dir)` | Prepend dir, deduplicate, cap at `maxRecentDirectories`, save |
| `add_target_directory(dir)` | Append dir to `targetDirectories` (dedup, no cap), save |
| `remove_target_directory(dir)` | Remove dir from `targetDirectories`, save |

New config fields must use `#[serde(default)]` so older config files on disk still load (a missing field would otherwise reset the whole config to defaults). See [docs/config.md](docs/config.md) for the full schema and TypeScript types.

### Directory picker
The native OS folder picker is triggered from the frontend using `open({ directory: true })` from `@tauri-apps/plugin-dialog`. No Rust command is needed — the plugin exposes it directly to JS. The `dialog:default` permission is granted in `capabilities/default.json`.

### File associations & "Open with"
The app registers itself as a handler for JPEG files via `bundle.fileAssociations` in `tauri.conf.json` (this becomes `CFBundleDocumentTypes` on macOS, registry entries on Windows, and a desktop MIME entry on Linux). Opening a JPEG — or dropping a folder on the app — routes to the gallery: a **file** opens its parent directory and jumps straight into the lightbox on that photo; a **folder** just opens the gallery.

The opened path reaches the app two ways, both funnelled through `dispatch_open` in `lib.rs` into an `OpenTarget { dir, file }`:
- **macOS**: the `RunEvent::Opened { urls }` event (fires both at launch and while already running).
- **Windows / Linux** (and `photopicker <path>` from a shell anywhere): the first CLI argument, read in `.setup()`.

Because an open can arrive before the webview exists, requests are bridged carefully: a launch-time open is stashed in the managed `OpenState` and drained by the `take_pending_open()` command the frontend calls on mount; an open that arrives while running is emitted as an `open-target` event. `App.tsx` does both (drain on mount + `listen("open-target")`); `Gallery.tsx` opens `initialFile` in the lightbox once the listing loads, guarded so a later move/delete never yanks the view back. **Note:** file associations only register for a *bundled* app (`npm run tauri build`), not `tauri dev` — to exercise the open logic in dev, run the built binary with a path argument.

### Input & navigation — always support gamepad
**Every navigable surface must be operable with a gamepad, not just the mouse and keyboard.** Whenever you add keyboard navigation (arrow keys, Escape, etc.), wire up the equivalent gamepad controls in the same place. Use the shared `useGamepad()` hook in `src/lib/gamepad.ts`, which polls the [Gamepad API](https://w3c.github.io/gamepad/) each animation frame and fires an edge-triggered callback per button press (the browser has no gamepad events). It maps the W3C "standard" layout: d-pad (and the left stick / hat axes) to `up`/`down`/`left`/`right`, and the four face buttons to `a`/`b`/`x`/`y`.

Convention for directional navigation: d-pad **left/up = previous**, **right/down = next**, **B = back/close** — mirroring the arrow-key + Escape bindings. Face buttons can shortcut actions (in the lightbox **Y = Copy**, mirroring the `C` key). The lightbox (`Lightbox.tsx`) is the reference implementation.

### Culling: marks & copy
The lightbox is a culling surface. A bottom toolbar — revealed only when the cursor nears the bottom edge — carries `← | Copy (C) | Move (M) | Mark (1–5) | Flag (F) | Delete | →`. Most actions have a keyboard shortcut; **Delete deliberately has none** (it requires a click and an inline confirm). The close (✕) and side nav buttons reveal/fade by edge proximity too, and the image counter (`N / total` + name) flashes on switch then fades — all so the photo fills the screen uninterrupted while idle.

- **Marks** — a per-photo star rating (1–5) plus a flag, stored in a [`sled`](https://docs.rs/sled) embedded DB at `~/.photopicker/database` with **one sled tree per browsed directory** (tree name = directory path, key = file name). Marks live outside the photos, so culling never rewrites originals. Managed by `marks.rs` and exposed via `get_marks(dir)` and `set_mark(dir, name, mark)`.
- **Copy / Move** — `copy_to_target(src, targetDir)` / `move_to_target(src, targetDir)` send the current photo into one of the configured Target Locations, never overwriting (append ` (n)` on collision). Both run off-thread (originals can be 100 MP). Move tries a same-filesystem `rename`, falling back to copy-then-delete across volumes; afterwards the photo is dropped from the grid (via the lightbox's `onRemoved` callback) and its now-orphaned mark is cleared.
- **Delete** — `delete_file(path)` permanently removes the current photo (no OS trash). The toolbar button morphs in place into a `Delete? ✓ ✗` confirm panel; only the ✓ deletes, then `onRemoved` drops the tile. No keyboard/gamepad shortcut, by design.
- **Destination chooser** — pressing **C**/**M** (or the toolbar button) always opens a destination submenu rather than acting immediately. It lists the saved Target Locations plus a final **Browse…** entry (native folder picker, for a one-off destination not in the list). `↑/↓` (or gamepad d-pad) cycle the highlighted entry; **Enter**/gamepad-A, or pressing the *same* key again, confirms — so `C C` copies to the highlighted target fast and `M M` moves fast. The highlight index persists across photos, so repeated culling to the same folder stays one keypress.
- **Grid filters** — the gallery header has a star row (minimum-rating threshold; click the active star to clear) and a flag toggle. `Gallery.tsx` loads the directory's marks alongside the listing and derives the filtered `visible` list that both the grid and the lightbox navigate (so `openIndex` indexes the filtered set). Filters are mark-driven, so the lightbox's marks are re-read on close to keep the filter current.

### Tailwind v4 setup
Tailwind v4 does **not** use a `tailwind.config.js` or PostCSS. Instead:
- `@tailwindcss/vite` is registered as a Vite plugin in `vite.config.ts`
- `src/index.css` starts with `@import "tailwindcss"`
- Design tokens (shadcn CSS variables) are declared in `@layer base` in `index.css`
- The `@theme inline` block maps those CSS variables to Tailwind utility classes

### shadcn/ui
Components live in `src/components/ui/` and are generated by the shadcn CLI (`npx shadcn@latest add <component>`). They import from `@/components/ui/...` using the `@` alias (configured in both `vite.config.ts` and `tsconfig.json`). The `cn()` utility in `src/lib/utils.ts` merges Tailwind classes safely.

### Gallery & thumbnails
The gallery is built for slow storage and huge photos. The directory listing is a
command; thumbnails are served over a custom URI scheme (no base64):

| Surface | Description |
|---|---|
| `list_images(dir)` command | Enumerate the JPEGs in `dir` (path/name/size/mtime). Reads **no** file contents. |
| `thumb://localhost/<path>?max=N&v=<mtime>` scheme | Streams a small upright JPEG thumbnail. Built in JS with `convertFileSrc(path, "thumb")` and used as a plain `<img src>` for grid tiles + the lightbox placeholder. |
| `orig://localhost/<path>` scheme | Streams the **original full-resolution file** verbatim for the webview to decode. Used only by the lightbox. |

The `thumb://` handler reads at most a 2 MiB prefix per file and serves the
embedded EXIF thumbnail for camera JPEGs (the common case). **Grid browsing never
decodes a full-size original** — tile `max` stays ≤ 512, which always takes the
embedded path; a full `zune-jpeg` decode happens only as a fallback for JPEGs that
have no embedded thumbnail at all. The full-size file is read only by `orig://`,
and only when the user opens the lightbox (which shows the stretched thumbnail
until the original arrives). A `tokio::Semaphore` caps concurrent thumbnail
decodes, and the browser handles lazy-loading and caching. Full details and
tuning knobs are in [docs/gallery.md](docs/gallery.md).

Image-processing crates (all pure Rust, no system deps), documented with usage
examples in [docs/image-processing.md](docs/image-processing.md):
- **kamadak-exif** — reads EXIF orientation + the embedded thumbnail without a full decode
- **zune-jpeg** — fast JPEG decode (SIMD on x86 and ARM), used only on the no-embedded-thumbnail fallback
- **jpeg-encoder** — re-encodes the downscaled thumbnail bytes streamed over `thumb://`

## Development commands

```bash
npm run tauri dev      # start dev server + Tauri window with HMR
npm run tauri build    # production build + native app bundle
npx tsc --noEmit       # type-check frontend only
```

## Adding a new Tauri command

1. Write the `fn` in `src-tauri/src/lib.rs` (or a new module) with `#[tauri::command]`
2. Add it to `tauri::generate_handler![...]` in `lib.rs`
3. Call it from the frontend with `invoke<ReturnType>("command_name", { argName: value })`

## Adding a new shadcn component

```bash
npx shadcn@latest add <component-name>
```

The component is placed in `src/components/ui/`. Any required Radix primitives are installed automatically.
