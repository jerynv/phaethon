import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { RotateCcwIcon, SquarePenIcon } from "lucide-react";
import { useId } from "react";
import { useCurrentSpace } from "@/app/spaces";
import { SpaceMark } from "@/app/SpaceMark";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented";
import { SettingsGroup, SettingsPage, SettingsRow, SettingsSection } from "@/components/ui/settings";
import { Switch } from "@/components/ui/switch";
import { setAppearance, useAppearance } from "@/lib/appearance";
import {
  dials,
  isDefaultAppearance,
  resetAppearance,
  withDial,
  type AccessPref,
  type ReadingFont,
  type ThemePref,
} from "@/lib/appearance-model";
import { cn } from "@/lib/utils";

const FONTS: { value: ReadingFont; label: string; family: string; note: string }[] = [
  { value: "atkinson", label: "Atkinson Hyperlegible", family: '"Atkinson Hyperlegible Next Variable", sans-serif', note: "Letters that are hard to confuse" },
  { value: "opendyslexic", label: "OpenDyslexic", family: '"OpenDyslexic", sans-serif', note: "Weighted letter bottoms" },
  { value: "lexend", label: "Lexend", family: '"Lexend Variable", sans-serif', note: "Wide, even spacing" },
  { value: "system", label: "System font", family: "ui-sans-serif, system-ui, sans-serif", note: "Your computer’s own" },
];

/** A live sample built from the same tokens as the app, so every change shows here first. */
function Preview() {
  const space = useCurrentSpace();
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-border bg-background">
      <div className="flex">
        <div className="hidden w-44 shrink-0 flex-col gap-1 border-e border-border bg-sidebar p-2 sm:flex">
          <div className="flex items-center gap-2 px-1.5 py-1">
            <SpaceMark name={space?.name ?? "School"} hue={space?.hue ?? 240} className="size-5" />
            <span className="truncate font-semibold text-sm">{space?.name ?? "School"}</span>
          </div>
          <div className="flex h-8 items-center gap-2 rounded-md px-2 text-sm">
            <SquarePenIcon className="size-4 text-sidebar-muted-foreground" />
            New chat
          </div>
          <div className="flex h-8 items-center rounded-md bg-sidebar-row-selected px-2 font-medium text-sm">
            <span className="truncate">Strong induction</span>
          </div>
          <div className="flex h-8 items-center rounded-md px-2 text-sm">
            <span className="truncate">Series convergence</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          <div className="self-end rounded-2xl bg-message px-3.5 py-2 text-message-foreground reading">How does strong induction differ?</div>
          <p className="reading max-w-prose text-foreground">
            Ordinary induction assumes only the case just before. Strong induction assumes{" "}
            <span className="font-medium text-space-foreground">every</span> earlier case, which the Fibonacci bound needs.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-8 items-center rounded-lg bg-primary px-3 font-medium text-primary-foreground text-sm">
              Continue
            </span>
            <span className="inline-flex h-8 items-center rounded-lg border border-input px-3 text-sm">Not now</span>
            <span className="text-muted-foreground text-sm">Updated 4 min ago</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FontPicker({ value, onChange, labelId }: { value: ReadingFont; onChange(v: ReadingFont): void; labelId: string }) {
  return (
    <RadioGroupPrimitive
      aria-labelledby={labelId}
      value={value}
      onValueChange={(v) => onChange(v as ReadingFont)}
      className="grid grid-cols-1 gap-2 px-4 pb-4 sm:grid-cols-2"
    >
      {FONTS.map((f) => (
        <RadioPrimitive.Root
          key={f.value}
          value={f.value}
          data-target=""
          className={cn(
            "flex cursor-pointer flex-col items-start gap-1 rounded-lg border border-border bg-background px-3.5 py-3 text-start outline-none",
            "hover:border-input focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            "data-checked:border-primary data-checked:bg-space-soft/50 contrast-more:data-checked:border-2",
          )}
        >
          <span className="text-lg leading-tight" style={{ fontFamily: f.family }}>
            {f.label}
          </span>
          <span className="text-muted-foreground text-sm">{f.note}</span>
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}

export function AppearanceSettings() {
  const { appearance: a, saveState } = useAppearance();
  const d = dials(a);
  const ids = {
    theme: useId(),
    size: useId(),
    font: useId(),
    leading: useId(),
    tracking: useId(),
    words: useId(),
    contrast: useId(),
    motion: useId(),
    rings: useId(),
    targets: useId(),
  };

  const set = <K extends keyof typeof d>(key: K, value: (typeof d)[K]) => setAppearance((prev) => withDial(prev, key, value));

  return (
    <SettingsPage>
      <SettingsSection title="Preview">
        <Preview />
      </SettingsSection>

      <SettingsSection title="Theme">
        <SettingsGroup>
          <SettingsRow
            title="Colour theme"
            labelId={ids.theme}
            control={
              <SegmentedControl<ThemePref>
                aria-labelledby={ids.theme}
                value={a.theme}
                onValueChange={(v) => setAppearance((p) => ({ ...p, theme: v }))}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            }
          />
          <SettingsRow
            title="Contrast"
            labelId={ids.contrast}
            description="More darkens secondary text and borders and makes panels solid."
            control={
              <SegmentedControl<AccessPref>
                aria-labelledby={ids.contrast}
                value={a.increaseContrast}
                onValueChange={(v) => setAppearance((p) => ({ ...p, increaseContrast: v }))}
                options={[
                  { value: "system", label: "System" },
                  { value: "off", label: "Standard" },
                  { value: "on", label: "More" },
                ]}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Text">
        <SettingsGroup>
          <SettingsRow
            title="Text size"
            labelId={ids.size}
            description="Everything grows with it, including spacing."
            control={
              <SegmentedControl
                aria-labelledby={ids.size}
                value={String(d.textScale)}
                onValueChange={(v) => set("textScale", Number(v))}
                options={[
                  { value: "1", label: "100%" },
                  { value: "1.125", label: "112%" },
                  { value: "1.25", label: "125%" },
                  { value: "1.5", label: "150%" },
                  { value: "2", label: "200%" },
                ]}
              />
            }
          />
          <div>
            <SettingsRow title="Reading font" labelId={ids.font} />
            <FontPicker value={a.readingFont} labelId={ids.font} onChange={(v) => setAppearance((p) => ({ ...p, readingFont: v }))} />
          </div>
          <SettingsRow
            title="Line spacing"
            labelId={ids.leading}
            control={
              <SegmentedControl
                aria-labelledby={ids.leading}
                value={String(d.leading)}
                onValueChange={(v) => set("leading", Number(v))}
                options={[
                  { value: "1.55", label: "Standard" },
                  { value: "1.8", label: "Relaxed" },
                  { value: "2.05", label: "Loose" },
                ]}
              />
            }
          />
          <SettingsRow
            title="Letter spacing"
            labelId={ids.tracking}
            control={
              <SegmentedControl
                aria-labelledby={ids.tracking}
                value={String(d.tracking)}
                onValueChange={(v) => set("tracking", Number(v))}
                options={[
                  { value: "0", label: "None" },
                  { value: "0.04", label: "+4%" },
                  { value: "0.08", label: "+8%" },
                  { value: "0.12", label: "+12%" },
                ]}
              />
            }
          />
          <SettingsRow
            title="Word spacing"
            labelId={ids.words}
            control={
              <SegmentedControl
                aria-labelledby={ids.words}
                value={String(d.wordSpacing)}
                onValueChange={(v) => set("wordSpacing", Number(v))}
                options={[
                  { value: "0", label: "None" },
                  { value: "0.08", label: "+8%" },
                  { value: "0.16", label: "+16%" },
                  { value: "0.24", label: "+24%" },
                ]}
              />
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Interaction">
        <SettingsGroup>
          <SettingsRow
            title="Motion"
            labelId={ids.motion}
            control={
              <SegmentedControl<AccessPref>
                aria-labelledby={ids.motion}
                value={a.reduceMotion}
                onValueChange={(v) => setAppearance((p) => ({ ...p, reduceMotion: v }))}
                options={[
                  { value: "system", label: "System" },
                  { value: "on", label: "Reduced" },
                  { value: "off", label: "Full" },
                ]}
              />
            }
          />
          <SettingsRow
            title="Show focus rings"
            htmlFor={ids.rings}
            description="Outlines the control the keyboard is on. Off, the control is tinted instead."
            control={<Switch id={ids.rings} checked={d.focusRings} onCheckedChange={(v) => set("focusRings", v)} />}
          />
          <SettingsRow
            title="Larger click targets"
            htmlFor={ids.targets}
            description="Buttons and rows at least 44 pixels tall."
            control={<Switch id={ids.targets} checked={d.largeTargets} onCheckedChange={(v) => set("largeTargets", v)} />}
          />
        </SettingsGroup>
      </SettingsSection>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <p aria-live="polite" className={cn("text-sm", saveState.status === "error" ? "text-destructive-foreground" : "text-muted-foreground")}>
          {saveState.status === "error" ? `Not saved: ${saveState.error}` : ""}
        </p>
        <Button variant="outline" disabled={isDefaultAppearance(a)} onClick={() => setAppearance((p) => resetAppearance(p))}>
          <RotateCcwIcon />
          Reset to defaults
        </Button>
      </div>
    </SettingsPage>
  );
}
