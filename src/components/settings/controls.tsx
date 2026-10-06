/**
 * Building blocks for settings pages: groups, rows, token sliders, swatches,
 * switches. Every control applies its change at once (see src/theme) and shows
 * its default, with a Reset when it differs.
 *
 * Slider, RadioGroup and Switch are Radix primitives (MIT, WorkOS); their
 * keyboard models are Radix's: arrows, Page Up/Down, Home/End on sliders;
 * arrows within a radio group; Space on a switch.
 */
import { RadioGroup, Slider, Switch } from "radix-ui";
import { useId, type ReactNode } from "react";

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
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h3 id={id} className="text-xl font-semibold text-ink">
          {title}
        </h3>
        <p className="max-w-(--st-measure) text-base text-ink-secondary">{description}</p>
      </div>
      {action}
    </header>
  );
}

/** A titled group of rows: one bordered list, rows divided by hairlines. */
export function SettingGroup({
  title,
  description,
  children,
  bare,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** No surrounding card: for content that is itself a set of cards (radio cards). */
  bare?: boolean;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h4 id={id} className="text-md font-semibold text-ink">
          {title}
        </h4>
        {description && <p className="text-sm text-ink-secondary">{description}</p>}
      </div>
      {bare ? children : <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised shadow-sm">{children}</div>}
    </section>
  );
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
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  description?: ReactNode;
  descriptionId?: string;
  children: ReactNode;
  /** Put the control below the label at full width (swatches, theme cards). */
  stacked?: boolean;
}) {
  const LabelTag = htmlFor ? "label" : "span";
  return (
    <div data-setting-row="" className={cn("flex gap-x-6 gap-y-3 px-4 py-3.5", stacked ? "flex-col" : "flex-wrap items-start")}>
      <div className="flex min-w-(--st-settings-label-min) flex-1 flex-col gap-0.5">
        <LabelTag id={labelId} htmlFor={htmlFor} className="text-base font-medium text-ink">
          {label}
        </LabelTag>
        {description && (
          <p id={descriptionId} className="max-w-(--st-measure) text-sm text-ink-secondary">
            {description}
          </p>
        )}
      </div>
      <div className={cn("flex flex-col gap-2", stacked ? "w-full" : "w-(--st-settings-control-width) max-w-full")}>{children}</div>
    </div>
  );
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
        requestAnimationFrame(() => row?.querySelector<HTMLElement>('[role="slider"]')?.focus());
      }}
      aria-label={`Reset ${what} to ${defaultText}`}
      className="-my-1 -mr-1.5 min-h-(--st-target-min) text-accent-ink"
    >
      <Icon name="retry" className="size-(--st-icon-size-sm)" />
      Reset
    </Button>
  ) : (
    <span className="text-sm text-ink-tertiary">Default</span>
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
  return (
    <Slider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => onChange(v)}
      className="relative flex h-(--st-target-min) w-full touch-none items-center select-none"
    >
      <Slider.Track
        className={cn(
          "relative h-(--st-slider-track) grow overflow-hidden rounded-full",
          trackStyle ? "" : "bg-line-strong",
        )}
        style={trackStyle}
      >
        {!trackStyle && <Slider.Range className="absolute h-full rounded-full bg-accent-fill" />}
      </Slider.Track>
      <Slider.Thumb
        aria-label={labelId ? undefined : label}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-valuetext={valueText}
        className={cn(
          "relative block size-(--st-slider-thumb) cursor-grab rounded-full border-2 bg-raised shadow transition-transform duration-(--st-duration-fast) active:cursor-grabbing",
          "before:absolute before:-inset-(--st-focus-offset) before:content-['']",
          trackStyle ? "border-ink" : "border-accent-fill",
        )}
      />
    </Slider.Root>
  );
}

/** A full row for one number or length token: label, description, slider, value, Reset. */
export function TokenRow({ name, quickPicks, children }: { name: string; quickPicks?: boolean; children?: ReactNode }) {
  const { spec, value, set, changed } = useTokenNumber(name);
  const labelId = useId();
  const descId = useId();
  return (
    <SettingRow label={spec.label} labelId={labelId} description={spec.description} descriptionId={descId}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink tabular-nums" aria-hidden="true">
          {spec.format(value)}
        </span>
        <DefaultOrReset changed={changed} onReset={() => set(spec.default)} what={spec.label.toLowerCase()} defaultText={spec.format(spec.default)} />
      </div>
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
    <div role="group" aria-label={`${label} presets`} className="flex flex-wrap gap-1">
      {presets.map((p) => {
        const on = Math.abs(p.value - value) < 1e-6;
        return (
          <button
            key={p.label}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(p.value)}
            aria-label={`${p.label}, ${format(p.value)}`}
            className={cn(
              "min-h-(--st-target-min) rounded-md border px-2 text-xs transition-colors duration-(--st-duration-fast)",
              on
                ? "border-accent-fill bg-accent-soft font-semibold text-accent-soft-ink"
                : "border-line-strong text-ink-secondary hover:bg-hover hover:text-ink",
            )}
          >
            {format(p.value)}
          </button>
        );
      })}
    </div>
  );
}

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
  return (
    <RadioGroup.Root
      aria-label={label}
      value={match ? String(match.value) : ""}
      onValueChange={(v) => onPick(Number(v))}
      orientation="horizontal"
      loop
      className="flex flex-wrap gap-x-1 gap-y-2"
    >
      {presets.map((p) => (
        <RadioGroup.Item
          key={p.label}
          value={String(p.value)}
          className="group flex min-w-(--st-target-min) flex-col items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-secondary hover:bg-hover hover:text-ink data-[state=checked]:font-semibold data-[state=checked]:text-ink"
        >
          <span
            className="grid size-(--st-swatch-size) place-items-center rounded-full shadow-sm ring-offset-2 ring-offset-raised group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-ink"
            style={{ background: swatchColour(p.value), color: checkColour(p.value) }}
          >
            <RadioGroup.Indicator>
              <Icon name="check" className="size-(--st-icon-size-sm)" />
            </RadioGroup.Indicator>
          </span>
          {p.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

// ---- Switches ----

/**
 * An on/off setting whose "off" means "follow the system". The status line
 * says what the system currently does, so the result is never a guess.
 */
export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  status,
}: {
  label: string;
  description: ReactNode;
  checked: boolean;
  onChange: (on: boolean) => void;
  status: ReactNode;
}) {
  const id = useId();
  const descId = useId();
  const statusId = useId();
  return (
    <div className="flex items-start gap-6 px-4 py-3.5">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <label htmlFor={id} className="cursor-pointer text-base font-medium text-ink">
          {label}
        </label>
        <p id={descId} className="max-w-(--st-measure) text-sm text-ink-secondary">
          {description}
        </p>
        <p id={statusId} className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <Icon name="info" className="size-(--st-icon-size-sm) text-ink-tertiary" />
          {status}
        </p>
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={`${descId} ${statusId}`}
        className={cn(
          "mt-0.5 inline-flex h-(--st-switch-height) w-(--st-switch-width) shrink-0 cursor-pointer items-center rounded-full border border-transparent px-0.5 transition-colors duration-(--st-duration-fast)",
          "bg-ink-tertiary data-[state=checked]:bg-accent-fill",
        )}
      >
        <Switch.Thumb className="block size-(--st-switch-thumb) rounded-full bg-raised shadow-sm transition-transform duration-(--st-duration-fast) data-[state=checked]:translate-x-(--st-switch-travel)" />
      </Switch.Root>
    </div>
  );
}
