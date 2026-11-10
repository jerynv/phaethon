/**
 * Questions a running turn is waiting on (a write approval, an access request,
 * a lesson check), keyed by space and id. The turn awaits `ask`; the renderer's
 * answer command calls `answer`. Cancelling the turn rejects everything it
 * was waiting for.
 */

type Waiting = { resolve: (answer: unknown) => void; reject: (why: unknown) => void };

const waiting = new Map<string, Waiting>();
const keyOf = (space: string, id: string) => `${space}\0${id}`;

export function ask<T>(space: string, id: string, signal?: AbortSignal): Promise<T> {
  const key = keyOf(space, id);
  return new Promise<T>((resolve, reject) => {
    const done = () => waiting.delete(key);
    waiting.set(key, {
      resolve: (a) => {
        done();
        resolve(a as T);
      },
      reject: (e) => {
        done();
        reject(e);
      },
    });
    signal?.addEventListener("abort", () => waiting.get(key)?.reject(new Error("cancelled")), { once: true });
  });
}

/** Delivers an answer. False if nothing is waiting any more. */
export function answer(space: string, id: string, value: unknown): boolean {
  const w = waiting.get(keyOf(space, id));
  if (!w) return false;
  w.resolve(value);
  return true;
}

export function isWaiting(space: string, id: string): boolean {
  return waiting.has(keyOf(space, id));
}
