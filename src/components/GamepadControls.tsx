import { ArrowLeft, Gamepad2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

export function GamepadControls({ onBack }: { onBack: () => void }) {
  return (
    <div className="min-h-screen bg-background flex flex-col items-center pt-16 px-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} title="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h1 className="text-2xl font-bold tracking-tight">Gamepad Controls</h1>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center gap-2 pb-2">
            <Gamepad2 className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Lightbox
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <ul>
              <ControlRow label="D-pad / Left stick" value="Previous / next photo" />
              <Separator />
              <ControlRow label="B" value="Close lightbox / back out of chooser" />
              <Separator />
              <ControlRow label="Y" value="Open copy chooser / confirm copy" />
              <Separator />
              <ControlRow label="A" value="Confirm destination in copy/move chooser" />
              <Separator />
              <ControlRow label="LB / RB" value="Rotate counter-clockwise / clockwise (JPEG only)" />
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              Notes
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-4 text-sm text-muted-foreground space-y-2">
            <p>Buttons are edge-triggered. Holding a button does not auto-repeat.</p>
            <p>In destination chooser: up/down changes target, A confirms, B cancels.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ControlRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="w-full flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm text-muted-foreground text-right">{value}</span>
    </li>
  );
}
