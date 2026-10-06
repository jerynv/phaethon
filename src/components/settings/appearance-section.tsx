import { RadioGroup } from "radix-ui";
import { useId, type CSSProperties } from "react";

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
import { SectionReset } from "./section-reset";

/** Tokens this page owns; its Reset puts all of them (and the theme) back. */
export const APPEARANCE_TOKENS = [
  "--ph-accent-h",
  "--ph-accent-c",
  "--ph-neutral-h",
  "--ph-neutral-c",
  "--ph-text-scale",
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
        description="How Phaethon looks. Changes apply as you make them and are saved in this vault, so they follow it to other computers."
        what="appearance"
        tokens={APPEARANCE_TOKENS}
        resetTheme
      />
      <SettingGroup title="Theme" description="Light, dark, or whatever your computer is set to.">
        <ThemeRow />
      </SettingGroup>
      <SettingGroup title="Colour" description="Colours stay soft and keep text readable whatever you pick.">
        <HueRow
          name="--ph-accent-h"
          presets={ACCENT_PRESETS}
          swatch={(h) => `oklch(0.6 ${accentC} ${h})`}
          check={() => "oklch(0.99 0 0)"}
        />
        <TokenRow name="--ph-accent-c" />
        <HueRow
          name="--ph-neutral-h"
          presets={NEUTRAL_PRESETS}
          swatch={(h) => `oklch(0.9 0.035 ${h})`}
          check={(h) => `oklch(0.3 0.05 ${h})`}
        />
        <TokenRow name="--ph-neutral-c" />
      </SettingGroup>
      <SettingGroup title="Text">
        <TokenRow name="--ph-text-scale" quickPicks />
        <TokenRow name="--ph-weight-normal" />
      </SettingGroup>
      <SettingGroup title="Layout">
        <TokenRow name="--ph-density" />
        <TokenRow name="--ph-radius-scale" />
        <TokenRow name="--ph-sidebar-width" />
      </SettingGroup>
    </>
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
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <RadioGroup.Root
        aria-label="Theme"
        aria-describedby={statusId}
        value={a.theme}
        onValueChange={(v) => setAppearance((p) => ({ ...p, theme: v as ThemePref }))}
        orientation="horizontal"
        loop
        className="grid grid-cols-3 gap-3"
      >
        {THEMES.map((t) => (
          <RadioGroup.Item
            key={t.value}
            value={t.value}
            className={cn(
              "group flex min-w-0 flex-col gap-2 rounded-lg border border-line-strong bg-raised p-1.5 pb-2 text-left transition-colors duration-(--ph-duration-fast) hover:border-ink-tertiary",
              "data-[state=checked]:border-accent-fill data-[state=checked]:shadow-[0_0_0_var(--ph-border-width)_var(--ph-accent)]",
            )}
          >
            <span className="flex h-(--ph-theme-preview-height) overflow-hidden rounded-md border border-line" aria-hidden="true">
              {t.value === "system" ? (
                <>
                  <MiniWindow theme="light" />
                  <MiniWindow theme="dark" />
                </>
              ) : (
                <MiniWindow theme={t.value} />
              )}
            </span>
            <span className="flex items-center gap-1.5 px-1 text-sm text-ink-secondary group-data-[state=checked]:font-semibold group-data-[state=checked]:text-ink">
              <Icon name={t.icon} className="size-(--ph-icon-size-sm)" />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              <RadioGroup.Indicator className="text-accent-ink">
                <Icon name="check" className="size-(--ph-icon-size-sm)" />
              </RadioGroup.Indicator>
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      <p id={statusId} className="text-sm text-ink-secondary">
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
    <SettingRow stacked label={spec.label} labelId={labelId} description={spec.description} descriptionId={descId}>
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
          <span className="size-(--ph-icon-size) rounded-full border border-line-strong" style={{ background: swatch(value) }} />
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
