/** Mirrors the Rust `Config` struct in `src-tauri/src/config.rs` (see docs/config.md). */
export interface Config {
  lastDirectory: string | null;
  theme: "light" | "dark" | "system";
  maxRecentDirectories: number;
  recentDirectories: string[];
  targetDirectories: string[];
  lightboxInFullscreen: boolean;
  enableRawCouplingDetection: boolean;
}
