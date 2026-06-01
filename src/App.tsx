import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Gamepad2, Plus, Settings as SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Gallery } from "@/components/Gallery";
import { GamepadControls } from "@/components/GamepadControls";
import { Settings } from "@/components/Settings";
import { type Config } from "@/lib/config";
import { shortenPath } from "@/lib/utils";

type View =
  | { kind: "menu" }
  | { kind: "gallery"; dir: string; openFile?: string }
  | { kind: "settings" }
  | { kind: "gamepadControls" };

/** An OS "Open with" / file-association request, resolved by the Rust backend. */
interface OpenTarget {
  dir: string;
  /** File name within `dir` to pop straight into the lightbox, or null for a folder. */
  file: string | null;
}

export default function App() {
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [view, setView] = useState<View>({ kind: "menu" });

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    let theme: Config["theme"] = "system";
    const applyTheme = () => {
      const shouldUseDark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.classList.toggle("dark", shouldUseDark);
    };
    const onSystemThemeChange = () => {
      if (theme === "system") applyTheme();
    };

    media.addEventListener("change", onSystemThemeChange);

    void invoke<Config>("get_config").then((cfg) => {
      setRecentDirs(cfg.recentDirectories);
      theme = cfg.theme;
      applyTheme();
    });

    return () => {
      media.removeEventListener("change", onSystemThemeChange);
    };
  }, []);

  // Handle photos/folders the OS hands us via a file association or "Open with":
  // a launch-time request is drained once we mount, later ones arrive as events.
  // A file jumps straight into the lightbox; a folder just opens the gallery.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const openTarget = (t: OpenTarget) => void openDirectory(t.dir, t.file ?? undefined);
    void listen<OpenTarget>("open-target", (e) => openTarget(e.payload)).then((un) => {
      if (alive) unlisten = un;
      else un();
    });
    void invoke<OpenTarget | null>("take_pending_open").then((t) => {
      if (alive && t) openTarget(t);
    });
    return () => {
      alive = false;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDirectory(dir: string, openFile?: string) {
    const cfg = await invoke<Config>("push_recent_directory", { dir });
    setRecentDirs(cfg.recentDirectories);
    setView({ kind: "gallery", dir, openFile });
  }

  async function addDirectory() {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await openDirectory(selected);
      }
    } finally {
      setPicking(false);
    }
  }

  if (view.kind === "gallery") {
    return (
      <Gallery
        dir={view.dir}
        initialFile={view.openFile}
        onBack={() => setView({ kind: "menu" })}
      />
    );
  }

  if (view.kind === "settings") {
    return <Settings onBack={() => setView({ kind: "menu" })} />;
  }

  if (view.kind === "gamepadControls") {
    return <GamepadControls onBack={() => setView({ kind: "menu" })} />;
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center pt-16 px-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">PhotoPicker</h1>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setView({ kind: "gamepadControls" })}
              title="Gamepad controls"
            >
              <Gamepad2 className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setView({ kind: "settings" })}
              title="Settings"
            >
              <SettingsIcon className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Last Locations
            </CardTitle>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={addDirectory}
              disabled={picking}
              title="Add folder"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </CardHeader>

          <Separator />

          <CardContent className="p-0">
            {recentDirs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No recent locations. Press + to add a folder.
              </p>
            ) : (
              <ul>
                {recentDirs.map((dir, i) => (
                  <li key={dir}>
                    <button
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-accent hover:text-accent-foreground transition-colors"
                      title={dir}
                      onClick={() => openDirectory(dir)}
                    >
                      <FolderOpen className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate">{shortenPath(dir)}</span>
                    </button>
                    {i < recentDirs.length - 1 && <Separator />}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
