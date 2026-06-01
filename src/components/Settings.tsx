import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { type Config } from "@/lib/config";
import { shortenPath } from "@/lib/utils";

export function Settings({ onBack }: { onBack: () => void }) {
  const [targetDirs, setTargetDirs] = useState<string[]>([]);
  const [lightboxInFullscreen, setLightboxInFullscreen] = useState(true);
  const [picking, setPicking] = useState(false);
  const [savingFullscreenPref, setSavingFullscreenPref] = useState(false);

  useEffect(() => {
    invoke<Config>("get_config").then((cfg) => {
      setTargetDirs(cfg.targetDirectories);
      setLightboxInFullscreen(cfg.lightboxInFullscreen);
    });
  }, []);

  async function addTarget() {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        const cfg = await invoke<Config>("add_target_directory", { dir: selected });
        setTargetDirs(cfg.targetDirectories);
        setLightboxInFullscreen(cfg.lightboxInFullscreen);
      }
    } finally {
      setPicking(false);
    }
  }

  async function removeTarget(dir: string) {
    const cfg = await invoke<Config>("remove_target_directory", { dir });
    setTargetDirs(cfg.targetDirectories);
    setLightboxInFullscreen(cfg.lightboxInFullscreen);
  }

  async function toggleLightboxFullscreen(next: boolean) {
    if (savingFullscreenPref) return;
    setSavingFullscreenPref(true);
    setLightboxInFullscreen(next);
    try {
      const cfg = await invoke<Config>("get_config");
      const updated: Config = { ...cfg, lightboxInFullscreen: next };
      await invoke("save_config", { config: updated });
    } catch {
      // Revert the UI toggle on save failure so it matches disk state.
      setLightboxInFullscreen((prev) => !prev);
    } finally {
      setSavingFullscreenPref(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center pt-16 px-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} title="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Viewer
            </CardTitle>
          </CardHeader>

          <Separator />

          <CardContent className="pt-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-foreground"
                checked={lightboxInFullscreen}
                disabled={savingFullscreenPref}
                onChange={(e) => toggleLightboxFullscreen(e.target.checked)}
              />
              <span className="text-sm leading-5">
                Enter fullscreen when opening the lightbox
              </span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Target Locations
            </CardTitle>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={addTarget}
              disabled={picking}
              title="Add target location"
            >
              <FolderPlus className="h-4 w-4" />
            </Button>
          </CardHeader>

          <Separator />

          <CardContent className="p-0">
            {targetDirs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">
                No target locations. Press + to add a destination folder.
              </p>
            ) : (
              <ul>
                {targetDirs.map((dir, i) => (
                  <li key={dir}>
                    <div className="w-full flex items-center gap-3 px-4 py-2.5">
                      <FolderInput className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm truncate flex-1" title={dir}>
                        {shortenPath(dir)}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeTarget(dir)}
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                    {i < targetDirs.length - 1 && <Separator />}
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
