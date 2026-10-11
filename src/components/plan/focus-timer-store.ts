import { useSyncExternalStore } from "react";

import { announce } from "@/components/shell/announcer";

/**
 * The focus timer (Pomodoro): focus, then a short break, every fourth break
 * a long one. One for the whole app, kept here rather than in a component, so
 * it keeps running while you switch views or spaces. Its settings are this
 * device's (local storage). Phase changes are said politely; a sound only if
 * the person turned it on. Time is measured from the clock, so a throttled
 * tick never makes it drift.
 */
export type Phase = "focus" | "short" | "long";
export type TimerSettings = { focus: number; short: number; long: number; sound: boolean };
export type TimerState = {
  phase: Phase;
  running: boolean;
  /** While running: when this phase ends (ms since the epoch). */
  endsAt: number | null;
  /** While paused: what's left of it (ms). */
  left: number;
  /** Focus sessions finished since the timer was reset. */
  rounds: number;
  /** What the focus session is for (a session from the plan), if chosen. */
  label: string;
  settings: TimerSettings;
};

const KEY = "phaethon:focus-timer";
export const DEFAULT_SETTINGS: TimerSettings = { focus: 25, short: 5, long: 15, sound: false };
const LIMITS: Record<Exclude<keyof TimerSettings, "sound">, [number, number]> = { focus: [5, 120], short: [1, 30], long: [5, 60] };

function loadSettings(): TimerSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TimerSettings> | null;
    if (saved && typeof saved === "object") return clamp({ ...DEFAULT_SETTINGS, ...saved });
  } catch {
    // Storage unavailable or damaged: the defaults.
  }
  return DEFAULT_SETTINGS;
}

function clamp(s: TimerSettings): TimerSettings {
  const out = { ...s, sound: s.sound === true };
  for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const [lo, hi] = LIMITS[k];
    const n = Math.round(Number(s[k]));
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_SETTINGS[k];
  }
  return out;
}

export const minutesOf = (s: TimerSettings, p: Phase) => (p === "focus" ? s.focus : p === "short" ? s.short : s.long);

const initial = loadSettings();
let state: TimerState = { phase: "focus", running: false, endsAt: null, left: initial.focus * 60_000, rounds: 0, label: "", settings: initial };
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function set(next: TimerState) {
  state = next;
  listeners.forEach((l) => l());
  if (state.running && !ticker) ticker = setInterval(tick, 1000);
  if (!state.running && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/** What's left of the phase now, in ms. */
export const remaining = (s: TimerState = state, now = Date.now()) => (s.running && s.endsAt != null ? Math.max(0, s.endsAt - now) : s.left);

export const phaseName = (p: Phase) => (p === "focus" ? "Focus" : p === "short" ? "Short break" : "Long break");

function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
    osc.onended = () => void ctx.close();
  } catch {
    // No audio: the words still say it.
  }
}

function tick() {
  if (!state.running || remaining() > 0) {
    // A new snapshot each second, so the clock shown moves.
    state = { ...state };
    listeners.forEach((l) => l());
    return;
  }
  const s = state.settings;
  if (state.phase === "focus") {
    // Focus done: the break starts by itself.
    const rounds = state.rounds + 1;
    const phase: Phase = rounds % 4 === 0 ? "long" : "short";
    const ms = minutesOf(s, phase) * 60_000;
    set({ ...state, phase, rounds, running: true, endsAt: Date.now() + ms, left: ms });
    announce(`Focus session done${state.label ? `: ${state.label}` : ""}. Take a ${minutesOf(s, phase)}-minute break.`);
  } else {
    // Break over: the next focus waits for you.
    const ms = s.focus * 60_000;
    set({ ...state, phase: "focus", running: false, endsAt: null, left: ms });
    announce("Break over. Start the next focus session when you’re ready.");
  }
  if (s.sound) chime();
}

export function start(label?: string) {
  if (state.running) return;
  const left = state.left > 0 ? state.left : minutesOf(state.settings, state.phase) * 60_000;
  set({ ...state, running: true, endsAt: Date.now() + left, left, label: label ?? state.label });
}

export function pause() {
  if (!state.running) return;
  set({ ...state, running: false, left: remaining(), endsAt: null });
}

/** Back to a fresh focus session, rounds cleared. */
export function reset() {
  set({ ...state, phase: "focus", running: false, endsAt: null, left: state.settings.focus * 60_000, rounds: 0 });
}

/** End this phase now and move on, as if its time were up. */
export function skip() {
  set({ ...state, running: true, endsAt: Date.now() - 1 });
  tick();
}

export function setLabel(label: string) {
  set({ ...state, label });
}

export function setSettings(patch: Partial<TimerSettings>) {
  const settings = clamp({ ...state.settings, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Kept for this run only.
  }
  // A phase not yet started takes the new length at once.
  const fresh = !state.running && state.left === minutesOf(state.settings, state.phase) * 60_000;
  set({ ...state, settings, left: fresh ? minutesOf(settings, state.phase) * 60_000 : state.left });
}

export const useFocusTimer = () =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );

/** "24:05". */
export function clock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "24 minutes 5 seconds", for people who hear it. */
export function spokenClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return [m && `${m} minute${m === 1 ? "" : "s"}`, s && `${s} second${s === 1 ? "" : "s"}`].filter(Boolean).join(" ") || "0 seconds";
}
