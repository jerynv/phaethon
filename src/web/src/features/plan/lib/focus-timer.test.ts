import { expect, test } from "vitest";

import { clampSettings, clock, DEFAULT_SETTINGS, nextPhase, spokenClock, type TimerState } from "./focus-timer";

const base: TimerState = { phase: "focus", running: true, endsAt: 0, left: 0, rounds: 0, label: "Review for Test 1", settings: DEFAULT_SETTINGS, tick: 0 };

test("clock and spoken clock", () => {
  expect(clock(25 * 60_000)).toBe("25:00");
  expect(clock(64_001)).toBe("1:05");
  expect(spokenClock(64_000)).toBe("1 minute 4 seconds");
  expect(spokenClock(120_000)).toBe("2 minutes");
  expect(spokenClock(0)).toBe("0 seconds");
});

test("settings are rounded and kept in range", () => {
  expect(clampSettings({ focus: 2, short: 99, long: 14.6, sound: true })).toEqual({ focus: 5, short: 30, long: 15, sound: true });
  expect(clampSettings({ focus: Number.NaN })).toEqual(DEFAULT_SETTINGS);
});

test("a focus starts its break by itself; every fourth is long; a break ends paused", () => {
  const first = nextPhase(base, 1000);
  expect(first.state).toMatchObject({ phase: "short", rounds: 1, running: true, endsAt: 1000 + 5 * 60_000 });
  expect(first.said).toBe("Focus session done: Review for Test 1. Take a 5-minute break.");
  expect(nextPhase({ ...base, rounds: 3 }).state.phase).toBe("long");
  const after = nextPhase({ ...first.state }, 0);
  expect(after.state).toMatchObject({ phase: "focus", running: false, endsAt: null, left: 25 * 60_000 });
});
