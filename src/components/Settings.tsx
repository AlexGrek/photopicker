import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { ArrowLeft, FolderInput, FolderPlus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { configCommand, loadConfig, updateConfig, useConfig } from "@/lib/config";
import { shortenPath } from "@/lib/utils";

export function Settings({ onBack }: { onBack: () => void }) {
  const config = useConfig();
  const targetDirs = config?.targetDirectories ?? [];
  const lightboxInFullscreen = config?.lightboxInFullscreen ?? true;
  const enableRawCouplingDetection = config?.enableRawCouplingDetection ?? true;
  const [picking, setPicking] = useState(false);
  const [savingFullscreenPref, setSavingFullscreenPref] = useState(false);
  const [savingRawCouplingPref, setSavingRawCouplingPref] = useState(false);

  useEffect(() => {
    void loadConfig().catch(() => {});
  }, []);

  async function addTarget() {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await open({ directory: true, multiple: false });
      if (typeof selected === "string") {
        await configCommand("add_target_directory", { dir: selected });
      }
    } finally {
      setPicking(false);
    }
  }

  async function removeTarget(dir: string) {
    await configCommand("remove_target_directory", { dir });
  }

  // `updateConfig` flips the cached value at once and restores it if saving fails.
  async function toggleLightboxFullscreen(next: boolean) {
    if (savingFullscreenPref) return;
    setSavingFullscreenPref(true);
    try {
      await updateConfig({ lightboxInFullscreen: next });
    } catch {
      /* reverted by updateConfig */
    } finally {
      setSavingFullscreenPref(false);
    }
  }

  async function toggleRawCouplingDetection(next: boolean) {
    if (savingRawCouplingPref) return;
    setSavingRawCouplingPref(true);
    try {
      await updateConfig({ enableRawCouplingDetection: next });
    } catch {
      /* reverted by updateConfig */
    } finally {
      setSavingRawCouplingPref(false);
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
            <div className="flex items-start gap-3">
              <Checkbox
                id="lightbox-fullscreen"
                className="mt-0.5"
                checked={lightboxInFullscreen}
                disabled={savingFullscreenPref}
                onCheckedChange={(checked) => toggleLightboxFullscreen(checked === true)}
              />
              <label htmlFor="lightbox-fullscreen" className="text-sm leading-5 cursor-pointer">
                Enter fullscreen when opening the lightbox
              </label>
            </div>
            <div className="mt-3 flex items-start gap-3 opacity-60" title="Coming soon">
              <Checkbox id="load-full-raw" className="mt-0.5" checked={false} disabled />
              <label htmlFor="load-full-raw" className="text-sm leading-5 cursor-not-allowed">
                Load full RAW
                <span className="block text-xs text-muted-foreground">Coming soon (embedded previews only for now)</span>
              </label>
            </div>
            <div className="flex items-start gap-3 mt-3">
              <Checkbox
                id="raw-coupling"
                className="mt-0.5"
                checked={enableRawCouplingDetection}
                disabled={savingRawCouplingPref}
                onCheckedChange={(checked) => toggleRawCouplingDetection(checked === true)}
              />
              <label htmlFor="raw-coupling" className="text-sm leading-5 cursor-pointer">
                Enable raw coupling detection
                <span className="block text-xs text-muted-foreground">
                  When a JPG and RAW share the same base name, the gallery shows only the JPG while copy, move, and
                  delete actions affect both files.
                </span>
              </label>
            </div>
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
