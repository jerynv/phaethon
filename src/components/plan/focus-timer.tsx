import { Checkbox, NativeSelect } from "vic-ui";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { WorkspaceSection } from "@/components/ui/workspace-page";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

import { clock, minutesOf, pause, phaseName, remaining, reset, setSettings, skip, spokenClock, start, useFocusTimer, type TimerSettings } from "./focus-timer-store";

const CHOICES: Record<Exclude<keyof TimerSettings, "sound">, number[]> = {
  focus: [15, 20, 25, 30, 40, 45, 50, 60, 90],
  short: [3, 5, 10, 15],
  long: [10, 15, 20, 30],
};

/**
 * The focus timer: the time left in the phase (role "timer", not read
 * out every second), start or pause, skip, reset, and its lengths and sound.
 * Phase changes are announced by the store, wherever you are in the app.
 */
export function FocusTimer({ headingLevel = 3 }: { headingLevel?: 2 | 3 }) {
  const t = useFocusTimer();
  const id = useId();
  const left = remaining(t);
  const total = minutesOf(t.settings, t.phase) * 60_000;
  const fresh = !t.running && left === total;
  const onBreak = t.phase !== "focus";

  return (
    <WorkspaceSection
      title="Focus timer"
      titleId={`${id}-h`}
      headingAs={headingLevel === 2 ? "h2" : "h3"}
      data-focus-timer=""
      actions={<p className="text-sm text-ink-secondary" data-focus-rounds="">
          {t.rounds === 0 ? "No focus sessions done yet" : `${t.rounds} focus session${t.rounds === 1 ? "" : "s"} done`}
      </p>}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex flex-col">
          <p className={cn("text-sm font-semibold", onBreak ? "text-success-ink" : "text-accent-ink")} data-focus-phase={t.phase}>
            {phaseName(t.phase)}
            {t.label && t.phase === "focus" ? `: ${t.label}` : ""}
          </p>
          <p role="timer" aria-live="off" aria-atomic="true" className="text-2xl font-semibold text-ink tabular-nums" data-focus-clock="">
            <span aria-hidden="true">{clock(left)}</span>
            <span className="sr-only">
              {spokenClock(left)} {t.running ? "left" : "left, paused"}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {t.running ? (
            <Button type="button" variant="outline" onClick={pause} data-focus-toggle="pause">
              <Icon name="pause" />
              Pause
            </Button>
          ) : (
            <Button type="button" variant="outline" onClick={() => start()} data-focus-toggle="start">
              <Icon name="play" />
              {fresh ? (onBreak ? "Start break" : "Start focus") : "Resume"}
            </Button>
          )}
          <Button type="button" variant="outline" onClick={skip} data-focus-skip="">
            <Icon name="chevron-right" />
            {onBreak ? "Skip break" : "End focus now"}
          </Button>
          <Button type="button" variant="ghost" onClick={reset} disabled={fresh && t.phase === "focus" && t.rounds === 0} data-focus-reset="">
            <Icon name="retry" />
            Reset
          </Button>
        </div>
      </div>
      {/* Decorative: the time is in words above. No animation when motion is reduced. */}
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]">
        <div
          className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear forced-colors:bg-[CanvasText]", onBreak ? "bg-success-ink" : "bg-accent-fill")}
          style={{ width: `${total ? Math.min(100, ((total - left) / total) * 100) : 0}%` }}
        />
      </div>
      <Details summary="Timer settings">
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-base text-ink">
          {(["focus", "short", "long"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              {k === "focus" ? "Focus" : k === "short" ? "Short break" : "Long break"}
              <NativeSelect
                value={t.settings[k]}
                onChange={(e) => setSettings({ [k]: Number(e.target.value) })}
                className="w-auto"
                data-focus-setting={k}
              >
                {[...new Set([...CHOICES[k], t.settings[k]])]
                  .sort((a, b) => a - b)
                  .map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
              </NativeSelect>
            </label>
          ))}
        </div>
        <label className="flex min-h-(--ph-target-min) items-center gap-2 text-base text-ink">
          <Checkbox
            checked={t.settings.sound}
            onChange={(e) => setSettings({ sound: e.target.checked })}
            data-focus-sound=""
          />
          Play a sound when a focus session or break ends
        </label>
        <p className="text-sm text-ink-secondary">Every fourth break is a long one. The timer keeps going while you use the rest of Phaethon, and says when a phase ends.</p>
      </Details>
    </WorkspaceSection>
  );
}
