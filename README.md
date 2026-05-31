# PhotoPicker

A desktop demo app built with [Tauri 2](https://tauri.app/), React, and TypeScript.

## Stack

- **Tauri 2** — Rust-backed native shell
- **React 19** + **TypeScript** — frontend
- **Vite** — dev server and bundler

## Prerequisites

- Node.js 18+ and npm
- Rust toolchain (`rustup`, `cargo`)
- Platform build dependencies for Tauri — see [Tauri prerequisites](https://tauri.app/start/prerequisites/)

## Install

```sh
npm install
```

## Develop

Run the desktop app with hot reload:

```sh
npm run tauri dev
```

Run only the web frontend (no native window):

```sh
npm run dev
```

## Build

Produce a release bundle for the current platform:

```sh
npm run tauri build
```

The frontend alone can be built with `npm run build`.

## Project layout

```
.
├── src/           React + TypeScript frontend
├── src-tauri/     Rust backend, Tauri config, app icons
├── docs/          Developer documentation
├── public/        Static assets served by Vite
├── index.html     Vite entry
└── vite.config.ts
```

## Configuration

User settings are persisted at `~/.photopicker/config.json` (macOS/Linux) or
`%USERPROFILE%\.photopicker\config.json` (Windows).  See [docs/config.md](docs/config.md)
for the full schema, defaults, and frontend Tauri commands.

## App identifier

`com.photopicker.app` — change in `src-tauri/tauri.conf.json` before publishing.

## Recommended IDE setup

[VS Code](https://code.visualstudio.com/) with the [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) and [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) extensions.
