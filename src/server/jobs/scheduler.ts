import path from "node:path";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";
import { isTest } from "../env.ts";
import { log } from "../log.ts";
import { messageOf, Refusal } from "../rpc/registry.ts";
import { nextRun, parseCron, previousRun } from "./cron.ts";
import { backgroundSettings, notifyLater } from "../background/background.ts";

/**
 * Background jobs in the core, while Phaethon is open. Each job has a
 * schedule and a readiness check, so it runs only when it has something to
 * do ("no mail account is assigned to a space" says why it's idle). A run
 * missed while the app was closed runs once at the next tick, within a day.
 * Run state is in `<vault>/.phaethon/jobs.json`; nothing runs on its own in
 * tests (they call `runJob`).
 */

export type Ready = { ok: true } | { ok: false; reason: string };

export type JobDef = {
  id: string;
  title: string;
  description: string;
  /** Five-field cron, read every tick (a setting can change it). */
  cron: () => string;
  defaultOn: boolean;
  /** Can the person turn it off? (The sweep is cheap and keeps memory honest.) */
  optional: boolean;
  ready: () => Ready;
  run: (signal: AbortSignal, since: number | undefined) => Promise<string>;
  /** Uses a model (counts against the one-at-a-time limit). */
  model: boolean;
};

export type JobState = { enabled?: boolean; since?: number; lastRun?: number; lastOk?: boolean; lastResult?: string; lastError?: string };

export type JobView = {
  id: string;
  title: string;
  description: string;
  cron: string;
  enabled: boolean;
  optional: boolean;
  ready: Ready;
  running: boolean;
  next: number | null;
} & Omit<JobState, "enabled" | "since">;

const CATCH_UP_MS = 24 * 3_600_000;
/** Not automations: they keep running while automations are paused. */
const ALWAYS = new Set(["memory-sweep", "reminders"]);
const TICK_MS = 30_000;

export function jobsFile(): string {
  return path.join(vaultStateDir(), "jobs.json");
}

function readState(): Record<string, JobState> {
  try {
    const doc = readJson<{ jobs?: Record<string, JobState> }>(jobsFile(), {});
    return doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  } catch {
    return {};
  }
}

function writeState(s: Record<string, JobState>): void {
  writeJsonAtomic(jobsFile(), { version: 1, jobs: s }, { newline: true });
}

function patchState(id: string, patch: JobState): void {
  const s = readState();
  s[id] = { ...s[id], ...patch };
  writeState(s);
}

const builtins = new Map<string, JobDef>();
let dynamic: () => JobDef[] = () => [];
const running = new Map<string, AbortController>();
let modelBusy = false;

export function registerJob(j: JobDef): void {
  builtins.set(j.id, j);
}

/** Jobs that come and go (the person's schedules). */
export function setDynamicJobs(f: () => JobDef[]): void {
  dynamic = f;
}

export function allJobs(): JobDef[] {
  return [...builtins.values(), ...dynamic()];
}

function find(id: string): JobDef {
  const j = allJobs().find((x) => x.id === id);
  if (!j) throw new Refusal("That job no longer exists.");
  return j;
}

function safeReady(j: JobDef): Ready {
  try {
    return j.ready();
  } catch (e) {
    return { ok: false, reason: messageOf(e) };
  }
}

export function isEnabled(j: JobDef, st: JobState | undefined = readState()[j.id]): boolean {
  if (!j.optional) return true;
  return st?.enabled ?? j.defaultOn;
}

export function viewJobs(now = Date.now()): JobView[] {
  const s = readState();
  return allJobs().map((j) => {
    const st = s[j.id] ?? {};
    let next: number | null = null;
    try {
      next = nextRun(parseCron(j.cron()), now) ?? null;
    } catch {
      next = null;
    }
    return {
      id: j.id,
      title: j.title,
      description: j.description,
      cron: j.cron(),
      enabled: isEnabled(j, st),
      optional: j.optional,
      ready: safeReady(j),
      running: running.has(j.id),
      next,
      ...(st.lastRun !== undefined ? { lastRun: st.lastRun } : {}),
      ...(st.lastOk !== undefined ? { lastOk: st.lastOk } : {}),
      ...(st.lastResult ? { lastResult: st.lastResult } : {}),
      ...(st.lastError ? { lastError: st.lastError } : {}),
    };
  });
}

/** When a job last ran, or when counting started. */
export function jobBaseline(id: string): number | undefined {
  const st = readState()[id];
  return st?.lastRun ?? st?.since;
}

/** Starts counting from now: a schedule just switched on waits for its next time. */
export function resetBaseline(id: string): void {
  const s = readState();
  s[id] = { ...s[id], since: Date.now() };
  delete s[id]!.lastRun;
  writeState(s);
}

export function setJobEnabled(id: string, enabled: boolean): void {
  const j = find(id);
  if (!j.optional && !enabled) throw new Refusal("That job keeps memory accurate and can’t be turned off.");
  // Turning on starts counting from now, so a daily job doesn't fire the moment it's switched on.
  patchState(id, { enabled, ...(enabled ? { since: Date.now() } : {}) });
}

/** Runs a job now (the "Run now" button, tests). Resolves with its result line. */
export async function runJob(id: string, opts: { force?: boolean } = {}): Promise<string> {
  const j = find(id);
  if (running.has(id)) throw new Refusal("That job is already running.");
  const ready = safeReady(j);
  if (!ready.ok && !opts.force) throw new Refusal(ready.reason);
  if (j.model && modelBusy) throw new Refusal("Another background job is using the model; try again in a moment.");
  const ctl = new AbortController();
  running.set(id, ctl);
  if (j.model) modelBusy = true;
  const st = readState()[id];
  const since = st?.lastRun ?? st?.since;
  const started = Date.now();
  try {
    const result = await j.run(ctl.signal, since);
    patchState(id, { lastRun: started, lastOk: true, lastResult: result.slice(0, 500), lastError: undefined });
    return result;
  } catch (e) {
    const message = messageOf(e);
    patchState(id, { lastRun: started, lastOk: false, lastError: message.slice(0, 500) });
    log.warn(`job ${id} failed`, { error: message });
    if (j.model || id.startsWith("schedule:")) notifyLater({ kind: "job", title: `${j.title} didn’t run`, body: message.slice(0, 200), target: { kind: "settings", section: "automations" } });
    throw e;
  } finally {
    running.delete(id);
    if (j.model) modelBusy = false;
  }
}

/** One pass: every enabled, ready job whose scheduled minute has come since it last ran. */
export async function tick(now = Date.now()): Promise<string[]> {
  const s = readState();
  const started: string[] = [];
  const paused = (backgroundSettings().pausedUntil ?? 0) > now;
  for (const j of allJobs()) {
    const st = s[j.id] ?? {};
    if (!isEnabled(j, st) || running.has(j.id)) continue;
    if (paused && !ALWAYS.has(j.id)) continue;
    let due: number | undefined;
    try {
      due = previousRun(parseCron(j.cron()), now, CATCH_UP_MS);
    } catch {
      continue;
    }
    if (due === undefined) continue;
    const baseline = st.lastRun ?? st.since;
    if (baseline === undefined) {
      // First sight: start counting from now (the sweep runs at once; it's cheap).
      if (j.model || j.optional) {
        patchState(j.id, { since: now });
        continue;
      }
    } else if (due <= baseline) continue;
    if (!safeReady(j).ok) continue;
    if (j.model && modelBusy) continue;
    started.push(j.id);
    void runJob(j.id).catch(() => {});
  }
  return started;
}

let timer: NodeJS.Timeout | undefined;

export function startScheduler(): void {
  if (timer || (isTest() && process.env.PHAETHON_JOBS !== "1")) return;
  const loop = () => {
    tick().catch((e) => log.warn("job tick failed", { error: messageOf(e) }));
  };
  setTimeout(loop, 5_000).unref?.();
  timer = setInterval(loop, TICK_MS);
  timer.unref?.();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const c of running.values()) c.abort();
}

/** Tests. */
export function _resetJobs(): void {
  builtins.clear();
  dynamic = () => [];
  running.clear();
  modelBusy = false;
}
