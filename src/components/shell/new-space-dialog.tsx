import { useId, useRef, useState, type FormEvent } from "react";

import { HueSwatches } from "@/components/settings/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { createSpace, SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, type Space } from "@/lib/spaces";
import { ACCENT_PRESETS } from "@/theme";

/** Soft hues a space can take: the accent presets, so names match Settings. */
export const SPACE_HUES = ACCENT_PRESETS;
/** A space's swatch, as its mark is drawn (--ph-space-mark in light mode). */
export const spaceSwatch = (h: number) => `oklch(0.6 0.09 ${h})`;
export const spaceSwatchCheck = () => "oklch(0.99 0 0)";

/** The preset hue farthest from every hue already in use, so a new space stands apart. */
function freshHue(taken: readonly number[]): number {
  const dist = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
  let best: number = SPACE_HUES[0].value;
  let bestD = -1;
  for (const p of SPACE_HUES) {
    const d = taken.length ? Math.min(...taken.map((t) => dist(t, p.value))) : 360;
    if (d > bestD) [best, bestD] = [p.value, d];
  }
  return best;
}

/**
 * "New space": a name (required), an optional description and a colour.
 * Opened from the sidebar or the empty state. Keyboard: the name field has
 * focus on open, Enter in a field creates, Escape cancels; the colour is a
 * radio group (arrows choose). A missing name is said next to the field and
 * the field takes focus; a refusal from the vault shows as an alert above
 * the buttons. `onCreated` runs with the new space before the dialog closes;
 * `onCloseFocus` decides where focus goes after (true: created). Mount it
 * afresh (a new key) for each opening, so every form starts empty.
 */
export function NewSpaceDialog({
  open,
  onOpenChange,
  existing,
  onCreated,
  onCloseFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existing: readonly Space[];
  onCreated: (space: Space) => void;
  onCloseFocus: (created: boolean) => void;
}) {
  const nameId = useId();
  const nameErrorId = useId();
  const descId = useId();
  const descHintId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hue, setHue] = useState(() => freshHue(existing.map((s) => s.hue)));
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const created = useRef(false);
  const [said, setSaid] = useState("");

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setNameError("Give the space a name.");
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    try {
      const space = await createSpace({ name: name.trim(), description: description.trim(), hue });
      created.current = true;
      onCreated(space);
      setSaid("");
      requestAnimationFrame(() => setSaid(`Created ${space.name}. It’s now the current space.`));
      onOpenChange(false);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          data-new-space-dialog=""
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            nameRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            onCloseFocus(created.current);
          }}
        >
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
            <DialogDescription>A space has its own files and conversation. Phaethon in one space can’t see another unless you allow it.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={nameId} className="text-base font-medium text-ink">
                Name
              </label>
              <Input
                ref={nameRef}
                id={nameId}
                value={name}
                maxLength={SPACE_NAME_MAX}
                autoComplete="off"
                required
                aria-required="true"
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? nameErrorId : undefined}
                placeholder="For example, Home"
                onChange={(e) => {
                  setName(e.target.value);
                  if (nameError) setNameError("");
                }}
              />
              {nameError && (
                <p id={nameErrorId} className="flex items-center gap-1.5 text-sm text-danger-ink">
                  <Icon name="error" className="size-(--ph-icon-size-sm) shrink-0" />
                  {nameError}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={descId} className="text-base font-medium text-ink">
                Description <span className="font-normal text-ink-secondary">(optional)</span>
              </label>
              <Input
                id={descId}
                value={description}
                maxLength={SPACE_DESCRIPTION_MAX}
                autoComplete="off"
                aria-describedby={descHintId}
                onChange={(e) => setDescription(e.target.value)}
              />
              <p id={descHintId} className="text-sm text-ink-secondary">
                Shown under the name in the sidebar.
              </p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="text-base font-medium text-ink">
                Colour
              </span>
              <HueSwatches label="Colour" presets={SPACE_HUES} value={hue} onPick={setHue} swatchColour={spaceSwatch} checkColour={spaceSwatchCheck} />
            </div>
            {error && (
              <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger-ink">
                <Icon name="error" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">The space couldn’t be created. {error}</span>
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} data-create-space="">
                {busy ? "Creating…" : "Create space"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <p role="status" className="sr-only">
        {said}
      </p>
    </>
  );
}
