import { Radio } from "vic-ui";
import { useId, type CSSProperties } from "react";

import { Details } from "@/components/ui/details";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";
import {
  ACCENT_PRESETS,
  NEUTRAL_PRESETS,
  TOKEN_BY_NAME,
  numericValue,
  setAppearance,
  setToken,
  useAppearance,
  useSystemPrefs,
  type NumberToken,
  type ThemePref,
} from "@/theme";

import { DefaultOrReset, HUE_TRACK, HueSwatches, SettingGroup, SettingRow, TokenRow, TokenSlider } from "./controls";
import { ReadingFontRow } from "./accessibility-section";
import { SectionReset } from "./section-reset";
import { useSettingsNav } from "./status";

/**
 * Tokens this page owns; its Reset puts all of them (and the theme) back.
 * Text size is not here: it lives on the Accessibility page alone, so only
 * that page's Reset changes it.
 */
export const APPEARANCE_TOKENS = [
  "--ph-accent-h",
  "--ph-accent-c",
  "--ph-neutral-h",
  "--ph-neutral-c",
  "--ph-weight-normal",
  "--ph-density",
  "--ph-radius-scale",
  "--ph-sidebar-width",
] as const;

export function AppearanceSection({ headingId }: { headingId: string }) {
  const a = useAppearance();
  // Swatches show the accent at the chosen strength, but never so faint that hues blur together.
  const accentC = Math.max(0.06, numericValue(TOKEN_BY_NAME.get("--ph-accent-c")!, a.tokens["--ph-accent-c"]));
  return (
    <>
      <SectionReset
        headingId={headingId}
        title="Appearance"
        what="appearance"
        tokens={APPEARANCE_TOKENS}
        resetTheme
      />
      <SettingGroup title="Theme" bare>
        <ThemeRow />
      </SettingGroup>
      <SettingGroup title="Text">
        <ReadingFontRow />
        <TextSizeLink />
      </SettingGroup>
      <SettingGroup title="Accent">
        <HueRow
          name="--ph-accent-h"
          presets={ACCENT_PRESETS}
          swatch={(h) => `oklch(0.6 ${accentC} ${h})`}
          check={() => "oklch(0.99 0 0)"}
        />
      </SettingGroup>
      <Details summary="Advanced appearance" className="mt-1 [&>summary]:text-sm [&>summary]:font-medium [&>div]:space-y-6">
        <SettingGroup title="Colour tuning">
          <TokenRow name="--ph-accent-c" />
          <HueRow name="--ph-neutral-h" presets={NEUTRAL_PRESETS} swatch={(h) => `oklch(0.9 0.035 ${h})`} check={(h) => `oklch(0.3 0.05 ${h})`} />
          <TokenRow name="--ph-neutral-c" />
        </SettingGroup>
        <SettingGroup title="Layout and type">
          <TokenRow name="--ph-weight-normal" />
          <TokenRow name="--ph-density" />
          <TokenRow name="--ph-radius-scale" />
          <TokenRow name="--ph-sidebar-width" />
        </SettingGroup>
      </Details>
    </>
  );
}

/** Text size (and line, letter and word spacing) are set in Accessibility; this row says so and goes there. */
function TextSizeLink() {
  const { go } = useSettingsNav();
  const a = useAppearance();
  const spec = TOKEN_BY_NAME.get("--ph-text-scale") as NumberToken;
  const value = numericValue(spec, a.tokens["--ph-text-scale"]);
  return (
    <SettingRow label="Text size" token="--ph-text-scale-link">
      <Button
        type="button"
        aria-label={`Text size, ${spec.format(value)}. Open Accessibility`}
        variant="outline"
        size="sm"
        // Wraps rather than spilling when the text is large and the column narrow.
        className="h-auto min-h-(--ph-control-height-sm) max-w-full self-start py-1 text-left whitespace-normal"
        onClick={() => go("accessibility", '[data-token="--ph-text-scale"] input[type="range"]')}
      >
        {spec.format(value)}
        <Icon name="chevron-right" />
      </Button>
    </SettingRow>
  );
}

// ---- Theme ----

const THEMES: { value: ThemePref; label: string; icon: IconName }[] = [
  { value: "system", label: "Match system", icon: "appearance" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** Miniature window colours per theme, from the same dials as tokens.css. */
const MINI = {
  light: {
    bg: "oklch(0.985 var(--ph-neutral-c) var(--ph-neutral-h))",
    side: "oklch(0.955 calc(var(--ph-neutral-c) * 1.5) var(--ph-neutral-h))",
    ink: "oklch(0.45 calc(var(--ph-ink-c) * 0.8) var(--ph-ink-h))",
    faint: "oklch(0.85 calc(var(--ph-neutral-c) * 2) var(--ph-neutral-h))",
    accent: "oklch(0.5 var(--ph-accent-c) var(--ph-accent-h))",
  },
  dark: {
    bg: "oklch(0.2 calc(var(--ph-ink-c) * 0.7) var(--ph-ink-h))",
    side: "oklch(0.24 calc(var(--ph-ink-c) * 0.8) var(--ph-ink-h))",
    ink: "oklch(0.76 calc(var(--ph-neutral-c) * 1.5) var(--ph-neutral-h))",
    faint: "oklch(0.36 var(--ph-ink-c) var(--ph-ink-h))",
    accent: "oklch(0.74 var(--ph-accent-c) var(--ph-accent-h))",
  },
} as const;

function MiniWindow({ theme, style }: { theme: "light" | "dark"; style?: CSSProperties }) {
  const c = MINI[theme];
  return (
    <div className="flex h-full min-w-0 flex-1" style={{ background: c.bg, ...style }}>
      <div className="flex w-1/3 flex-col gap-1 p-1.5" style={{ background: c.side }}>
        <span className="block h-1 w-3/4 rounded-full" style={{ background: c.accent }} />
        <span className="block h-1 w-1/2 rounded-full" style={{ background: c.faint }} />
        <span className="block h-1 w-2/3 rounded-full" style={{ background: c.faint }} />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1 p-1.5">
        <span className="block h-1 w-4/5 rounded-full" style={{ background: c.ink }} />
        <span className="block h-1 w-3/5 rounded-full" style={{ background: c.ink }} />
        <span className="mt-0.5 block h-2 w-1/3 self-end rounded-sm" style={{ background: c.accent }} />
      </div>
    </div>
  );
}

function ThemeRow() {
  const a = useAppearance();
  const sys = useSystemPrefs();
  const statusId = useId();
  return (
    <div className="flex flex-col gap-3">
      <fieldset role="radiogroup" aria-label="Theme" aria-describedby={statusId} className="m-0 grid min-w-0 grid-cols-3 gap-2.5 border-0 p-0">
        {THEMES.map((t) => (
          <label key={t.value} data-theme-card="" data-state={a.theme === t.value ? "checked" : "unchecked"}
            className={cn("group relative flex min-w-0 cursor-pointer flex-col gap-2 rounded-lg border border-line bg-transparent p-1 pb-2 text-left transition-colors duration-(--ph-duration-fast) hover:bg-hover",
              "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-soft/30")}>
            <Radio name={statusId} value={t.value} checked={a.theme === t.value} aria-label={t.label} className="sr-only!"
              onChange={() => setAppearance((p) => ({ ...p, theme: t.value }))} />
            <span data-theme-preview="" className="flex aspect-[5/2] w-full overflow-hidden rounded-md" aria-hidden="true">
              {t.value === "system" ? <><MiniWindow theme="light" /><MiniWindow theme="dark" /></> : <MiniWindow theme={t.value} />}
            </span>
            <span className="flex items-start gap-1.5 px-1 text-sm font-normal text-ink-secondary group-data-[state=checked]:text-ink">
              <Icon name={t.icon} className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0 flex-1 wrap-break-word">{t.label}</span>
              {a.theme === t.value && <Icon name="check" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0 text-accent-ink" />}
            </span>
          </label>
        ))}
      </fieldset>
      <p id={statusId} className="sr-only">
        {a.theme === "system"
          ? `Your system is using ${sys.dark ? "dark" : "light"} mode right now, so Phaethon is too.`
          : `Always ${a.theme}, whatever your system uses.`}
      </p>
    </div>
  );
}

// ---- Hue rows ----

function HueRow({
  name,
  presets,
  swatch,
  check,
}: {
  name: string;
  presets: readonly { label: string; value: number }[];
  swatch: (h: number) => string;
  check: (h: number) => string;
}) {
  const a = useAppearance();
  const spec = TOKEN_BY_NAME.get(name) as NumberToken;
  const value = numericValue(spec, a.tokens[name]);
  const set = (v: number) => setToken(name, v);
  const labelId = useId();
  const descId = useId();
  const sliderLabelId = useId();
  return (
    <SettingRow stacked label={spec.label} labelId={labelId}>
      <span id={descId} className="sr-only">{spec.description}</span>
      <HueSwatches label={spec.label} presets={presets} value={value} onPick={set} swatchColour={swatch} checkColour={check} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span id={sliderLabelId} className="text-sm text-ink-secondary">
          Custom hue
        </span>
        <div className="min-w-(--ph-settings-label-min) flex-1">
          <TokenSlider
            labelId={`${sliderLabelId} ${labelId}`}
            value={value}
            min={spec.min}
            max={spec.max}
            step={spec.step}
            valueText={spec.format(value)}
            onChange={set}
            trackStyle={HUE_TRACK}
          />
        </div>
        <span className="flex items-center gap-2" aria-hidden="true">
          <span data-swatch="" className="size-(--ph-icon-size) rounded-full border border-line-strong" style={{ background: swatch(value) }} />
          <span className="w-[4ch] text-right text-sm text-ink tabular-nums">{Math.round(value)}°</span>
        </span>
        <DefaultOrReset
          changed={value !== spec.default}
          onReset={() => set(spec.default)}
          what={spec.label.toLowerCase()}
          defaultText={spec.format(spec.default)}
        />
      </div>
    </SettingRow>
  );
}
