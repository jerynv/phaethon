/**
 * The focus timer in a popover: the phase, the time left (a timer that isn't
 * read aloud every second; its full words are there for anyone who asks),
 * start or pause, skip, reset, and its lengths. Phase changes are announced.
 * No animation beyond the bar's width, and none when motion is reduced.
 */
import { PauseIcon, PlayIcon, RotateCcwIcon, SkipForwardIcon, TimerIcon } from "lucide-react";
import { useEffect, useId } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";

import { announce } from "../courses/shared/announce";
import { Meter } from "../courses/shared/kit";
import { clock, minutesOf, phaseName, remaining, setTimerVoice, spokenClock, useFocusTimer } from "./lib/focus-timer";

const CHOICES = { focus: [15, 20, 25, 30, 40, 45, 50, 60, 90], short: [3, 5, 10, 15], long: [10, 15, 20, 30] } as const;

export function FocusTimerButton() {
  const t = useFocusTimer();
  useEffect(() => setTimerVoice((s) => announce(s)), []);
  const left = remaining(t);
  return (
    <Popover>
      <PopoverTrigger render={<Button variant={t.running ? "secondary" : "outline"} data-focus-timer-trigger="" />}>
        <TimerIcon aria-hidden />
        {t.running ? (
          <span className="tabular-nums">
            {phaseName(t.phase)} · {clock(left)}
          </span>
        ) : (
          "Focus timer"
        )}
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <FocusTimerPanel />
      </PopoverPopup>
    </Popover>
  );
}

export function FocusTimerPanel() {
  const id = useId();
  const t = useFocusTimer();
  const left = remaining(t);
  const full = minutesOf(t.settings, t.phase) * 60_000;
  const fresh = !t.running && t.left === full && t.phase === "focus" && t.rounds === 0;
  return (
    <div className="flex flex-col gap-4" data-focus-timer="">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-muted-foreground">
          {phaseName(t.phase)}
          {t.phase === "focus" && t.label ? `: ${t.label}` : ""}
          {t.rounds > 0 && ` · ${t.rounds} done`}
        </h2>
        <div role="timer" aria-live="off" aria-atomic="true" className="text-5xl font-semibold tracking-tight text-foreground tabular-nums">
          <span aria-hidden>{clock(left)}</span>
          <span className="sr-only">
            {spokenClock(left)} left{t.running ? "" : ", paused"}
          </span>
        </div>
        <Meter value={full ? 1 - left / full : 0} className="mt-2" tone={t.phase === "focus" ? "primary" : "success"} />
      </div>
      <div className="flex flex-wrap gap-2">
        {t.running ? (
          <Button onClick={t.pause}>
            <PauseIcon aria-hidden />
            Pause
          </Button>
        ) : (
          <Button onClick={() => t.start()}>
            <PlayIcon aria-hidden />
            {t.left < full ? "Resume" : "Start"}
          </Button>
        )}
        <Button variant="outline" onClick={t.skip}>
          <SkipForwardIcon aria-hidden />
          {t.phase === "focus" ? "End focus now" : "Skip break"}
        </Button>
        <Button variant="ghost" size="icon" aria-label="Reset the timer" disabled={fresh} onClick={t.reset}>
          <RotateCcwIcon aria-hidden />
        </Button>
      </div>
      <fieldset className="grid grid-cols-3 gap-2 border-t pt-4">
        <legend className="sr-only">Lengths</legend>
        {(["focus", "short", "long"] as const).map((k) => {
          const items = [...new Set([...CHOICES[k], t.settings[k]])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: `${m} min` }));
          return (
            <div key={k} className="flex flex-col gap-1">
              <Label htmlFor={`${id}-${k}`} className="text-sm font-normal text-muted-foreground">
                {k === "focus" ? "Focus" : k === "short" ? "Break" : "Long break"}
              </Label>
              <Select items={items} value={String(t.settings[k])} onValueChange={(v) => v && t.setSettings({ [k]: Number(v) })}>
                <SelectTrigger id={`${id}-${k}`} size="sm" className="min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {items.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          );
        })}
        <Label className="col-span-3 mt-1 flex items-center gap-2 text-sm font-normal">
          <Checkbox checked={t.settings.sound} onCheckedChange={(on) => t.setSettings({ sound: on })} />
          Play a sound when a phase ends
        </Label>
      </fieldset>
    </div>
  );
}
