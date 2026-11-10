import { BYTES_KEY, CHANNEL_KEY, isBytesRef, type ClientFrame, type CoreConnection, type ServerFrame } from "#shared/wire.ts";

/**
 * The renderer's connection to the Node core. `invoke` and `Channel` keep the
 * shape of Tauri's API (`invoke(name, args)`, `new Channel<T>()` with
 * `onmessage`), so every command in the porting spec is called the same way.
 *
 * The desktop preload provides the address and token. A page the core serves
 * itself (tests, later the phone) reads them from its URL fragment:
 * `#core=ws://127.0.0.1:1234/ws&token=…`, or connects back to its own origin.
 */

type DesktopBridge = { connection(): Promise<CoreConnection>; platform: string };
declare global {
  interface Window {
    phaethonDesktop?: DesktopBridge;
  }
}

export class Channel<T = unknown> {
  readonly id: number;
  onmessage: (message: T) => void = () => {};
  constructor(onmessage?: (message: T) => void) {
    this.id = nextChannel++;
    if (onmessage) this.onmessage = onmessage;
    channels.set(this.id, this as Channel<unknown>);
  }
  /** Stops delivery and tells the core the renderer no longer listens. */
  close(): void {
    if (!channels.delete(this.id)) return;
    sendFrame({ t: "close", ch: this.id });
  }
  toJSON() {
    return { [CHANNEL_KEY]: this.id };
  }
}

let nextChannel = 1;
let nextRequest = 1;
const channels = new Map<number, Channel<unknown>>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let socket: WebSocket | undefined;
let opening: Promise<WebSocket> | undefined;
const queue: string[] = [];
const statusListeners = new Set<(status: CoreStatus) => void>();
export type CoreStatus = "connecting" | "open" | "lost";
let status: CoreStatus = "connecting";

function setStatus(next: CoreStatus) {
  status = next;
  for (const listener of statusListeners) listener(next);
}

export function coreStatus(): CoreStatus {
  return status;
}

export function onCoreStatus(listener: (status: CoreStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

export function isDesktop(): boolean {
  return Boolean(window.phaethonDesktop);
}

async function connection(): Promise<CoreConnection> {
  if (window.phaethonDesktop) return window.phaethonDesktop.connection();
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token") ?? sessionStorage.getItem("phaethon.token") ?? "";
  if (params.get("token")) sessionStorage.setItem("phaethon.token", token);
  const url = params.get("core") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  return { url, token };
}

function decode(value: unknown): unknown {
  if (isBytesRef(value)) {
    const binary = atob(value[BYTES_KEY]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return value;
}

function open(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  opening ??= (async () => {
    const { url, token } = await connection();
    const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("Phaethon's core isn't reachable."));
    });
    ws.onmessage = (event) => receive(JSON.parse(String(event.data)) as ServerFrame);
    ws.onclose = () => {
      socket = undefined;
      opening = undefined;
      for (const waiting of pending.values()) waiting.reject("Phaethon's core stopped responding. Try again.");
      pending.clear();
      setStatus("lost");
      // Streams can't resume across a reconnect; their owners see the lost status.
      channels.clear();
      setTimeout(() => void open().catch(() => {}), 800);
    };
    socket = ws;
    setStatus("open");
    for (const frame of queue.splice(0)) ws.send(frame);
    return ws;
  })().catch((e) => {
    opening = undefined;
    setStatus("lost");
    setTimeout(() => void open().catch(() => {}), 1500);
    throw e;
  });
  return opening;
}

function sendFrame(frame: ClientFrame): void {
  const text = JSON.stringify(frame);
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(text);
  else {
    queue.push(text);
    void open().catch(() => {});
  }
}

function receive(frame: ServerFrame): void {
  if (frame.t === "ch") {
    channels.get(frame.ch)?.onmessage(frame.msg);
    return;
  }
  if (frame.t === "ok" || frame.t === "err") {
    const waiting = pending.get(frame.id);
    if (!waiting) return;
    pending.delete(frame.id);
    if (frame.t === "ok") waiting.resolve(decode(frame.value));
    else waiting.reject(frame.error);
  }
}

/**
 * Calls a core command. Resolves with its JSON result (an ArrayBuffer for
 * bytes) or rejects with the plain message to show.
 */
export function invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const id = nextRequest++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    // Channels serialize to their reference through toJSON.
    sendFrame({ t: "req", id, cmd, args: JSON.parse(JSON.stringify(args)) as Record<string, unknown> });
  });
}

/** Opens the connection early so the first command doesn't pay for it. */
export function connectCore(): Promise<void> {
  return open().then(() => undefined);
}

/** The message of a rejected invoke, whatever shape it took. */
export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
