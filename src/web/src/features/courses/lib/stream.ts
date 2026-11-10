/**
 * Waiting for a stream's end. A streaming command resolves when the core is
 * done sending, but its last messages may still be on their way, so the run
 * ends on the terminal event; if the command resolved and no terminal event
 * comes within `graceMs`, the run ends anyway (`timedOut`). A rejection before
 * any terminal event ends the run with that error. Pure (timers injected).
 */
export type StreamEnd = { kind: "terminal" } | { kind: "timedOut" } | { kind: "rejected"; error: unknown };

export function untilTerminal<E>(
  start: (onEvent: (e: E) => void) => Promise<unknown>,
  onEvent: (e: E) => void,
  isTerminal: (e: E) => boolean,
  graceMs = 15_000,
  timers: { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void } = {
    set: (f, ms) => setTimeout(f, ms),
    clear: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): Promise<StreamEnd> {
  return new Promise<StreamEnd>((resolve) => {
    let ended = false;
    let timer: unknown;
    const end = (how: StreamEnd) => {
      if (ended) return;
      ended = true;
      if (timer !== undefined) timers.clear(timer);
      resolve(how);
    };
    start((e) => {
      if (ended) return;
      onEvent(e);
      if (isTerminal(e)) end({ kind: "terminal" });
    }).then(
      () => {
        if (!ended) timer = timers.set(() => end({ kind: "timedOut" }), graceMs);
      },
      (error: unknown) => end({ kind: "rejected", error }),
    );
  });
}
