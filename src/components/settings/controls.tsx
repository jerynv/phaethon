/**
 * Building blocks for settings pages: groups, rows, token sliders, swatches,
 * switches. Every control applies its change at once (see src/theme) and shows
 * its default, with a Reset when it differs.
 *
 * Slider, RadioGroup and Switch are Radix primitives (MIT, WorkOS); their
 * keyboard models are Radix's: arrows, Page Up/Down, Home/End on sliders;
 * arrows within a radio group (made to choose as they move, see
 * radioArrowKeys); Space on a switch.
 */
import { RadioGroup, Slider, Switch } from "radix-ui";
import { Fragment, useId, useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

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
    // A plain div, not <header>: inside the dialog a header would be an unnamed banner landmark on every page.
    <div data-section-header="" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      {/* At least ~24 em wide (it grows with the text size): when the action no longer fits beside it, the action wraps below instead of squeezing the description. */}
      <div className="flex min-w-0 flex-[1_1_24em] flex-col gap-1 text-base">
        {/* Focusable from script only: moving to a section from another page lands here. */}
        <h3 id={id} tabIndex={-1} className="self-start rounded-xs text-xl font-semibold text-ink">
          {title}
        </h3>
        <p className="max-w-(--ph-measure) text-base text-ink-secondary">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * A titled group of rows: one bordered list, rows divided by hairlines. A plain
 * block with a heading, not a region landmark: a page of groups would otherwise
 * be a page of landmarks.
 */
export function SettingGroup({
  title,
  titleId,
  description,
  children,
  bare,
}: {
  title: string;
  /** The heading's id, for a control inside that is labelled by it. */
  titleId?: string;
  description?: ReactNode;
  children: ReactNode;
  /** No surrounding card: for content that is itself a set of cards (radio cards). */
  bare?: boolean;
}) {
  const ownId = useId();
  const id = titleId ?? ownId;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5 px-1">
        <h4 id={id} className="text-md font-semibold text-ink">
          {title}
        </h4>
        {description && <p className="text-sm text-ink-secondary">{description}</p>}
      </div>
      {bare ? children : <div className="flex flex-col divide-y divide-line rounded-lg border border-line bg-raised shadow-sm">{children}</div>}
    </div>
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
  /** The token this row sets, so another page can find and focus it. */
  token?: string;
}) {
  const LabelTag = htmlFor ? "label" : "span";
  return (
    <div data-setting-row="" data-token={token} className={cn("flex gap-x-6 gap-y-3 px-4 py-3.5", stacked ? "flex-col" : "flex-wrap items-start")}>
      <div className="flex min-w-(--ph-settings-label-min) flex-1 flex-col gap-0.5">
        <LabelTag id={labelId} htmlFor={htmlFor} className="text-base font-medium text-ink">
          {label}
        </LabelTag>
        {description && (
          <p id={descriptionId} className="max-w-(--ph-measure) text-sm text-ink-secondary">
            {description}
          </p>
        )}
      </div>
      <div className={cn("flex flex-col gap-2", stacked ? "w-full" : "w-(--ph-settings-control-width) max-w-full")}>{children}</div>
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
      className="-my-1 -mr-1.5 min-h-(--ph-target-min) text-accent-ink"
    >
      <Icon name="retry" className="size-(--ph-icon-size-sm)" />
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

/** How far one press on a slider's track moves it: one step, or a twentieth of the range when steps are tiny (a hue). */
function clickStep(min: number, max: number, step: number) {
  const steps = (max - min) / step;
  return steps <= 25 ? step : Math.max(step, Math.round((max - min) / 20 / step) * step);
}

/** `v` clamped to [min, max] and snapped to the slider's steps (no float dust: 1.05, not 1.0500000000000003). */
function snapToStep(v: number, min: number, max: number, step: number) {
  const snapped = min + Math.round((Math.min(max, Math.max(min, v)) - min) / step) * step;
  return Math.round(Math.min(max, snapped) * 1e4) / 1e4;
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
  const thumbRef = useRef<HTMLSpanElement>(null);

  /**
   * A press on the track (not the thumb) moves one click step toward the
   * pointer instead of jumping there: a slip of a shaky hand never takes text
   * size from 100% to 175% at once. Pressing again keeps stepping; dragging
   * the thumb and the keys work as before. Focus goes to the thumb, so the
   * arrow keys carry on from there.
   */
  function stepTowardPointer(e: PointerEvent<HTMLSpanElement>) {
    if (e.button !== 0 || thumbRef.current?.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    const box = e.currentTarget.getBoundingClientRect();
    let frac = box.width > 0 ? (e.clientX - box.left) / box.width : 0.5;
    if (getComputedStyle(e.currentTarget).direction === "rtl") frac = 1 - frac;
    const at = min + Math.min(1, Math.max(0, frac)) * (max - min);
    const by = clickStep(min, max, step);
    const target = Math.abs(at - value) <= by ? at : value + Math.sign(at - value) * by;
    const next = snapToStep(target, min, max, step);
    if (next !== value) onChange(next);
    thumbRef.current?.focus();
  }

  return (
    <Slider.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => onChange(v)}
      onPointerDownCapture={stepTowardPointer}
      className="group/slider relative flex h-(--ph-slider-row) w-full touch-none items-center select-none"
    >
      <Slider.Track
        data-slider-track=""
        data-hue-track={trackStyle ? "" : undefined}
        className={cn(
          "relative h-(--ph-slider-track) grow overflow-hidden rounded-full",
          trackStyle ? "" : "bg-line-strong group-hover/slider:bg-ink-tertiary",
        )}
        style={trackStyle}
      >
        {!trackStyle && <Slider.Range data-slider-range="" className="absolute h-full rounded-full bg-accent-fill" />}
      </Slider.Track>
      <Slider.Thumb
        ref={thumbRef}
        data-slider-thumb=""
        aria-label={labelId ? undefined : label}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        aria-valuetext={valueText}
        className={cn(
          "relative block size-(--ph-slider-thumb) cursor-grab rounded-full border-2 bg-raised shadow transition-[box-shadow,transform] duration-(--ph-duration-fast) active:cursor-grabbing",
          // Hover: a soft halo, so the thumb under the pointer is clear. The hit area reaches the target size.
          "group-hover/slider:shadow-[0_0_0_var(--ph-slider-halo)_var(--ph-accent-soft)]",
          "before:absolute before:-inset-(--ph-slider-hit) before:content-['']",
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
    <SettingRow token={name} label={spec.label} labelId={labelId} description={spec.description} descriptionId={descId}>
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
    // Separate bordered buttons with real gaps (not a joined strip), so a slightly
    // missed click lands between them rather than on the neighbour.
    <div role="group" aria-label={`${label} presets`} className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,calc(var(--ph-control-height)*1.75)),1fr))] gap-1.5">
      {presets.map((p) => {
        const on = Math.abs(p.value - value) < 1e-6;
        return (
          <button
            key={p.label}
            type="button"
            data-preset=""
            aria-pressed={on}
            onClick={() => onPick(p.value)}
            aria-label={`${p.label}, ${format(p.value)}`}
            className={cn(
              "min-h-(--ph-control-height) rounded-md border px-1 text-sm tabular-nums transition-colors duration-(--ph-duration-fast)",
              on
                ? "border-accent-fill bg-accent-soft font-semibold text-accent-soft-ink shadow-[inset_0_0_0_var(--ph-border-width)_var(--ph-accent)]"
                : "border-line-strong bg-raised text-ink-secondary shadow-sm hover:bg-hover hover:text-ink",
            )}
          >
            {format(p.value)}
          </button>
        );
      })}
    </div>
  );
}

// ---- Radio groups ----

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/**
 * The ARIA radio pattern for a Radix RadioGroup: an arrow key moves focus to
 * the next or previous radio AND checks it, in the same key press, wrapping at
 * the ends (Left/Right flip in right-to-left text). Tab still enters and
 * leaves the group in one stop (Radix keeps a roving tabindex on the checked
 * radio). Pass the result as `onKeyDownCapture` on RadioGroup.Root.
 *
 * Why not Radix alone: it moves focus on a timer and checks the radio only if
 * the arrow key is still held when that timer fires, so a quick tap (or a
 * switch device, or a scripted key press) can move focus without choosing.
 * This handler stops the key before Radix sees it, so `onPick` runs once.
 */
export function radioArrowKeys(onPick: (value: string) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    let step = ARROW_STEP[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    const group = e.currentTarget;
    const items = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not([disabled])')];
    const from = items.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && getComputedStyle(group).direction === "rtl") step = -step;
    e.preventDefault();
    e.stopPropagation();
    const next = items[(from + step + items.length) % items.length];
    next.focus();
    if (next.getAttribute("aria-checked") !== "true") onPick(next.value);
  };
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
      onKeyDownCapture={radioArrowKeys((v) => onPick(Number(v)))}
      orientation="horizontal"
      loop
      className="flex flex-wrap gap-x-1 gap-y-2"
    >
      {presets.map((p) => (
        <RadioGroup.Item
          key={p.label}
          value={String(p.value)}
          data-swatch-item=""
          className="group flex min-w-(--ph-target-min) flex-col items-center gap-1 rounded-md px-1.5 py-1 text-xs text-ink-secondary hover:bg-hover hover:text-ink data-[state=checked]:font-semibold data-[state=checked]:text-ink"
        >
          <span
            data-swatch=""
            className="grid size-(--ph-swatch-size) place-items-center rounded-full shadow-sm ring-offset-2 ring-offset-raised group-data-[state=checked]:ring-2 group-data-[state=checked]:ring-ink"
            style={{ background: swatchColour(p.value), color: checkColour(p.value) }}
          >
            <RadioGroup.Indicator>
              <Icon name="check" className="size-(--ph-icon-size-sm)" />
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
        <p id={descId} className="max-w-(--ph-measure) text-sm text-ink-secondary">
          {description}
        </p>
        <p id={statusId} className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <Icon name="info" className="size-(--ph-icon-size-sm) text-ink-tertiary" />
          {status}
        </p>
      </div>
      <Switch.Root
        data-switch=""
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={`${descId} ${statusId}`}
        className={cn(
          "mt-0.5 inline-flex h-(--ph-switch-height) w-(--ph-switch-width) shrink-0 cursor-pointer items-center rounded-full border border-transparent px-0.5 transition-colors duration-(--ph-duration-fast)",
          "bg-ink-tertiary data-[state=checked]:bg-accent-fill",
        )}
      >
        <Switch.Thumb data-switch-thumb="" className="block size-(--ph-switch-thumb) rounded-full bg-raised shadow-sm transition-transform duration-(--ph-duration-fast) data-[state=checked]:translate-x-(--ph-switch-travel)" />
      </Switch.Root>
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
