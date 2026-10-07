import { RadioGroup } from "radix-ui";
import { useId } from "react";

import { effective, setAppearance, setToken, useAppearance, useSystemPrefs } from "@/theme";
import type { ReadingFont } from "@/theme/tokens";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

import { SettingGroup, SwitchRow, TokenRow, radioArrowKeys } from "./controls";

/** Reading-font choices. Each card shows its sample in its own face. */
const FONTS: { value: ReadingFont; label: string; description: string; family: string }[] = [
  {
    value: "atkinson",
    label: "Atkinson Hyperlegible",
    description: "The default. Made for low vision: letters that are easy to tell apart.",
    family: "\"Atkinson Hyperlegible Next Variable\", var(--ph-font-fallback)",
  },
  {
    value: "opendyslexic",
    label: "OpenDyslexic",
    description: "Weighted letter bottoms that some people with dyslexia find easier to follow.",
    family: "\"OpenDyslexic\", var(--ph-font-fallback)",
  },
  {
    value: "lexend",
    label: "Lexend",
    description: "Wide, simple letters designed to make reading flow more easily.",
    family: "\"Lexend Variable\", var(--ph-font-fallback)",
  },
  {
    value: "system",
    label: "System font",
    description: "Your computer’s own interface font.",
    family: "var(--ph-font-fallback)",
  },
];

/** Typeface for all text in Phaethon; code keeps its own monospace font. */
export function ReadingFontRow() {
  const a = useAppearance();
  const labelId = useId();
  const descId = useId();
  const pick = (v: string) => setAppearance((p) => ({ ...p, readingFont: v as ReadingFont }));
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <div className="flex flex-col gap-0.5">
        <span id={labelId} className="text-base font-medium text-ink">
          Reading font
        </span>
        <p id={descId} className="max-w-(--ph-measure) text-sm text-ink-secondary">
          The typeface for everything in Phaethon. Code keeps its own font. Try them on the sample.
        </p>
      </div>
      <RadioGroup.Root
        aria-labelledby={labelId}
        aria-describedby={descId}
        value={a.readingFont}
        onValueChange={pick}
        onKeyDownCapture={radioArrowKeys(pick)}
        orientation="horizontal"
        loop
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,var(--ph-font-card-min)),1fr))] gap-3"
      >
        {FONTS.map((f) => (
          <RadioGroup.Item
            key={f.value}
            value={f.value}
            data-font-card={f.value}
            className={cn(
              "group flex min-w-0 flex-col items-start gap-1.5 rounded-lg border border-line-strong bg-raised p-3 text-left transition-colors duration-(--ph-duration-fast) hover:border-ink-tertiary",
              "data-[state=checked]:border-accent-fill data-[state=checked]:shadow-[0_0_0_var(--ph-border-width)_var(--ph-accent)]",
            )}
          >
            <span className="flex w-full items-start gap-1.5">
              <span className="min-w-0 flex-1 text-base text-ink group-data-[state=checked]:font-semibold" style={{ fontFamily: f.family }}>
                {f.label}
              </span>
              <RadioGroup.Indicator className="mt-0.5 shrink-0 text-accent-ink">
                <Icon name="check" className="size-(--ph-icon-size-sm)" />
              </RadioGroup.Indicator>
            </span>
            <span className="text-md text-ink" style={{ fontFamily: f.family }} aria-hidden="true">
              Pack my box with five dozen liquor jugs.
            </span>
            <span className="text-sm text-ink-secondary">{f.description}</span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
    </div>
  );
}
import { SectionReset } from "./section-reset";

export const ACCESSIBILITY_TOKENS = [
  "--ph-text-scale",
  "--ph-focus-width",
  "--ph-icon-stroke",
  "--ph-leading-normal",
  "--ph-tracking-normal",
  "--ph-duration-scale",
  "--ph-target-size",
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
        description="Make Phaethon easier to see, read and use. Your system’s accessibility settings are followed unless you turn something on here."
        what="accessibility"
        tokens={ACCESSIBILITY_TOKENS}
        resetAccess
      />

      <SettingGroup title="Seeing">
        <TokenRow name="--ph-text-scale" quickPicks />
        <SwitchRow
          label="Increase contrast"
          description="Darker text, visible borders and a stronger focus ring, in light and dark themes."
          checked={a.increaseContrast === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, increaseContrast: on ? "on" : "system" }))}
          status={
            a.increaseContrast === "on"
              ? "On in Phaethon, whatever your system uses."
              : `Following your system, which has it ${sys.moreContrast ? "on" : "off"}.`
          }
        />
        <TokenRow name="--ph-focus-width">
          <FocusSample />
        </TokenRow>
        <TokenRow name="--ph-icon-stroke" />
      </SettingGroup>

      <SettingGroup title="Reading" description="Font and spacing changes show in the sample below and across Phaethon as you make them.">
        <ReadingFontRow />
        <TokenRow name="--ph-leading-normal" />
        <TokenRow name="--ph-tracking-normal" />
        <ReadingSample />
      </SettingGroup>

      <SettingGroup title="Clicking and touch">
        <LargerTargetsRow />
      </SettingGroup>

      <SettingGroup title="Motion">
        <SwitchRow
          label="Reduce motion"
          description="Turns off animation: panels and messages appear without moving or fading."
          checked={a.reduceMotion === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, reduceMotion: on ? "on" : "system" }))}
          status={
            a.reduceMotion === "on"
              ? "On in Phaethon, whatever your system uses."
              : `Following your system, which has it ${sys.reduceMotion ? "on" : "off"}.`
          }
        />
        {now.reduceMotion ? (
          <p className="px-4 py-3.5 text-sm text-ink-secondary">
            Animation length is not shown while motion is reduced: every change is already instant.
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
        className="max-w-(--ph-measure) rounded-md bg-surface-sunken px-4 py-3 text-md text-ink"
        style={{ lineHeight: "var(--ph-leading-normal)", letterSpacing: "var(--ph-tracking-normal)" }}
      >
        Two things are due this week: problem set 4 on Wednesday, and Test 1 on Thursday, which covers chapters 1 to 4. You wanted
        to redo the recursion exercises first, so Monday evening is set aside for that.
      </p>
    </div>
  );
}

/** Larger click targets: a switch over the --ph-target-size token (24 or 44 pixels). */
function LargerTargetsRow() {
  const a = useAppearance();
  const on = Number(a.tokens["--ph-target-size"] ?? 24) > 24;
  return (
    <SwitchRow
      label="Larger click targets"
      description="Makes buttons, switches and other controls at least 44 pixels across, so they are easier to hit with a shaky hand, a head pointer or dwell clicking."
      checked={on}
      onChange={(next) => setToken("--ph-target-size", next ? 44 : 24)}
      status={on ? "On: controls are at least 44 by 44 pixels." : "Off: controls are at least 24 by 24 pixels, the usual desktop size."}
    />
  );
}
