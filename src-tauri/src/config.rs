use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

fn default_lightbox_in_fullscreen() -> bool {
    true
}

fn default_enable_raw_coupling_detection() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Last directory the user browsed.
    pub last_directory: Option<String>,
    /// UI theme: "light", "dark", or "system".
    pub theme: String,
    /// How many recently-used directories to remember.
    pub max_recent_directories: usize,
    /// Recently-used directories, most recent first.
    pub recent_directories: Vec<String>,
    /// User-curated destination directories that selected photos can be sent to.
    #[serde(default)]
    pub target_directories: Vec<String>,
    /// Whether opening the lightbox should drive the app window in/out of fullscreen.
    #[serde(default = "default_lightbox_in_fullscreen")]
    pub lightbox_in_fullscreen: bool,
    /// Whether RAW coupling auto-detection should run when opening a gallery.
    #[serde(default = "default_enable_raw_coupling_detection")]
    pub enable_raw_coupling_detection: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            last_directory: None,
            theme: "system".to_string(),
            max_recent_directories: 10,
            recent_directories: Vec::new(),
            target_directories: Vec::new(),
            lightbox_in_fullscreen: default_lightbox_in_fullscreen(),
            enable_raw_coupling_detection: default_enable_raw_coupling_detection(),
        }
    }
}

impl Config {
    /// Returns `~/.photopicker` (or `%USERPROFILE%\.photopicker` on Windows).
    pub fn dir() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".photopicker")
    }

    pub fn path() -> PathBuf {
        Self::dir().join("config.json")
    }

    /// Loads config from disk, returning `Default` when the file is absent or unreadable.
    pub fn load() -> Self {
        let path = Self::path();
        if !path.exists() {
            return Self::default();
        }
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persists config to disk, creating `~/.photopicker/` if necessary.
    pub fn save(&self) -> Result<(), String> {
        fs::create_dir_all(Self::dir()).map_err(|e| e.to_string())?;
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(Self::path(), json).map_err(|e| e.to_string())
    }

    /// Adds `dir` to the front of `recent_directories`, deduplicates, and caps the list.
    pub fn push_recent_directory(&mut self, dir: String) {
        self.recent_directories.retain(|d| d != &dir);
        self.recent_directories.insert(0, dir.clone());
        self.recent_directories.truncate(self.max_recent_directories);
        self.last_directory = Some(dir);
    }

    /// Adds `dir` to `target_directories` if not already present (no cap — user-curated).
    pub fn add_target_directory(&mut self, dir: String) {
        if !self.target_directories.contains(&dir) {
            self.target_directories.push(dir);
        }
    }

    /// Removes `dir` from `target_directories` if present.
    pub fn remove_target_directory(&mut self, dir: &str) {
        self.target_directories.retain(|d| d != dir);
    }
}
