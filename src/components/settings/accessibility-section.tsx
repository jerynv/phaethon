import { effective, setAppearance, useAppearance, useSystemPrefs } from "@/theme";
import { Icon } from "@/icons";

import { SettingGroup, SwitchRow, TokenRow } from "./controls";
import { SectionReset } from "./section-reset";

export const ACCESSIBILITY_TOKENS = [
  "--st-text-scale",
  "--st-focus-width",
  "--st-icon-stroke",
  "--st-leading-normal",
  "--st-tracking-normal",
  "--st-duration-scale",
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
        description="Make steward easier to see, read and use. Your system's accessibility settings are followed unless you turn something on here."
        what="accessibility"
        tokens={ACCESSIBILITY_TOKENS}
        resetAccess
      />

      <SettingGroup title="Seeing">
        <TokenRow name="--st-text-scale" quickPicks />
        <SwitchRow
          label="Increase contrast"
          description="Darker text, visible borders and a stronger focus ring, in light and dark themes."
          checked={a.increaseContrast === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, increaseContrast: on ? "on" : "system" }))}
          status={
            a.increaseContrast === "on"
              ? "On in steward, whatever your system uses."
              : `Following your system, which has it ${sys.moreContrast ? "on" : "off"}.`
          }
        />
        <TokenRow name="--st-focus-width">
          <FocusSample />
        </TokenRow>
        <TokenRow name="--st-icon-stroke" />
      </SettingGroup>

      <SettingGroup title="Reading" description="Spacing changes show in the sample below and across steward as you move them.">
        <TokenRow name="--st-leading-normal" />
        <TokenRow name="--st-tracking-normal" />
        <ReadingSample />
      </SettingGroup>

      <SettingGroup title="Motion">
        <SwitchRow
          label="Reduce motion"
          description="Turns off animation: panels and messages appear without moving or fading."
          checked={a.reduceMotion === "on"}
          onChange={(on) => setAppearance((p) => ({ ...p, reduceMotion: on ? "on" : "system" }))}
          status={
            a.reduceMotion === "on"
              ? "On in steward, whatever your system uses."
              : `Following your system, which has it ${sys.reduceMotion ? "on" : "off"}.`
          }
        />
        {now.reduceMotion ? (
          <p className="px-4 py-3.5 text-sm text-ink-secondary">
            Animation length is not shown while motion is reduced: every change is already instant.
          </p>
        ) : (
          <TokenRow name="--st-duration-scale" />
        )}
      </SettingGroup>

      <aside aria-labelledby="a11y-next" className="flex gap-3 rounded-lg bg-surface px-4 py-3.5 text-sm text-ink-secondary">
        <Icon name="info" className="mt-0.5 text-ink-tertiary" />
        <div className="flex flex-col gap-1">
          <h4 id="a11y-next" className="text-base font-medium text-ink">
            More is coming
          </h4>
          <p className="max-w-(--st-measure)">
            Next: how much screen readers announce while the agent works, a choice of reading fonts, colour filters, larger click
            targets, and keyboard shortcuts you can change. Disabled testers are shaping this list, and the settings above already
            apply everywhere in steward.
          </p>
        </div>
      </aside>
    </>
  );
}

/** Shows the focus ring at the chosen thickness, without needing to tab around. */
function FocusSample() {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-secondary" aria-hidden="true">
      <span
        className="rounded-md bg-raised px-2.5 py-1 whitespace-nowrap text-ink"
        style={{ outline: "var(--st-focus-width) solid var(--st-focus)", outlineOffset: "var(--st-focus-offset)" }}
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
        className="max-w-(--st-measure) rounded-md bg-surface-sunken px-4 py-3 text-md text-ink"
        style={{ lineHeight: "var(--st-leading-normal)", letterSpacing: "var(--st-tracking-normal)" }}
      >
        Two things are due this week: problem set 4 on Wednesday, and Test 1 on Thursday, which covers chapters 1 to 4. You wanted
        to redo the recursion exercises first, so Monday evening is set aside for that.
      </p>
    </div>
  );
}
