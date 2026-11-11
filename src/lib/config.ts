import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `Config` struct in `src-tauri/src/config.rs` (see docs/config.md). */
export interface Config {
  lastDirectory: string | null;
  theme: "light" | "dark" | "system";
  maxRecentDirectories: number;
  recentDirectories: string[];
  targetDirectories: string[];
  /** Last copy/move destination — restored as the chooser highlight. */
  lastTargetDirectory: string | null;
  lightboxInFullscreen: boolean;
  enableRawCouplingDetection: boolean;
  exifOverlayEnabled: boolean;
}

/** Chooser highlight index for a loaded config (0 when unset or no longer listed). */
export function menuIndexForConfig(cfg: Config): number {
  if (!cfg.lastTargetDirectory) return 0;
  const idx = cfg.targetDirectories.indexOf(cfg.lastTargetDirectory);
  return idx >= 0 ? idx : 0;
}

// ---------------------------------------------------------------------------
// Shared config store
//
// The config lives on disk and is owned by Rust, but every screen needs to read
// it. Rather than each component round-tripping `get_config` when it mounts (the
// lightbox used to wait on that before it could even enter fullscreen), the app
// loads it once and keeps a cached copy here. Every command that changes the
// config returns the updated value, which is fed back through `setConfig`.
// ---------------------------------------------------------------------------

let current: Config | null = null;
let loading: Promise<Config> | null = null;
const listeners = new Set<() => void>();

function setConfig(next: Config): Config {
  current = next;
  for (const listener of listeners) listener();
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached config, or `null` until the first load resolves. */
export function getConfig(): Config | null {
  return current;
}

/** Loads the config once; later calls reuse the cached value. */
export function loadConfig(): Promise<Config> {
  if (current) return Promise.resolve(current);
  if (!loading) {
    loading = invoke<Config>("get_config")
      .then(setConfig)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Subscribes a component to the shared config (`null` until loaded). */
export function useConfig(): Config | null {
  return useSyncExternalStore(subscribe, getConfig);
}

/** Runs a Rust command that returns the updated `Config` and caches the result. */
export async function configCommand(command: string, args: Record<string, unknown>): Promise<Config> {
  return setConfig(await invoke<Config>(command, args));
}

/**
 * Changes individual settings. The cache is updated optimistically so the UI
 * responds at once; the patch is then merged into a fresh read from disk (so a
 * field changed elsewhere in the meantime is not clobbered) and saved. On failure
 * the cache is restored from disk and the error is re-thrown.
 */
export async function updateConfig(patch: Partial<Config>): Promise<Config> {
  if (current) setConfig({ ...current, ...patch });
  try {
    const fresh = await invoke<Config>("get_config");
    const updated: Config = { ...fresh, ...patch };
    await invoke("save_config", { config: updated });
    return setConfig(updated);
  } catch (e) {
    const onDisk = await invoke<Config>("get_config").catch(() => null);
    if (onDisk) setConfig(onDisk);
    throw e;
  }
}

/** Persist the last-used copy/move destination (fire-and-forget). */
export function persistLastTargetDirectory(dir: string): void {
  void configCommand("set_last_target_directory", { dir }).catch(() => {});
}
