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

/** Persist the last-used copy/move destination (fire-and-forget). */
export function persistLastTargetDirectory(dir: string): void {
  void invoke("set_last_target_directory", { dir }).catch(() => {});
}
