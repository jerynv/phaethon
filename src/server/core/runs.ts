import { Refusal } from "../rpc/registry.ts";
import { log } from "../log.ts";
import { onStop } from "../lifecycle.ts";
import { reportGroups } from "../host.ts";
import { killWindowsChild } from "./windows-jobs.ts";

/**
 * At most one running thing per key: a turn in a space (key = space id), a
 * sign-in (`"\0sign-in:<cli>"`), a conversation clear. A run can be cancelled,
 * and every child process group it started is killed when the core stops.
 */

export const BUSY = "Phaethon is still replying in this space. Stop the reply or wait for it to finish, then try again.";

export type Run = {
  key: string;
  abort: AbortController;
  /** Process group ids (= leader pids) this run started. */
  groups: Set<number>;
};

const runs = new Map<string, Run>();

function report(): void {
  const all: number[] = [];
  for (const run of runs.values()) all.push(...run.groups);
  reportGroups(all);
}

/** A set of process groups that tells the desktop shell whenever it changes. */
class GroupSet extends Set<number> {
  override add(pgid: number): this {
    super.add(pgid);
    report();
    return this;
  }
  override delete(pgid: number): boolean {
    const had = super.delete(pgid);
    if (had) report();
    return had;
  }
}

/** Claims `key`, or returns undefined when something already runs there. */
export function claim(key: string): Run | undefined {
  if (runs.has(key)) return undefined;
  const run: Run = { key, abort: new AbortController(), groups: new GroupSet() };
  runs.set(key, run);
  return run;
}

export function release(run: Run): void {
  if (runs.get(run.key) === run) {
    runs.delete(run.key);
    if (run.groups.size) report();
  }
}

export function isRunning(key: string): boolean {
  return runs.has(key);
}

export function current(key: string): Run | undefined {
  return runs.get(key);
}

/** Asks the run at `key` to stop. False when nothing runs there. */
export function cancel(key: string): boolean {
  const run = runs.get(key);
  if (!run) return false;
  run.abort.abort();
  return true;
}

/** Runs `f` with `key` claimed, refusing with BUSY if it's taken; always releases. */
export async function whileIdle<T>(key: string, f: (run: Run) => Promise<T> | T): Promise<T> {
  const run = claim(key);
  if (!run) throw new Refusal(BUSY);
  try {
    return await f(run);
  } finally {
    release(run);
  }
}

/** SIGKILL to a whole process group; ignores groups that are already gone. */
export function killGroup(pgid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    if (process.platform === "win32") {
      if (!killWindowsChild(pgid)) process.kill(pgid, signal);
    }
    else process.kill(-pgid, signal);
  } catch {
    // Already exited.
  }
}

export function killAll(): void {
  for (const run of runs.values()) {
    run.abort.abort();
    for (const pgid of run.groups) killGroup(pgid);
  }
}

onStop("kill child process groups", () => {
  if (runs.size) log.info("killing running children", { runs: runs.size });
  killAll();
});
