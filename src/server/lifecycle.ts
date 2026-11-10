import { log } from "./log.ts";

/**
 * Startup and shutdown work registered by the core's modules: migrations and
 * background imports on start, killing every child process group on stop.
 * Startup tasks run in registration order; a failing one is logged and the
 * rest still run, as the Rust setup did.
 */

type Task = { name: string; run: () => unknown };

const starts: Task[] = [];
const stops: Task[] = [];

export function onStart(name: string, run: () => unknown): void {
  starts.push({ name, run });
}

export function onStop(name: string, run: () => unknown): void {
  stops.push({ name, run });
}

export async function runStart(): Promise<void> {
  for (const task of starts) {
    try {
      await task.run();
    } catch (e) {
      log.error(`startup task ${task.name} failed`, e);
    }
  }
}

let stopping: Promise<void> | undefined;

export function runStop(): Promise<void> {
  stopping ??= (async () => {
    for (const task of [...stops].reverse()) {
      try {
        await task.run();
      } catch (e) {
        log.error(`shutdown task ${task.name} failed`, e);
      }
    }
  })();
  return stopping;
}
