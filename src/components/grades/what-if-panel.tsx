import { useEffect, useId, useRef, useState } from "react";

import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { fieldClasses, Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import type { CourseGrades } from "@/lib/grades-api";
import { cn } from "@/lib/utils";

import { calculate, LETTERS, letterFor, needed, pct, type CalcInput, type Needed, type SolveFor } from "./what-if";

/** What the person typed, per course, kept while the app runs (switching views keeps it). */
type Tried = { open: boolean; scores: Record<string, string>; finalWeight: string; finalScore: string; target: string; on: string };
const kept = new Map<string, Tried>();

const FINAL = "__final__";
const parse = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * What if: scores to try for what isn't graded yet (and a final exam the
 * course doesn't list), the grade they would give with the course's own
 * weights, and the score needed on one of them to reach a grade.
 */
export function WhatIf({ space, course, input, sitePercent }: { space: string; course: CourseGrades; input: CalcInput; sitePercent: number | null }) {
  const key = `${space}:${course.connection}:${course.courseId}`;
  const open = input.items.filter((i) => !i.graded && !i.excused);
  const finalItem = [...open].reverse().find((i) => /final/i.test(i.title));
  const [t, setT] = useState<Tried>(
    () => kept.get(key) ?? { open: false, scores: {}, finalWeight: "", finalScore: "", target: "B+", on: finalItem?.key ?? open[0]?.key ?? FINAL },
  );
  useEffect(() => void kept.set(key, t), [key, t]);
  const id = useId();
  const update = (patch: Partial<Tried>) => setT((x) => ({ ...x, ...patch }));

  // Typed scores, as percent of each item; points when the item has them.
  const tryScores: Record<string, number> = {};
  const bad: string[] = [];
  for (const i of open) {
    const v = parse(t.scores[i.key] ?? "");
    if (v == null) continue;
    const max = i.possible ? i.possible * 2 : 200;
    if (Number.isNaN(v) || v < 0 || v > max) bad.push(i.key);
    else tryScores[i.key] = i.possible ? (v / i.possible) * 100 : v;
  }
  const fw = parse(t.finalWeight);
  const fs = parse(t.finalScore);
  const finalBad = { weight: fw != null && (Number.isNaN(fw) || fw <= 0 || fw >= 100), score: fs != null && (Number.isNaN(fs) || fs < 0 || fs > 200) };
  const final = fw != null && !finalBad.weight ? { weight: fw, percent: fs != null && !finalBad.score ? fs : null } : null;

  const now = calculate(input).percent;
  const projected = calculate({ ...input, tryScores, final }).percent;
  const changed = Object.keys(tryScores).length > 0 || final?.percent != null;

  const targetPct = LETTERS.find(([l]) => l === t.target)?.[1] ?? Number(t.target);
  const onFinal = t.on === FINAL;
  const solve: SolveFor = onFinal ? { final: true } : { item: t.on };
  const others = { ...tryScores };
  if (!onFinal) delete others[t.on];
  const need: Needed =
    (onFinal && !final) || (!onFinal && !open.some((i) => i.key === t.on)) ? { kind: "unknown" } : needed({ ...input, tryScores: others, final }, solve, targetPct);
  const onName = onFinal ? "the final exam" : (open.find((i) => i.key === t.on)?.title ?? "it");
  const needText = (() => {
    const goal = `${t.target} (${targetPct}%)`;
    switch (need.kind) {
      case "needs": {
        const item = open.find((i) => i.key === t.on);
        const points = item?.possible ? ` (${Math.round((need.percent / 100) * item.possible * 10) / 10} out of ${item.possible})` : "";
        return `You need at least ${pct(need.percent)}${points} on ${onName} for ${goal}.`;
      }
      case "already":
        return `You get ${goal} whatever you score on ${onName}, with the other scores as they are.`;
      case "out-of-reach":
        return `${goal} is out of reach through ${onName} alone: even 100% there gives ${pct(need.best)}.`;
      default:
        return onFinal ? "Set how much the final exam is worth first." : "Nothing is graded yet, so there’s nothing to work from.";
    }
  })();

  // The new grade said once typing pauses, not at every key.
  const projectedText = projected == null ? "" : `With these scores: ${pct(projected)} (${letterFor(projected)}).`;
  const lastSaid = useRef("");
  useEffect(() => {
    if (!t.open || !changed || !projectedText || projectedText === lastSaid.current) return;
    const timer = setTimeout(() => {
      lastSaid.current = projectedText;
      announce(projectedText);
    }, 900);
    return () => clearTimeout(timer);
  }, [projectedText, changed, t.open]);

  const differs = sitePercent != null && now != null && Math.abs(sitePercent - now) > 0.5;

  return (
    <div className="flex flex-col rounded-lg border border-line" data-what-if={course.courseId}>
      <h4>
        <button
          type="button"
          aria-expanded={t.open}
          aria-controls={`${id}-panel`}
          onClick={() => update({ open: !t.open })}
          className="flex min-h-(--ph-target-min) w-full cursor-default items-center gap-2 rounded-lg px-3 py-2 text-start text-base font-semibold text-ink hover:bg-hover"
          data-what-if-toggle=""
        >
          <Icon name="chevron-right" className={cn("size-(--ph-icon-size-sm) transition-transform duration-(--ph-duration-fast)", t.open && "rotate-90")} />
          What if…
          <span className="text-sm font-normal text-ink-secondary">try scores for what isn’t graded yet</span>
        </button>
      </h4>
      {t.open && (
        <div id={`${id}-panel`} className="flex flex-col gap-4 border-t border-line px-4 pt-3 pb-4">
          <p className="text-sm text-ink-secondary">
            {input.groups.some((g) => (g.weight ?? 0) > 0) ? "Uses this course’s weights." : "Counts every point the same (this course has no weights)."} A rule Phaethon can’t see,
            like dropping the lowest quiz, may make the real grade differ.
            {differs && ` From these scores Phaethon gets ${pct(now!)}; your course site says ${pct(sitePercent!)}.`}
          </p>
          {open.length > 0 && (
            <fieldset className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1.5 gap-y-2">
              <legend className="mb-1 text-sm font-semibold text-ink-secondary">Scores to try</legend>
              {open.map((i) => {
                const inputId = `${id}-s${i.key}`;
                const invalid = bad.includes(i.key);
                return (
                  <div key={i.key} className="contents">
                    <label htmlFor={inputId} className="me-1.5 text-base text-ink wrap-break-word">
                      {i.title}
                      {i.group && <span className="text-sm text-ink-secondary"> · {i.group}</span>}
                    </label>
                    <Input
                        id={inputId}
                        inputMode="decimal"
                        autoComplete="off"
                        value={t.scores[i.key] ?? ""}
                        onChange={(e) => update({ scores: { ...t.scores, [i.key]: e.target.value } })}
                        aria-invalid={invalid || undefined}
                        aria-describedby={`${inputId}-u${invalid ? ` ${inputId}-e` : ""}`}
                        data-what-if-score={i.title}
                        className="w-[calc(5.5rem*var(--ph-ui-scale))] text-end tabular-nums"
                      />
                    <span id={`${inputId}-u`} className="text-sm text-ink-secondary">
                      {i.possible ? `out of ${i.possible}` : "%"}
                    </span>
                    {invalid && (
                      <p id={`${inputId}-e`} className="col-span-3 flex items-center gap-1 text-sm text-danger-ink">
                        <Icon name="error" className="size-(--ph-icon-size-sm)" />
                        Type a number from 0{i.possible ? ` to ${i.possible * 2}` : " to 200"}.
                      </p>
                    )}
                  </div>
                );
              })}
            </fieldset>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-semibold text-ink-secondary">A final exam not listed above</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <NumberField id={`${id}-fw`} label="Worth" unit="% of the course" value={t.finalWeight} invalid={finalBad.weight} error="Type a share between 0 and 100." onChange={(v) => update({ finalWeight: v })} />
              <NumberField id={`${id}-fs`} label="Score" unit="%" value={t.finalScore} invalid={finalBad.score} error="Type a number from 0 to 200." onChange={(v) => update({ finalScore: v })} />
            </div>
          </fieldset>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg bg-accent-soft px-3 py-2.5 text-accent-soft-ink forced-colors:border forced-colors:border-[CanvasText]" data-what-if-result="">
            <span className="text-sm font-semibold">Projected course grade</span>
            <output className="text-xl font-semibold tabular-nums" aria-live="off" data-what-if-projected="">
              {projected == null ? "–" : `${pct(projected)} ${letterFor(projected)}`}
            </output>
            {now != null && changed && <span className="text-sm">now {pct(now)}</span>}
          </div>
          <div className="flex flex-col gap-2" data-what-if-need="">
            <p className="text-sm font-semibold text-ink-secondary" id={`${id}-need`}>
              What do I need?
            </p>
            <div className="flex flex-wrap items-center gap-2 text-base text-ink" role="group" aria-labelledby={`${id}-need`}>
              <label htmlFor={`${id}-target`}>For</label>
              <select id={`${id}-target`} value={t.target} onChange={(e) => update({ target: e.target.value })} className={cn(fieldClasses, "min-h-(--ph-control-height) w-auto px-2")} data-what-if-target="">
                {LETTERS.filter(([l]) => l !== "F").map(([l, min]) => (
                  <option key={l} value={l}>
                    {l} ({min}%)
                  </option>
                ))}
              </select>
              <label htmlFor={`${id}-on`}>on</label>
              <select id={`${id}-on`} value={t.on} onChange={(e) => update({ on: e.target.value })} className={cn(fieldClasses, "min-h-(--ph-control-height) w-auto max-w-full px-2")} data-what-if-on="">
                {open.map((i) => (
                  <option key={i.key} value={i.key}>
                    {i.title}
                  </option>
                ))}
                <option value={FINAL}>A final exam not listed (set above)</option>
              </select>
            </div>
            <output className="text-base font-medium text-ink" data-what-if-answer="">
              {needText}
            </output>
          </div>
          {(changed || t.finalWeight) && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  update({ scores: {}, finalWeight: "", finalScore: "" });
                  announce("Tried scores cleared.");
                }}
              >
                <Icon name="close" />
                Clear tried scores
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NumberField({ id, label, unit, value, invalid, error, onChange }: { id: string; label: string; unit: string; value: string; invalid: boolean; error: string; onChange: (v: string) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-base text-ink">
        <label htmlFor={id}>{label}</label>
        <Input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-u${invalid ? ` ${id}-e` : ""}`}
          className="w-[calc(5rem*var(--ph-ui-scale))] text-end tabular-nums"
        />
        <span id={`${id}-u`} className="text-sm text-ink-secondary">
          {unit}
        </span>
      </span>
      {invalid && (
        <p id={`${id}-e`} className="flex items-center gap-1 text-sm text-danger-ink">
          <Icon name="error" className="size-(--ph-icon-size-sm)" />
          {error}
        </p>
      )}
    </div>
  );
}
