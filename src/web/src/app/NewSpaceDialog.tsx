import { useState } from "react";
import { FieldError } from "@/components/errors";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { api } from "./api";
import { useNav } from "./store";

export const HUES = [262, 200, 155, 95, 50, 20, 330, 290];

/** Creates a space: a name, a colour, and whether it's for school. */
export function NewSpaceDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [name, setName] = useState("");
  const [hue, setHue] = useState(HUES[0]!);
  const [edu, setEdu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadSpaces = useNav((s) => s.loadSpaces);
  const selectSpace = useNav((s) => s.selectSpace);

  const submit = async () => {
    if (!name.trim()) return setError("Give the space a name.");
    setBusy(true);
    setError(null);
    try {
      const space = await api.createSpace({ name: name.trim(), hue, educationEnabled: edu });
      await loadSpaces();
      selectSpace(space.id, "chat");
      toast.success(`${space.name} created`);
      onOpenChange(false);
      setName("");
      setEdu(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>A separate compartment with its own files, conversations and memory.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="space-name">Name</Label>
            <div className="flex items-center gap-2">
              <SpaceAvatar name={name || "S"} hue={hue} className="size-7 rounded-md text-xs" />
              <Input
                id="space-name"
                autoFocus
                value={name}
                maxLength={60}
                aria-invalid={error ? true : undefined}
                placeholder="School, Work, Thesis…"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
            <FieldError>{error}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label>Colour</Label>
            <div className="flex gap-1.5">
              {HUES.map((h) => (
                <button
                  key={h}
                  type="button"
                  aria-label={`Hue ${h}`}
                  aria-pressed={h === hue}
                  onClick={() => setHue(h)}
                  className={cn("size-5 rounded-full ring-offset-2 ring-offset-popover transition-shadow", h === hue && "ring-2 ring-foreground/60")}
                  style={{ background: `oklch(0.62 0.14 ${h})` }}
                />
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
            <span className="flex flex-col">
              <span className="font-medium text-sm">Study tools</span>
              <span className="text-muted-foreground text-xs">Courses, flashcards, quizzes, grades and a study plan.</span>
            </span>
            <Switch checked={edu} onCheckedChange={setEdu} />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy} className="min-w-24">
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Creating…" : "Create space"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
