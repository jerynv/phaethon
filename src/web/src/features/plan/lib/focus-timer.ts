/**
 * The focus timer: focus, then a short break, every fourth break a long one.
 * One for the whole app, so it keeps running across views and spaces. Its
 * settings are this device's (local storage). Time comes from the clock, so a
 * throttled tick never drifts. Phase changes are announced through `onSay`.
 */
import { create } from "zustand";

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
  /** Bumped every second while running, so the clock shown moves. */
  tick: number;
};

const KEY = "phaethon:focus-timer";
export const DEFAULT_SETTINGS: TimerSettings = { focus: 25, short: 5, long: 15, sound: false };
const LIMITS: Record<Exclude<keyof TimerSettings, "sound">, [number, number]> = { focus: [5, 120], short: [1, 30], long: [5, 60] };

export function clampSettings(s: Partial<TimerSettings>): TimerSettings {
  const out: TimerSettings = { ...DEFAULT_SETTINGS, ...s, sound: s.sound === true };
  for (const k of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    const [lo, hi] = LIMITS[k];
    const n = Math.round(Number(s[k]));
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_SETTINGS[k];
  }
  return out;
}

function loadSettings(): TimerSettings {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "null") as Partial<TimerSettings> | null;
    if (saved && typeof saved === "object") return clampSettings(saved);
  } catch {
    // Storage unavailable or damaged: the defaults.
  }
  return DEFAULT_SETTINGS;
}

export const minutesOf = (s: TimerSettings, p: Phase) => (p === "focus" ? s.focus : p === "short" ? s.short : s.long);
export const phaseName = (p: Phase) => (p === "focus" ? "Focus" : p === "short" ? "Short break" : "Long break");

/** What's left of the phase now, in ms. */
export const remaining = (s: Pick<TimerState, "running" | "endsAt" | "left">, now = Date.now()) =>
  s.running && s.endsAt != null ? Math.max(0, s.endsAt - now) : s.left;

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

/** The phase after `state`'s ends: a finished focus starts its break; a finished break waits, paused, for the next focus. */
export function nextPhase(state: TimerState, now = Date.now()): { state: TimerState; said: string } {
  const s = state.settings;
  if (state.phase === "focus") {
    const rounds = state.rounds + 1;
    const phase: Phase = rounds % 4 === 0 ? "long" : "short";
    const ms = minutesOf(s, phase) * 60_000;
    return {
      state: { ...state, phase, rounds, running: true, endsAt: now + ms, left: ms },
      said: `Focus session done${state.label ? `: ${state.label}` : ""}. Take a ${minutesOf(s, phase)}-minute break.`,
    };
  }
  const ms = s.focus * 60_000;
  return { state: { ...state, phase: "focus", running: false, endsAt: null, left: ms }, said: "Break over. Start the next focus session when you’re ready." };
}

let onSay: (text: string) => void = () => {};
export function setTimerVoice(say: (text: string) => void) {
  onSay = say;
}

function chime() {
  try {
    const Ctx = window.AudioContext;
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

type Actions = {
  start(label?: string): void;
  pause(): void;
  reset(): void;
  skip(): void;
  setSettings(patch: Partial<TimerSettings>): void;
};

const initial = loadSettings();
let ticker: ReturnType<typeof setInterval> | null = null;

export const useFocusTimer = create<TimerState & Actions>((set, get) => {
  const apply = (next: Partial<TimerState>) => {
    set(next);
    const running = get().running;
    if (running && !ticker) ticker = setInterval(tick, 1000);
    if (!running && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  };
  const tick = () => {
    const state = get();
    if (!state.running || remaining(state) > 0) {
      set({ tick: state.tick + 1 });
      return;
    }
    const { state: next, said } = nextPhase(state);
    apply(next);
    onSay(said);
    if (state.settings.sound) chime();
  };
  return {
    phase: "focus",
    running: false,
    endsAt: null,
    left: initial.focus * 60_000,
    rounds: 0,
    label: "",
    settings: initial,
    tick: 0,
    start: (label) => {
      const s = get();
      if (s.running) return;
      const left = s.left > 0 ? s.left : minutesOf(s.settings, s.phase) * 60_000;
      apply({ running: true, endsAt: Date.now() + left, left, label: label ?? s.label });
    },
    pause: () => {
      const s = get();
      if (!s.running) return;
      apply({ running: false, left: remaining(s), endsAt: null });
    },
    reset: () => apply({ phase: "focus", running: false, endsAt: null, left: get().settings.focus * 60_000, rounds: 0, label: "" }),
    skip: () => {
      apply({ running: true, endsAt: Date.now() - 1 });
      tick();
    },
    setSettings: (patch) => {
      const s = get();
      const settings = clampSettings({ ...s.settings, ...patch });
      try {
        globalThis.localStorage?.setItem(KEY, JSON.stringify(settings));
      } catch {
        // Kept for this run only.
      }
      const fresh = !s.running && s.left === minutesOf(s.settings, s.phase) * 60_000;
      apply({ settings, left: fresh ? minutesOf(settings, s.phase) * 60_000 : s.left });
    },
  };
});
