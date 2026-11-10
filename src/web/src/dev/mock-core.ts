/**
 * Dev-only fake core. When the page URL's hash contains "mock"
 * (http://localhost:<port>/#mock), main.tsx installs this before anything
 * talks to the core. It replaces the WebSocket the renderer uses, so
 * `invoke` and `Channel` from lib/core.ts run unchanged against handlers
 * from ./mocks/*.ts.
 *
 * A mock module default-exports `{ command_name: (args, ctx) => result }`.
 * A handler may be async; throwing a string (or Error) rejects the invoke
 * with that message. `ctx.channel(args.onEvent)` returns `{ send(msg) }` to
 * stream Channel messages, `ctx.sleep(ms)` waits, and `ctx.state` is a bag
 * shared by every handler. ./mocks/shell.ts loads first, so a feature's own
 * mock file wins for a command both define.
 *
 * Browser console / Playwright hooks on `window.__mock`:
 *   fail[cmd] = "message"   that command rejects with the message
 *   slow[cmd] = ms          that command answers after ms
 *   calls                   every [cmd, args] received
 *   disconnect(ms)          drop the connection and refuse reconnects for ms
 *   state                   the shared state bag
 * and `window.__phaethon.nav` is the navigation store.
 *
 * Production builds never include this file: main.tsx imports it only when
 * import.meta.env.DEV is true, which Vite replaces with false in a build.
 */
import { BYTES_KEY, CHANNEL_KEY, type ClientFrame, type ServerFrame } from "#shared/wire.ts";
import { useNav } from "@/app/nav";

export type MockContext = {
  channel(ref: unknown): { send(message: unknown): void };
  sleep(ms: number): Promise<void>;
  state: Record<string, unknown>;
};
/** A Channel argument as handlers receive it (channel references in args are revived into these). */
export type MockChannel = { send(message: unknown): void; readonly closed: boolean; onClose(fn: () => void): void };
export type MockHandler = (args: any, ctx: MockContext) => unknown;
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type MockHandlers = Record<string, MockHandler>;

type MockControl = {
  fail: Record<string, string>;
  slow: Record<string, number>;
  calls: [string, unknown][];
  state: Record<string, unknown>;
  handlers: MockHandlers;
  disconnect(ms?: number): void;
};

declare global {
  interface Window {
    __mock?: MockControl;
    __phaethon?: { nav: typeof useNav };
  }
}

/** Default latency, so loading states show for a moment as they would for real. */
const LATENCY_MS = 90;

function loadHandlers(): MockHandlers {
  const modules = import.meta.glob<{ default: MockHandlers }>("./mocks/*.ts", { eager: true });
  const paths = Object.keys(modules).sort((a, b) => {
    if (a.endsWith("/shell.ts")) return -1;
    if (b.endsWith("/shell.ts")) return 1;
    return a.localeCompare(b);
  });
  const handlers: MockHandlers = {};
  for (const path of paths) Object.assign(handlers, modules[path].default);
  return handlers;
}

function encode(value: unknown): unknown {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return { [BYTES_KEY]: btoa(binary) };
  }
  return value === undefined ? null : value;
}

export function installMockCore(): void {
  const handlers = loadHandlers();
  const state: Record<string, unknown> = {};
  let active: FakeSocket | null = null;
  let downUntil = 0;
  const control: MockControl = {
    fail: {},
    slow: {},
    calls: [],
    state,
    handlers,
    disconnect(ms = 4000) {
      downUntil = Date.now() + ms;
      active?.drop();
    },
  };
  window.__mock = control;
  window.__phaethon = { nav: useNav };

  class FakeSocket {
    private readonly channels = new Map<number, { closed: boolean; listeners: Array<() => void> }>();
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = FakeSocket.CONNECTING;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      setTimeout(() => {
        if (Date.now() < downUntil) {
          this.readyState = FakeSocket.CLOSED;
          this.onerror?.(new Event("error"));
          return;
        }
        this.readyState = FakeSocket.OPEN;
        active = this;
        this.onopen?.(new Event("open"));
      }, 20);
    }

    private emit(frame: ServerFrame) {
      if (this.readyState !== FakeSocket.OPEN) return;
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
    }

    drop() {
      if (this.readyState !== FakeSocket.OPEN) return;
      this.readyState = FakeSocket.CLOSED;
      if (active === this) active = null;
      this.onclose?.(new CloseEvent("close"));
    }

    close() {
      this.drop();
    }

    /** A live channel object for a reference the renderer sent. */
    private mockChannel(ch: number): MockChannel {
      const entry = this.channels.get(ch) ?? { closed: false, listeners: [] };
      this.channels.set(ch, entry);
      return {
        send: (msg: unknown) => {
          if (!entry.closed) this.emit({ t: "ch", ch, msg: encode(msg) });
        },
        get closed() {
          return entry.closed;
        },
        onClose: (fn) => {
          if (entry.closed) fn();
          else entry.listeners.push(fn);
        },
      };
    }

    private revive(value: unknown): unknown {
      if (value && typeof value === "object" && typeof (value as Record<string, unknown>)[CHANNEL_KEY] === "number") {
        return this.mockChannel((value as Record<string, number>)[CHANNEL_KEY]);
      }
      if (Array.isArray(value)) return value.map((v) => this.revive(v));
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.revive(v)]));
      return value;
    }

    send(text: string) {
      const frame = JSON.parse(text) as ClientFrame;
      if (frame.t === "close") {
        const entry = this.channels.get(frame.ch);
        if (entry && !entry.closed) {
          entry.closed = true;
          for (const fn of entry.listeners.splice(0)) fn();
        }
        return;
      }
      if (frame.t !== "req") return;
      const { id, cmd } = frame;
      const args = this.revive(frame.args) as Record<string, unknown>;
      control.calls.push([cmd, args]);
      const ctx: MockContext = {
        state,
        sleep,
        // Channel arguments arrive already revived; this also accepts a raw reference.
        channel: (ref) => {
          if (ref && typeof (ref as MockChannel).send === "function") return ref as MockChannel;
          const ch = (ref as Record<string, unknown> | null)?.[CHANNEL_KEY];
          return typeof ch === "number" ? this.mockChannel(ch) : { send: () => {} };
        },
      };
      void (async () => {
        await sleep(control.slow[cmd] ?? LATENCY_MS);
        try {
          if (control.fail[cmd]) throw control.fail[cmd];
          const handler = handlers[cmd];
          if (!handler) throw `The mock core has no handler for ${cmd}.`;
          const value = await handler(args, ctx);
          this.emit({ t: "ok", id, value: encode(value) });
        } catch (e) {
          this.emit({ t: "err", id, error: typeof e === "string" ? e : e instanceof Error ? e.message : String(e) });
        }
      })();
    }
  }

  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
  console.info(`[mock core] ${Object.keys(handlers).length} commands from ./mocks`);
}

/** The mock's URL options (`#mock&scenario=…&thread=…`), for mock modules that offer variants. */
export function mockParams(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1).replace(/^mock&?/, ""));
}

export function mockScenario(): string {
  return mockParams().get("scenario") ?? "";
}
