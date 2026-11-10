import { BYTES_KEY, isChannelRef, type ClientFrame, type ServerFrame } from "#shared/wire.ts";
import { Channel } from "./channel.ts";
import { handlerFor, messageOf, Refusal } from "./registry.ts";
import { log } from "../log.ts";

/**
 * One renderer connection, whatever carries it: a MessagePort from the
 * desktop shell, or a WebSocket for a served page and for tests.
 */
export interface Link {
  send(text: string): boolean;
  onMessage(listener: (text: string) => void): void;
  onClose(listener: () => void): void;
}

/** Largest request accepted from a renderer (attachments arrive base64-encoded). */
const MAX_FRAME = 256 * 1024 * 1024;

function encodeResult(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (value instanceof ArrayBuffer) return { [BYTES_KEY]: Buffer.from(value).toString("base64") };
  return value === undefined ? null : value;
}

export function attach(link: Link): void {
  const abort = new AbortController();
  const channels = new Map<number, Channel>();
  const send = (frame: ServerFrame): boolean => link.send(JSON.stringify(frame));

  const revive = (value: unknown): unknown => {
    if (isChannelRef(value)) {
      const id = value.__phaethonChannel;
      const channel = new Channel(id, (msg) => send({ t: "ch", ch: id, msg }));
      channels.set(id, channel);
      channel.onClose(() => channels.delete(id));
      return channel;
    }
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      // defineProperty, so a "__proto__" key stays a plain key instead of setting the prototype.
      for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value: revive(v), enumerable: true, writable: true, configurable: true });
      return out;
    }
    return value;
  };

  link.onMessage(async (text) => {
    if (text.length > MAX_FRAME) return;
    let frame: ClientFrame;
    try {
      frame = JSON.parse(text) as ClientFrame;
    } catch {
      return;
    }
    if (frame.t === "ping") {
      send({ t: "pong" });
      return;
    }
    if (frame.t === "close") {
      channels.get(frame.ch)?.close();
      return;
    }
    if (frame.t !== "req" || typeof frame.id !== "number" || typeof frame.cmd !== "string") return;
    const handler = handlerFor(frame.cmd);
    if (!handler) {
      send({ t: "err", id: frame.id, error: `Unknown command ${frame.cmd}.` });
      return;
    }
    const args = frame.args && typeof frame.args === "object" && !Array.isArray(frame.args) ? frame.args : {};
    try {
      const value = await handler(revive(args), { signal: abort.signal });
      send({ t: "ok", id: frame.id, value: encodeResult(value) });
    } catch (e) {
      if (!(e instanceof Refusal) && typeof e !== "string") log.error(`command ${frame.cmd} failed`, e);
      send({ t: "err", id: frame.id, error: messageOf(e) });
    }
  });

  link.onClose(() => {
    abort.abort();
    for (const channel of [...channels.values()]) channel.close();
  });
}
