/**
 * A dev-only fake core, so screens can be seen without a backend: when the
 * page's hash contains `mock`, every file in ./mocks registers command
 * handlers (`export default { command_name: (args) => result }`), and a fake
 * WebSocket answers the renderer's frames with them. Channel arguments arrive
 * as `{ id, send(message) }`. Handlers may be async and may throw a string
 * (the error the UI shows).
 *
 * Hash options: `fail=cmd1,cmd2` rejects those commands, `slow=cmd` never
 * answers it (loading states), `scenario=<name>` is read by the mocks.
 *
 * Minimal version by the education worker; the shell worker owns the final one.
 */
import { CHANNEL_KEY, type ClientFrame, type ServerFrame } from "#shared/wire.ts";

export type MockChannel = { id: number; send(message: unknown): void; readonly closed: boolean };
export type MockHandler = (args: Record<string, unknown>) => unknown;

declare global {
  interface Window {
    __mockCalls?: [string, unknown][];
  }
}

export function mockParams(): URLSearchParams {
  return new URLSearchParams(location.hash.slice(1).replace(/^mock&?/, ""));
}

export function mockScenario(): string {
  return mockParams().get("scenario") ?? "";
}

export async function installMockCore(): Promise<void> {
  const modules = import.meta.glob<{ default: Record<string, MockHandler> }>("./mocks/*.ts", { eager: true });
  const handlers: Record<string, MockHandler> = {};
  for (const m of Object.values(modules)) Object.assign(handlers, m.default);
  const params = mockParams();
  const failing = new Set((params.get("fail") ?? "").split(",").filter(Boolean));
  const slow = new Set((params.get("slow") ?? "").split(",").filter(Boolean));
  window.__mockCalls = [];

  class FakeSocket {
    static readonly OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    private closedChannels = new Set<number>();

    constructor(_url: string) {
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.();
      }, 0);
    }

    private reply(frame: ServerFrame) {
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(frame) }), 0);
    }

    send(text: string) {
      const frame = JSON.parse(text) as ClientFrame;
      if (frame.t === "close") {
        this.closedChannels.add(frame.ch);
        return;
      }
      if (frame.t !== "req") return;
      const { id, cmd } = frame;
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(frame.args)) {
        const ch = v && typeof v === "object" ? (v as Record<string, unknown>)[CHANNEL_KEY] : undefined;
        if (typeof ch === "number") {
          const sock = this;
          args[k] = {
            id: ch,
            send: (message: unknown) => {
              if (!sock.closedChannels.has(ch)) sock.onmessage?.({ data: JSON.stringify({ t: "ch", ch, msg: message }) });
            },
            get closed() {
              return sock.closedChannels.has(ch);
            },
          } satisfies MockChannel;
        } else args[k] = v;
      }
      window.__mockCalls!.push([cmd, frame.args]);
      if (slow.has(cmd)) return;
      if (failing.has(cmd)) return this.reply({ t: "err", id, error: "The core couldn’t read it (preview failure)." });
      const handler = handlers[cmd];
      if (!handler) return this.reply({ t: "err", id, error: `Not available in this preview: ${cmd}` });
      Promise.resolve()
        .then(() => handler(args))
        .then(
          (value) => this.reply({ t: "ok", id, value: value ?? null }),
          (e: unknown) => this.reply({ t: "err", id, error: typeof e === "string" ? e : e instanceof Error ? e.message : String(e) }),
        );
    }

    close() {}
  }

  (window as unknown as { WebSocket: unknown }).WebSocket = FakeSocket;
}
