/**
 * What if: scores to try for what isn't graded yet (and a final exam the
 * course doesn't list), the grade they would give with the course's own
 * weights, and the score needed on one of them to reach a grade. The typed
 * values are kept per course while the app runs.
 */
import { ChevronDownIcon, EraserIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { announce } from "../courses/shared/announce";
import type { CalcInput } from "./lib/what-if";
import { defaultOn, FINAL, LETTERS, letterFor, needText, openItems, pct, whatIf, type Tried } from "./lib/what-if";

const kept = new Map<string, Tried & { open: boolean }>();

export function WhatIfPanel({ storeKey, input, sitePercent }: { storeKey: string; input: CalcInput; sitePercent: number | null }) {
  const id = useId();
  const open = openItems(input);
  const [t, setT] = useState<Tried & { open: boolean }>(() => kept.get(storeKey) ?? { open: false, scores: {}, finalWeight: "", finalScore: "", target: "B+", on: defaultOn(input) });
  useEffect(() => void kept.set(storeKey, t), [storeKey, t]);
  const update = (patch: Partial<Tried & { open: boolean }>) => setT((x) => ({ ...x, ...patch }));
  const r = whatIf(input, t);
  const weighted = input.groups.some((g) => (g.weight ?? 0) > 0);
  const differs = sitePercent != null && r.now != null && Math.abs(sitePercent - r.now) > 0.5;

  // The new grade, said once typing pauses.
  const projectedText = r.projected == null ? "" : `With these scores: ${pct(r.projected)} (${letterFor(r.projected)}).`;
  const lastSaid = useRef("");
  useEffect(() => {
    if (!t.open || !r.changed || !projectedText || projectedText === lastSaid.current) return;
    const timer = setTimeout(() => {
      lastSaid.current = projectedText;
      announce(projectedText);
    }, 900);
    return () => clearTimeout(timer);
  }, [projectedText, r.changed, t.open]);

  const onItems = [...open.map((i) => ({ value: i.key, label: i.title })), { value: FINAL, label: "A final exam not listed" }];
  const letters = LETTERS.filter(([l]) => l !== "F").map(([l, min]) => ({ value: l, label: `${l} (${min}%)` }));

  return (
    <section aria-labelledby={`${id}-h`} className="overflow-hidden rounded-2xl border bg-card" data-what-if="">
      <h2 id={`${id}-h`}>
        <button
          type="button"
          aria-expanded={t.open}
          aria-controls={`${id}-panel`}
          onClick={() => update({ open: !t.open })}
          className="flex w-full items-center gap-3 px-5 py-4 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-base font-semibold text-foreground">What if…</span>
            <span className="text-sm text-muted-foreground">Try scores for what isn’t graded yet, and see what you need for a grade.</span>
          </span>
          <ChevronDownIcon aria-hidden className={cn("size-4.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", t.open && "rotate-180")} />
        </button>
      </h2>
      {t.open && (
        <div id={`${id}-panel`} className="grid gap-6 border-t px-5 py-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex flex-col gap-5">
            {open.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-semibold text-foreground">Scores to try</legend>
                {open.map((i) => {
                  const inputId = `${id}-s${i.key}`;
                  const invalid = r.bad.includes(i.key);
                  return (
                    <div key={i.key} className="grid grid-cols-[minmax(0,1fr)_6.5rem_3.5rem] items-center gap-2">
                      <label htmlFor={inputId} className="min-w-0 text-sm text-foreground">
                        {i.title}
                        {i.group && <span className="text-muted-foreground"> · {i.group}</span>}
                      </label>
                      <Input
                        id={inputId}
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={String(i.possible ? Math.round(i.possible * 0.85) : 85)}
                        value={t.scores[i.key] ?? ""}
                        aria-invalid={invalid || undefined}
                        aria-describedby={invalid ? `${inputId}-err` : undefined}
                        onChange={(e) => update({ scores: { ...t.scores, [i.key]: e.target.value } })}
                        className="text-end tabular-nums"
                      />
                      <span className="text-sm text-muted-foreground tabular-nums">{i.possible ? `/ ${i.possible}` : "%"}</span>
                      {invalid && (
                        <p id={`${inputId}-err`} className="col-span-3 text-sm text-destructive-foreground">
                          {i.possible ? `Use a number from 0 to ${i.possible * 2}.` : "Use a percent from 0 to 200."}
                        </p>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-semibold text-foreground">A final exam not listed</legend>
              <div className="grid grid-cols-[minmax(0,1fr)_6.5rem_3.5rem] items-center gap-2">
                <label htmlFor={`${id}-fw`} className="text-sm text-foreground">
                  Worth, share of the course
                </label>
                <Input
                  id={`${id}-fw`}
                  inputMode="decimal"
                  placeholder="25"
                  value={t.finalWeight}
                  aria-invalid={r.finalBad.weight || undefined}
                  onChange={(e) => update({ finalWeight: e.target.value })}
                  className="text-end tabular-nums"
                />
                <span className="text-sm text-muted-foreground">%</span>
                <label htmlFor={`${id}-fs`} className="text-sm text-foreground">
                  Your score on it
                </label>
                <Input
                  id={`${id}-fs`}
                  inputMode="decimal"
                  placeholder="85"
                  value={t.finalScore}
                  aria-invalid={r.finalBad.score || undefined}
                  onChange={(e) => update({ finalScore: e.target.value })}
                  className="text-end tabular-nums"
                />
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              {r.finalBad.weight && <p className="text-sm text-destructive-foreground">Its share is more than 0 and less than 100.</p>}
              {r.finalBad.score && <p className="text-sm text-destructive-foreground">Use a percent from 0 to 200.</p>}
            </fieldset>
            <p className="text-sm text-muted-foreground">
              {weighted ? "Uses this course’s weights." : "Counts every point the same (this course has no weights)."} A rule Phaethon can’t see, like dropping the lowest quiz, can make
              the real grade differ.
              {differs && ` From these scores Phaethon gets ${pct(r.now!)}; your course site says ${pct(sitePercent!)}.`}
            </p>
          </div>

          <div className="flex flex-col gap-5 rounded-xl bg-muted/60 p-4 lg:self-start">
            <div className="flex flex-col gap-1">
              <span className="text-sm text-muted-foreground">Projected grade</span>
              <output aria-live="off" htmlFor={`${id}-fw ${id}-fs`} className="text-3xl font-semibold tracking-tight text-foreground tabular-nums" data-what-if-projected="">
                {r.projected == null ? "—" : `${pct(r.projected)} ${letterFor(r.projected)}`}
              </output>
              <span className="text-sm text-muted-foreground">{r.now == null ? "Nothing graded yet" : `Now ${pct(r.now)}`}</span>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-semibold text-foreground" id={`${id}-need`}>
                What do I need?
              </span>
              <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-need`}>
                <Select items={letters} value={t.target} onValueChange={(v) => v && update({ target: String(v) })}>
                  <SelectTrigger aria-label="Grade to reach" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {letters.map((l) => (
                      <SelectItem key={l.value} value={l.value}>
                        For {l.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                <Select items={onItems} value={t.on} onValueChange={(v) => v && update({ on: String(v) })}>
                  <SelectTrigger aria-label="Solve for" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {onItems.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        on {o.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <p className="text-sm text-foreground" aria-live="polite" data-what-if-need={r.need.kind}>
                {needText(input, t, r)}
              </p>
            </div>
            {(Object.values(t.scores).some((s) => s.trim()) || t.finalWeight || t.finalScore) && (
              <Button size="sm" variant="ghost" className="self-start" onClick={() => update({ scores: {}, finalWeight: "", finalScore: "" })}>
                <EraserIcon aria-hidden />
                Clear tried scores
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
