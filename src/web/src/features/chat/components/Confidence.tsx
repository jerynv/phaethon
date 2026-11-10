import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

const STOPS = [
  { value: 0, label: "Guessing" },
  { value: 25, label: "Unsure" },
  { value: 50, label: "Somewhat sure" },
  { value: 75, label: "Fairly sure" },
  { value: 100, label: "Certain" },
] as const;

/** The nearest labelled stop's words for a confidence 0–100. */
export function confidenceWords(v: number): string {
  if (v < 13) return "Guessing";
  if (v < 38) return "Unsure";
  if (v < 63) return "Somewhat sure";
  if (v < 88) return "Fairly sure";
  return "Certain";
}

/**
 * How sure the student is, 0–100, on a native slider (arrow keys, Page Up /
 * Down, Home / End, and screen readers' own slider controls) with labelled
 * stops a pointer can click. It starts unset, so an untouched slider is
 * never sent as an answer.
 */
export function Confidence({
  id,
  value,
  onChange,
  labelId,
  invalid,
  describedBy,
}: {
  id: string;
  value: number | null;
  onChange: (v: number) => void;
  labelId: string;
  invalid?: boolean;
  describedBy?: string;
}) {
  const shown = value ?? 50;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span id={labelId} className="text-sm font-medium">
          How sure are you?
        </span>
        <span className={cn("text-sm tabular-nums", value === null ? "text-muted-foreground" : "font-medium")} aria-hidden>
          {value === null ? "Not set" : `${value}% · ${confidenceWords(value)}`}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        value={shown}
        aria-labelledby={labelId}
        aria-valuetext={value === null ? "Not set" : `${value} percent, ${confidenceWords(value)}`}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-unset={value === null ? "" : undefined}
        className="ph-range"
        style={{ "--fill": value === null ? "0%" : `${value}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        onPointerDown={(e) => {
          // A click on the thumb where it rests (50) still counts as choosing.
          if (value === null) onChange(Number(e.currentTarget.value));
        }}
      />
      <div aria-hidden className="relative h-5 text-xs text-muted-foreground">
        {STOPS.map((s) => (
          <button
            key={s.value}
            type="button"
            tabIndex={-1}
            onClick={() => onChange(s.value)}
            className={cn(
              "absolute top-0 cursor-pointer whitespace-nowrap rounded border-0 bg-transparent px-0.5 hover:text-foreground forced-colors:text-[CanvasText]",
              s.value === 0 ? "start-0" : s.value === 100 ? "end-0" : "-translate-x-1/2",
              value !== null && confidenceWords(value) === s.label && "font-medium text-foreground",
              (s.value === 25 || s.value === 75) && "max-sm:hidden",
            )}
            style={s.value > 0 && s.value < 100 ? { insetInlineStart: `${s.value}%` } : undefined}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
