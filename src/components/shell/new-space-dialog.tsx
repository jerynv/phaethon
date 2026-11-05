import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { NativeSelect, Switch } from "vic-ui";

import { HueSwatches } from "@/components/settings/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { setFullAccess } from "@/lib/full-access";
import { getSettings } from "@/lib/backend";
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

/** Details and workspace options are separate steps, following T3 Code's project setup flow. */
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
  const educationId = useId();
  const accessId = useId();
  const [access, setAccess] = useState<"full" | "workspace">("full");
  const pendingCreated = useRef<Space | null>(null);
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<"details" | "workspace">("details");
  const [educationEnabled, setEducationEnabled] = useState(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  useEffect(() => { getSettings().then((settings) => setVaultPath(settings.vaultPath ?? null), () => {}); }, []);
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hue, setHue] = useState(() => freshHue(existing.map((s) => s.hue)));
  const [nameError, setNameError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const created = useRef(false);
  const [said, setSaid] = useState("");

  useLayoutEffect(() => {
    if (open) (step === "workspace" ? workspaceHeading.current : nameRef.current)?.focus();
  }, [open, step]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) {
      setNameError("Give the space a name.");
      nameRef.current?.focus();
      return;
    }
    if (step === "details") {
      setStep("workspace");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const space = pendingCreated.current ?? await createSpace({ name: name.trim(), description: description.trim(), hue, educationEnabled });
      pendingCreated.current = space;
      await setFullAccess(space.id, access === "full");
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
            <DialogDescription className="sr-only">Name a space and choose its workspace options.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 text-xs text-ink-secondary" aria-label="Setup progress"><span className={step === "details" ? "font-medium text-ink" : ""}>1. Details</span><Icon name="chevron-right" className="size-(--ph-icon-size-sm)" /><span className={step === "workspace" ? "font-medium text-ink" : ""}>2. Workspace</span></div>
          <form onSubmit={(e) => void submit(e)} noValidate className="flex flex-col gap-4">
            <div hidden={step !== "details"} className="flex flex-col gap-4">
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
                placeholder="Projects, notes and plans for home"
                value={description}
                maxLength={SPACE_DESCRIPTION_MAX}
                autoComplete="off"
                  onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="text-base font-medium text-ink">
                Colour
              </span>
              <HueSwatches label="Colour" presets={SPACE_HUES} value={hue} onPick={setHue} swatchColour={spaceSwatch} checkColour={spaceSwatchCheck} />
            </div>
            </div>
          <div hidden={step !== "workspace"} className="flex flex-col gap-4" data-new-space-workspace="">
            <div><h3 ref={workspaceHeading} tabIndex={-1} className="text-base font-medium text-ink outline-none">{name.trim()}</h3>{description.trim() && <p className="mt-1 text-sm text-ink-secondary">{description.trim()}</p>}</div>
            <div className="flex items-center gap-3 rounded-lg border border-line px-3.5 py-3"><Icon name="folder" className="shrink-0 text-ink-tertiary" /><div className="min-w-0"><p className="text-sm font-medium text-ink">Workspace location</p><code className="mt-1 block text-xs wrap-anywhere text-ink-secondary">{vaultPath ? `${vaultPath}/spaces/` : "Phaethon/spaces/"}</code></div></div>
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3.5 py-3"><label htmlFor={accessId} className="min-w-0 flex-1 text-sm font-medium text-ink">Agent access</label><NativeSelect id={accessId} data-new-space-access="" className="max-w-full" value={access} onChange={(e) => setAccess(e.target.value as "full" | "workspace")}><option value="full">Full access</option><option value="workspace">Workspace only</option></NativeSelect></div>
            <div className="flex items-center gap-4 rounded-lg border border-line px-3.5 py-3"><div className="min-w-0 flex-1"><label htmlFor={educationId} className="text-sm font-medium text-ink">Education</label><p className="mt-0.5 text-xs text-ink-secondary">Study, grades and planning.</p></div><Switch look="flat" id={educationId} data-new-space-education="" checked={educationEnabled} onCheckedChange={setEducationEnabled} className="shrink-0" /></div>
          </div>
          {error && (
              <p role="alert" className="flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger-ink">
                <Icon name="error" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">{pendingCreated.current ? "Space created. Access could not be saved." : "The space couldn’t be created."} {error}</span>
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => { if (step === "workspace") setStep("details"); else onOpenChange(false); }} disabled={busy || !!pendingCreated.current}>
                {step === "workspace" ? "Back" : "Cancel"}
              </Button>
              <Button type="submit" disabled={busy} data-create-space={step === "workspace" ? "" : undefined} data-next-space={step === "details" ? "" : undefined}>
                {busy ? "Creating…" : step === "details" ? "Continue" : pendingCreated.current ? "Retry setup" : "Create space"}
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
