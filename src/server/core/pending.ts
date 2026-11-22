/**
 * Questions a running turn is waiting on (a write approval, an access request,
 * a lesson check), keyed by the conversation's run key (`turnKey`) and id. The turn awaits `ask`; the renderer's
 * answer command calls `answer`. Cancelling the turn rejects everything it
 * was waiting for.
 */

type Waiting = { resolve: (answer: unknown) => void; reject: (why: unknown) => void };

const waiting = new Map<string, Waiting>();
const keyOf = (scope: string, id: string) => `${scope}\0${id}`;

export function ask<T>(scope: string, id: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(new Error("cancelled"));
  const key = keyOf(scope, id);
  waiting.get(key)?.reject(new Error("superseded"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => entry.reject(new Error("cancelled"));
    const done = () => {
      if (waiting.get(key) === entry) waiting.delete(key);
      signal?.removeEventListener("abort", onAbort);
    };
    const entry: Waiting = {
      resolve: (a) => {
        done();
        resolve(a as T);
      },
      reject: (e) => {
        done();
        reject(e);
      },
    };
    waiting.set(key, entry);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Delivers an answer. False if nothing is waiting any more. */
export function answer(scope: string, id: string, value: unknown): boolean {
  const w = waiting.get(keyOf(scope, id));
  if (!w) return false;
  w.resolve(value);
  return true;
}

export function isWaiting(scope: string, id: string): boolean {
  return waiting.has(keyOf(scope, id));
}
