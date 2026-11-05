import { Select } from "vic-ui";
import { useId } from "react";

import { effective, setAppearance, setToken, setWideReading, useAppearance, useSystemPrefs } from "@/theme";
import type { ReadingFont } from "@/theme/tokens";

import { SettingGroup, SettingRow, SwitchRow, TokenRow } from "./controls";
import { SectionReset } from "./section-reset";

const FONTS: { value: ReadingFont; label: string; family: string }[] = [
  { value: "atkinson", label: "Atkinson Hyperlegible", family: '"Atkinson Hyperlegible Next Variable", sans-serif' },
  { value: "opendyslexic", label: "OpenDyslexic", family: '"OpenDyslexic", sans-serif' },
  { value: "lexend", label: "Lexend", family: '"Lexend Variable", sans-serif' },
  { value: "system", label: "System font", family: "var(--ph-font-fallback)" },
];

/** Vic renders both the field and floating options; each option previews its real face. */
export function ReadingFontRow() {
  const a = useAppearance();
  const id = useId();
  return (
    <SettingRow label="Reading font" htmlFor={id}>
      <div data-reading-font="">
        <Select id={id} aria-label="Reading font" value={a.readingFont} onValueChange={(value) => setAppearance((p) => ({ ...p, readingFont: value as ReadingFont }))}
          items={FONTS.map((font) => ({ value: font.value, text: font.label, label: <span data-font-preview={font.value} style={{ fontFamily: font.family }}>{font.label}</span> }))} />
      </div>
    </SettingRow>
  );
}

export const ACCESSIBILITY_TOKENS = [
  "--ph-text-scale",
  "--ph-focus-rings",
  "--ph-focus-width",
  "--ph-icon-stroke",
  "--ph-leading-normal",
  "--ph-tracking-normal",
  "--ph-word-spacing",
  "--ph-duration-scale",
  "--ph-target-size",
  "--ph-wide-reading",
] as const;

export function AccessibilitySection({ headingId }: { headingId: string }) {
  const a = useAppearance();
  const sys = useSystemPrefs();
  const now = effective(a, sys);

  return (
    <>
      <SectionReset
        headingId={headingId}
        title="Accessibility"
        what="accessibility"
        tokens={ACCESSIBILITY_TOKENS}
        resetAccess
      />

      <SettingGroup title="Seeing">
        <TokenRow name="--ph-text-scale" quickPicks />
        <SwitchRow
          label="Increase contrast"
          description="Stronger text and borders."
          checked={a.increaseContrast === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, increaseContrast: on ? "on" : "system" }))}
          status={
            a.increaseContrast === "on"
              ? "On"
              : `System: ${sys.moreContrast ? "on" : "off"}`
          }
        />
        <SwitchRow
          token="--ph-focus-rings"
          label="Show focus rings"
          description="Outline the active control."
          checked={Number(a.tokens["--ph-focus-rings"] ?? 0) === 1}
          onChange={(on) => setToken("--ph-focus-rings", on ? 1 : 0)}
          status={Number(a.tokens["--ph-focus-rings"] ?? 0) === 1 ? "On" : "Off"}
        />
        {Number(a.tokens["--ph-focus-rings"] ?? 0) === 1 && (
          <TokenRow name="--ph-focus-width">
            <FocusSample />
          </TokenRow>
        )}
        <TokenRow name="--ph-icon-stroke" />
      </SettingGroup>

      <SettingGroup title="Reading">
        <ReadingFontRow />
        <TokenRow name="--ph-leading-normal" />
        <TokenRow name="--ph-tracking-normal" />
        <TokenRow name="--ph-word-spacing" />
        <WideReadingRow />
        <ReadingSample />
      </SettingGroup>

      <SettingGroup title="Clicking and touch">
        <LargerTargetsRow />
      </SettingGroup>

      <SettingGroup title="Motion">
        <SwitchRow
          label="Reduce motion"
          description="Minimize interface animation."
          checked={a.reduceMotion === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, reduceMotion: on ? "on" : "system" }))}
          status={
            a.reduceMotion === "on"
              ? "On"
              : `System: ${sys.reduceMotion ? "on" : "off"}`
          }
        />
        {now.reduceMotion ? (
          <p className="px-4 py-3.5 text-sm text-ink-secondary">
            Motion reduction is enabled.
          </p>
        ) : (
          <TokenRow name="--ph-duration-scale" />
        )}
      </SettingGroup>
    </>
  );
}

/** Shows the focus ring at the chosen thickness, without needing to tab around. */
function FocusSample() {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-secondary" aria-hidden="true">
      <span
        className="rounded-md bg-raised px-2.5 py-1 whitespace-nowrap text-ink"
        style={{ outline: "var(--ph-focus-width) solid var(--ph-focus)", outlineOffset: "var(--ph-focus-offset)" }}
      >
        Focused button
      </span>
      looks like this
    </div>
  );
}

function ReadingSample() {
  return (
    <div className="px-4 py-3.5">
      <p
        data-reading-sample=""
        className="max-w-(--ph-measure) rounded-md bg-surface-sunken px-4 py-3 text-md text-ink"
        style={{ lineHeight: "var(--ph-leading-normal)", letterSpacing: "var(--ph-tracking-normal)", wordSpacing: "var(--ph-word-spacing)" }}
      >
        Two things are due this week: problem set 4 on Wednesday, and Test 1 on Thursday, which covers chapters 1 to 4. You wanted
        to redo the recursion exercises first, so Monday evening is set aside for that.
      </p>
    </div>
  );
}

/** Wide reading: a switch over the --ph-wide-reading token (the comfortable column, or most of the window). */
function WideReadingRow() {
  const a = useAppearance();
  const on = Number(a.tokens["--ph-wide-reading"] ?? 0) > 0;
  return (
    <SwitchRow
      label="Wide reading"
      description="Use the available conversation width."
      checked={on}
      onChange={(next) => setWideReading(next)}
      status={on ? "On" : "Off"}
    />
  );
}

/** Larger click targets: a switch over the --ph-target-size token (24 or 44 pixels). */
function LargerTargetsRow() {
  const a = useAppearance();
  const on = Number(a.tokens["--ph-target-size"] ?? 24) > 24;
  return (
    <SwitchRow
      label="Larger click targets"
      description="44 px minimum controls."
      checked={on}
      onChange={(next) => setToken("--ph-target-size", next ? 44 : 24)}
      status={on ? "44 px" : "24 px"}
    />
  );
}
