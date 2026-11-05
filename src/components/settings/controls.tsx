/**
 * Building blocks for settings pages: groups, rows, token sliders, swatches,
 * switches. Every control applies its change at once (see src/theme) and shows
 * its default, with a Reset when it differs.
 *
 * Vic radios keep native keyboard selection. The stepped slider retains its
 * pointer policy until the upstream reusable slider contract is adopted.
 */
import { Radio, Slider, Switch, SettingsSection, SettingsGroup, SettingsRow } from "vic-ui";
import { Fragment, useId, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import {
  TOKEN_BY_NAME,
  numericValue,
  setToken,
  useAppearance,
  type NumberToken,
  type LengthToken,
} from "@/theme";

import { useStatus } from "./status";

// ---- Page structure ----

export function SectionHeader({
  id,
  title,
  description,
  action,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return <SettingsSection data-section-header="" title={title} titleId={id} description={description} actions={action}
    headingLevel={3} headingProps={{ tabIndex: -1, className: "text-xl! font-medium! tracking-tight" }} />;
}

/**
 * T3 SettingsSection + SettingsGroup: a titled, contained group. A plain
 * block with a heading, not a region landmark: a page of groups would otherwise
 * be a page of landmarks.
 */
export function SettingGroup({
  title,
  titleId,
  description,
  children,
  bare,
  action,
}: {
  title: string;
  /** The heading's id, for a control inside that is labelled by it. */
  titleId?: string;
  description?: ReactNode;
  children: ReactNode;
  /** No surrounding card: for content that is itself a set of cards (radio cards). */
  bare?: boolean;
  action?: ReactNode;
}) {
  const ownId = useId();
  return <SettingsGroup data-settings-group="" title={title} titleId={titleId ?? ownId} description={description} actions={action}
    headingLevel={4} headingProps={{ className: "text-base! font-medium!" }} surface={bare ? "flat" : "bordered"}>{children}</SettingsGroup>;
}

/**
 * One setting: label and description on the left, control on the right. Wraps
 * the control underneath when the window is narrow or the text is large.
 */
export function SettingRow({
  label,
  labelId,
  htmlFor,
  description,
  descriptionId,
  children,
  stacked,
  alignStart,
  token,
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
  /** Put the control below the label at full width (swatches, theme cards). */
  stacked?: boolean;
  /** Align a multi-line control with its first row, rather than its full height. */
  alignStart?: boolean;
  /** The token this row sets, so another page can find and focus it. */
  token?: string;
}) {
  return <SettingsRow data-setting-row="" data-token={token} label={label} labelId={labelId} htmlFor={htmlFor}
    description={description} descriptionId={descriptionId} stacked={stacked} align={alignStart ? "start" : "center"}
    style={{ "--settings-control-width": "var(--ph-settings-control-width)" } as React.CSSProperties}>{children}</SettingsRow>;
}

/**
 * "Default" when unchanged, a Reset button when not. Same place, so nothing
 * jumps. Reset removes the button, so focus moves to the row's slider rather
 * than falling back to the page.
 */
export function DefaultOrReset({ changed, onReset, what, defaultText }: { changed: boolean; onReset: () => void; what: string; defaultText: string }) {
  const { say } = useStatus();
  return changed ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={(e) => {
        const row = e.currentTarget.closest("[data-setting-row]");
        onReset();
        say(`${what[0].toUpperCase()}${what.slice(1)} reset to ${defaultText}.`);
        requestAnimationFrame(() => row?.querySelector<HTMLElement>('input[type="range"]')?.focus());
      }}
      aria-label={`Reset ${what} to ${defaultText}`}
      className="-my-1 -mr-1.5 min-h-(--ph-target-min) text-accent-ink"
    >
      <Icon name="retry" className="size-(--ph-icon-size-sm)" />
      Reset
    </Button>
  ) : (
    <span className="sr-only">Default</span>
  );
}

// ---- Sliders ----

type SliderSpec = NumberToken | LengthToken;

function useTokenNumber(name: string) {
  const a = useAppearance();
  const found = TOKEN_BY_NAME.get(name);
  if (!found || found.kind === "colour") throw new Error(`${name} is not a number token`);
  const spec: SliderSpec = found;
  const value = numericValue(spec, a.tokens[name]);
  const set = (v: number) => setToken(name, spec.kind === "length" ? `${v}${spec.unit}` : v);
  return { spec, value, set, changed: value !== spec.default };
}

export function TokenSlider({
  label,
  labelId,
  descriptionId,
  value,
  min,
  max,
  step,
  valueText,
  onChange,
  trackStyle,
}: {
  label?: string;
  labelId?: string;
  descriptionId?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  valueText: string;
  onChange: (v: number) => void;
  /** A custom track (the hue rainbow). Hides the filled range. */
  trackStyle?: React.CSSProperties;
}) {
  return <Slider value={value} min={min} max={max} step={step} valueText={valueText} onValueChange={onChange}
    aria-label={labelId ? undefined : label} aria-labelledby={labelId} aria-describedby={descriptionId}
    trackStyle={trackStyle} trackPress="step" className="w-full" />;
}

/** A full row for one number or length token: label, description, slider, value, Reset. */
export function TokenRow({ name, quickPicks, children }: { name: string; quickPicks?: boolean; children?: ReactNode }) {
  const { spec, value, set, changed } = useTokenNumber(name);
  const labelId = useId();
  const descId = useId();
  return (
    <SettingRow token={name} label={<span title={spec.description}>{spec.label}</span>} labelId={labelId} alignStart={quickPicks}>
      <span id={descId} className="sr-only">{spec.description}</span>
      <div className="flex items-center gap-3">
        <output className="min-w-10 shrink-0 text-end text-xs text-ink-secondary tabular-nums" aria-hidden="true">{spec.format(value)}</output>
        <TokenSlider
          labelId={labelId}
          descriptionId={descId}
          value={value}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          valueText={spec.format(value)}
          onChange={set}
        />
        <DefaultOrReset changed={changed} onReset={() => set(spec.default)} what={spec.label.toLowerCase()} defaultText={spec.format(spec.default)} />
      </div>
      {quickPicks && spec.kind === "number" && spec.presets && (
        <QuickPicks label={spec.label} presets={spec.presets} value={value} onPick={set} format={spec.format} />
      )}
      {children}
    </SettingRow>
  );
}

/** Named stops as small toggle buttons, for people who find sliders fiddly. */
function QuickPicks({
  label,
  presets,
  value,
  onPick,
  format,
}: {
  label: string;
  presets: readonly { label: string; value: number }[];
  value: number;
  onPick: (v: number) => void;
  format: (v: number) => string;
}) {
  return (
    // Separate bordered buttons with real gaps (not a joined strip), so a slightly
    // missed click lands between them rather than on the neighbour.
    <div role="group" aria-label={`${label} presets`} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,calc(var(--ph-control-height)*1.75)),1fr))] gap-1.5">
      {presets.map((p) => {
        const on = Math.abs(p.value - value) < 1e-6;
        return (
          <Button
            variant="ghost"
            size="sm"
            key={p.label}
            type="button"
            data-preset=""
            aria-pressed={on}
            onClick={() => onPick(p.value)}
            aria-label={`${p.label}, ${format(p.value)}`}
            className={cn("min-h-(--ph-control-height) text-sm tabular-nums", on && "bg-selected text-ink font-medium")}
          >
            {format(p.value)}
          </Button>
        );
      })}
    </div>
  );
}

// ---- Radio groups ----

// ---- Hue picking ----

const HUE_STOPS = Array.from({ length: 13 }, (_, i) => `oklch(0.66 0.11 ${i * 30})`).join(", ");
export const HUE_TRACK: React.CSSProperties = { background: `linear-gradient(to right, ${HUE_STOPS})` };

/**
 * Soft colour presets as a radio group of labelled swatches. A custom value
 * that matches no preset leaves none checked.
 */
export function HueSwatches({
  label,
  presets,
  value,
  onPick,
  swatchColour,
  checkColour,
}: {
  label: string;
  presets: readonly { label: string; value: number }[];
  value: number;
  onPick: (v: number) => void;
  swatchColour: (h: number) => string;
  /** The check mark on a chosen swatch; must stand out from swatchColour. */
  checkColour: (h: number) => string;
}) {
  const match = presets.find((p) => p.value === Math.round(value));
  const groupName = useId();
  return (
    <fieldset role="radiogroup" aria-label={label} className="m-0 flex min-w-0 flex-wrap gap-x-1 gap-y-2 border-0 p-0">
      {presets.map((p) => (
        <label key={p.label} data-swatch-item="" data-state={match?.value === p.value ? "checked" : "unchecked"}
          className="group relative flex min-w-(--ph-target-min) cursor-pointer flex-col items-center gap-1 rounded-md px-1.5 py-1 text-xs font-normal text-ink-secondary hover:bg-hover hover:text-ink data-[state=checked]:text-ink">
          <Radio name={groupName} value={String(p.value)} checked={match?.value === p.value} aria-label={p.label} className="sr-only!" onChange={() => onPick(p.value)} />
          <span data-swatch="" className="grid size-(--ph-swatch-size) place-items-center rounded-full ring-offset-2 ring-offset-raised group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-ink"
            style={{ background: swatchColour(p.value), color: checkColour(p.value) }}>
            {match?.value === p.value && <Icon name="check" className="size-(--ph-icon-size-sm)" />}
          </span>
          {p.label}
        </label>
      ))}
    </fieldset>
  );
}

// ---- Switches ----

/**
 * An on/off setting with a status line for its current behavior.
 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  status,
  token,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  status: ReactNode;
  token?: string;
}) {
  const id = useId();
  const descId = useId();
  const statusId = useId();
  return (
    <div data-token={token} className="flex items-center gap-4 px-3.5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-sm font-normal text-ink">
          {label}
        </label>
        <p id={descId} className="max-w-(--ph-measure) text-xs text-ink-secondary">
          {description}
        </p>
        <p id={statusId} className="sr-only">
          {status}
        </p>
      </div>
      <Switch
        look="flat"
        data-switch=""
        data-state={checked ? "checked" : "unchecked"}
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={`${descId} ${statusId}`}
        className="mt-0.5 shrink-0"
      />
    </div>
  );
}

// ---- Text ----

/** A file path that prefers to wrap after a slash rather than mid-name (pair with `wrap-anywhere`). */
export function PathText({ path }: { path: string }) {
  const parts = path.split("/");
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  );
}
