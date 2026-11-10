/**
 * A dev-only fake core: screens can be seen without a backend. Each file in
 * `./mocks/` default-exports `{ command_name: (args, ctx) => result }`; a
 * Channel argument arrives as an object with `send(message)`. The fake
 * replaces `WebSocket` for the core's address, so `invoke` and `Channel`
 * in `lib/core.ts` run unchanged.
 *
 * Minimal version owned by the chat worker until the shell's loader lands;
 * the shell worker owns the final one.
 */
import { BYTES_KEY, CHANNEL_KEY, type ClientFrame, type ServerFrame } from "#shared/wire.ts";

export type MockChannel = { send(message: unknown): void; readonly closed: boolean; onClose(fn: () => void): void };
export type MockHandler = (args: Record<string, unknown>) => unknown;
export type MockModule = Record<string, MockHandler>;

const handlers = new Map<string, MockHandler>();
const channels = new Map<number, { closed: boolean; listeners: (() => void)[] }>();

function bytesOut(value: unknown): unknown {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { [BYTES_KEY]: btoa(s) };
  }
  return value;
}

class FakeSocket {
  static readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  private out(frame: ServerFrame) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0);
  }
  send(text: string) {
    const frame = JSON.parse(text) as ClientFrame;
    if (frame.t === "close") {
      const ch = channels.get(frame.ch);
      if (ch) {
        ch.closed = true;
        ch.listeners.forEach((l) => l());
      }
      return;
    }
    if (frame.t !== "req") return;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(frame.args)) {
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>)[CHANNEL_KEY] === "number") {
        const id = (v as Record<string, number>)[CHANNEL_KEY];
        const state = { closed: false, listeners: [] as (() => void)[] };
        channels.set(id, state);
        const ch: MockChannel = {
          send: (msg) => !state.closed && this.out({ t: "ch", ch: id, msg }),
          get closed() {
            return state.closed;
          },
          onClose: (fn) => state.listeners.push(fn),
        };
        args[k] = ch;
      } else args[k] = v;
    }
    const handler = handlers.get(frame.cmd);
    if (!handler) {
      console.warn(`[mock core] no handler for ${frame.cmd}`, frame.args);
      this.out({ t: "err", id: frame.id, error: `The mock core has no ${frame.cmd}.` });
      return;
    }
    Promise.resolve()
      .then(() => handler(args))
      .then(
        (value) => this.out({ t: "ok", id: frame.id, value: bytesOut(value ?? null) }),
        (e: unknown) => this.out({ t: "err", id: frame.id, error: typeof e === "string" ? e : e instanceof Error ? e.message : String(e) }),
      );
  }
  close() {}
}

/** Registers handlers (later ones win) and swaps in the fake socket. */
export function installMockCore(modules: MockModule[]): void {
  for (const m of modules) for (const [k, v] of Object.entries(m)) handlers.set(k, v);
  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
}

/** Loads every `./mocks/*.ts` and installs them, when the page's hash contains "mock". */
export async function installMocksFromHash(): Promise<boolean> {
  if (!location.hash.includes("mock")) return false;
  const found = import.meta.glob<{ default: MockModule }>("./mocks/*.ts");
  const modules = await Promise.all(Object.values(found).map((load) => load().then((m) => m.default)));
  installMockCore(modules);
  return true;
}

/** Waits `ms`, for scripted streams. */
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
