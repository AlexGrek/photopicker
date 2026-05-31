//! Per-photo marks (star rating + flag), persisted in a [`sled`] embedded database
//! at `~/.photopicker/database`. Each browsed directory gets its own sled **tree**
//! (named by the directory path), keyed by the photo's file name. Marks are kept
//! out of the photos themselves (no EXIF writes), so culling never touches originals.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::config::Config;

/// A photo's mark. `rating` is 0 (unrated) through 5; `flag` is a simple pick/keep toggle.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Mark {
    #[serde(default)]
    pub rating: u8,
    #[serde(default)]
    pub flag: bool,
}

impl Mark {
    /// A mark with no rating and no flag carries no information worth storing.
    fn is_empty(&self) -> bool {
        self.rating == 0 && !self.flag
    }
}

/// Handle to the marks database. Held in Tauri managed state for the app's lifetime.
pub struct MarksDb(sled::Db);

impl MarksDb {
    /// Opens (creating if needed) the database under `~/.photopicker/database`.
    pub fn open() -> Result<Self, String> {
        let dir = Config::dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let db = sled::open(dir.join("database")).map_err(|e| e.to_string())?;
        Ok(MarksDb(db))
    }

    /// The tree holding one directory's marks. Tree names are the directory path.
    fn tree(&self, dir: &str) -> Result<sled::Tree, String> {
        self.0.open_tree(dir).map_err(|e| e.to_string())
    }

    /// Returns every mark stored for `dir`, keyed by file name.
    pub fn get_all(&self, dir: &str) -> Result<HashMap<String, Mark>, String> {
        let tree = self.tree(dir)?;
        let mut out = HashMap::new();
        for item in tree.iter() {
            let (key, value) = item.map_err(|e| e.to_string())?;
            let name = String::from_utf8_lossy(&key).into_owned();
            if let Ok(mark) = serde_json::from_slice::<Mark>(&value) {
                out.insert(name, mark);
            }
        }
        Ok(out)
    }

    /// Upserts the mark for `name` in `dir`. An empty mark removes the key instead,
    /// keeping the tree tidy. Flushes so a crash can't lose a just-made decision.
    pub fn set(&self, dir: &str, name: &str, mark: &Mark) -> Result<(), String> {
        let tree = self.tree(dir)?;
        if mark.is_empty() {
            tree.remove(name).map_err(|e| e.to_string())?;
        } else {
            let bytes = serde_json::to_vec(mark).map_err(|e| e.to_string())?;
            tree.insert(name, bytes).map_err(|e| e.to_string())?;
        }
        tree.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}
