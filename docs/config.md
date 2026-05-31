# Config

PhotoPicker stores its configuration in a JSON file under the user's home directory.

| Platform        | Path                                    |
|-----------------|-----------------------------------------|
| macOS / Linux   | `~/.photopicker/config.json`            |
| Windows         | `%USERPROFILE%\.photopicker\config.json` |

The directory is created automatically on first write.

## Schema

```jsonc
{
  "lastDirectory": "/Users/alice/Photos",   // last-browsed directory (null if none)
  "theme": "system",                         // "light" | "dark" | "system"
  "maxRecentDirectories": 10,                // cap on the recent-directories list
  "recentDirectories": [                     // most-recent first
    "/Users/alice/Photos",
    "/Users/alice/Downloads"
  ],
  "targetDirectories": [                     // user-curated destination folders
    "/Users/alice/Keepers"
  ]
}
```

All fields are optional on disk — missing fields fall back to defaults when loaded.

## Defaults

| Field                  | Default    |
|------------------------|------------|
| `lastDirectory`        | `null`     |
| `theme`                | `"system"` |
| `maxRecentDirectories` | `10`       |
| `recentDirectories`    | `[]`       |
| `targetDirectories`    | `[]`       |

## Tauri commands

The config is managed from the Rust backend and exposed to the frontend via three Tauri commands.

### `get_config() → Config`

Loads and returns the current config. Returns defaults when the file does not exist.

```ts
import { invoke } from "@tauri-apps/api/core";
const config = await invoke<Config>("get_config");
```

### `save_config(config: Config) → void`

Replaces the on-disk config with the provided value.

```ts
await invoke("save_config", { config: { ...config, theme: "dark" } });
```

### `push_recent_directory(dir: string) → Config`

Prepends `dir` to `recentDirectories`, deduplicates, caps the list at
`maxRecentDirectories`, updates `lastDirectory`, saves, and returns the
updated config.

```ts
const updated = await invoke<Config>("push_recent_directory", { dir: "/Users/alice/Vacation" });
```

### `add_target_directory(dir: string) → Config`

Appends `dir` to `targetDirectories` if not already present (no cap — this list is
user-curated), saves, and returns the updated config.

```ts
const updated = await invoke<Config>("add_target_directory", { dir: "/Users/alice/Keepers" });
```

### `remove_target_directory(dir: string) → Config`

Removes `dir` from `targetDirectories` if present, saves, and returns the updated config.

```ts
const updated = await invoke<Config>("remove_target_directory", { dir: "/Users/alice/Keepers" });
```

## TypeScript types

```ts
interface Config {
  lastDirectory: string | null;
  theme: "light" | "dark" | "system";
  maxRecentDirectories: number;
  recentDirectories: string[];
  targetDirectories: string[];
}
```
