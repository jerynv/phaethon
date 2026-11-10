import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";
import { announce } from "@/lib/announce";
import { HuePicker } from "./HuePicker";
import { useShell } from "./shell-store";
import { HUE_PRESETS, descriptionProblem, nameProblem, switchSpace, useSpaces } from "./spaces";

/** New space: a name, an optional description, a colour, and whether it's for school. */
export function NewSpaceDialog() {
  const open = useShell((s) => s.newSpaceOpen);
  const setOpen = useShell((s) => s.setNewSpaceOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="max-w-md">{open ? <NewSpaceForm onDone={() => setOpen(false)} /> : null}</DialogPopup>
    </Dialog>
  );
}

function NewSpaceForm({ onDone }: { onDone(): void }) {
  const create = useSpaces((s) => s.create);
  const count = useSpaces((s) => s.spaces.length);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hue, setHue] = useState<number>(HUE_PRESETS[count % HUE_PRESETS.length].value);
  const [education, setEducation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = { name: useId(), description: useId(), hue: useId(), education: useId(), error: useId() };
  const nameError = touched ? nameProblem(name) : null;
  const descriptionError = descriptionProblem(description);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (nameProblem(name) || descriptionError) return;
    setBusy(true);
    setError(null);
    try {
      const space = await create({ name: name.trim(), description: description.trim(), hue, educationEnabled: education });
      switchSpace(space.id);
      announce(`${space.name} created`);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>New space</DialogTitle>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5 space-y-0">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.name} className="font-medium text-sm">
            Name
          </label>
          <Input
            id={ids.name}
            value={name}
            autoFocus
            maxLength={60}
            placeholder="Biology, Thesis, Job search…"
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${ids.name}-error` : undefined}
            onValueChange={(v) => setName(String(v))}
          />
          {nameError ? (
            <p id={`${ids.name}-error`} className="text-destructive-foreground text-sm">
              {nameError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.description} className="font-medium text-sm">
            Description <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id={ids.description}
            value={description}
            maxLength={160}
            aria-invalid={descriptionError ? true : undefined}
            aria-describedby={descriptionError ? `${ids.description}-error` : undefined}
            onValueChange={(v) => setDescription(String(v))}
          />
          {descriptionError ? (
            <p id={`${ids.description}-error`} className="text-destructive-foreground text-sm">
              {descriptionError}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <span id={ids.hue} className="font-medium text-sm">
            Colour
          </span>
          <HuePicker value={hue} onValueChange={setHue} labelId={ids.hue} />
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <label htmlFor={ids.education} className="font-medium text-sm">
              For school
            </label>
            <p className="text-muted-foreground text-sm">Adds Study, Grades, Plan and Courses.</p>
          </div>
          <Switch id={ids.education} checked={education} onCheckedChange={setEducation} />
        </div>
        {error ? (
          <p role="alert" className="rounded-md bg-error-surface px-3 py-2 text-error-foreground text-sm">
            {error}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          Create space
        </Button>
      </DialogFooter>
    </form>
  );
}
