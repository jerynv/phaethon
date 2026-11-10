import { BYTES_KEY, CHANNEL_KEY, isBytesRef, type ClientFrame, type ServerFrame } from "#shared/wire.ts";

/**
 * The renderer's connection to the Node core. `invoke` and `Channel` keep the
 * shape of Tauri's API (`invoke(name, args)`, `new Channel<T>()` with
 * `onmessage`), so every command in the porting spec is called the same way.
 *
 * In the desktop app the connection is a MessagePort the shell hands over
 * (no network port, no token). A page the core serves itself (tests, later
 * the phone) uses a WebSocket and reads its token from the URL fragment:
 * `#token=…` (optionally `&core=ws://host:port/ws`).
 */

type DesktopBridge = { connect(): void; platform: string };
declare global {
  interface Window {
    phaethonDesktop?: DesktopBridge;
  }
}

/** What carries frames to the core. */
interface Transport {
  send(text: string): void;
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

export type CoreStatus = "connecting" | "open" | "lost";

let nextChannel = 1;
let nextRequest = 1;
const channels = new Map<number, Channel<unknown>>();
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
const queue: string[] = [];
const statusListeners = new Set<(status: CoreStatus) => void>();
let transport: Transport | undefined;
let opening: Promise<Transport> | undefined;
let status: CoreStatus = "connecting";

function setStatus(next: CoreStatus) {
  if (status === next) return;
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

function decode(value: unknown): unknown {
  if (isBytesRef(value)) {
    const binary = atob(value[BYTES_KEY]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }
  return value;
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

function lost(): void {
  transport = undefined;
  opening = undefined;
  for (const waiting of pending.values()) waiting.reject("Phaethon's core stopped responding. Try again.");
  pending.clear();
  // Streams can't resume across a reconnect; their owners see the lost status.
  channels.clear();
  setStatus("lost");
  setTimeout(() => void open().catch(() => {}), 800);
}

function desktopTransport(bridge: DesktopBridge): Promise<Transport> {
  return new Promise((resolve) => {
    const onPort = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== location.origin) return;
      if ((event.data as { phaethon?: string } | null)?.phaethon !== "core-port") return;
      const port = event.ports[0];
      if (!port) return;
      window.removeEventListener("message", onPort);
      port.onmessage = (e) => receive(JSON.parse(String(e.data)) as ServerFrame);
      port.start();
      resolve({ send: (text) => port.postMessage(text) });
    };
    window.addEventListener("message", onPort);
    bridge.connect();
  });
}

async function socketTransport(): Promise<Transport> {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = params.get("token");
  if (fromUrl) sessionStorage.setItem("phaethon.token", fromUrl);
  const token = fromUrl ?? sessionStorage.getItem("phaethon.token") ?? "";
  const url = params.get("core") ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Phaethon's core isn't reachable."));
  });
  ws.onmessage = (event) => receive(JSON.parse(String(event.data)) as ServerFrame);
  ws.onclose = lost;
  return { send: (text) => ws.send(text) };
}

function open(): Promise<Transport> {
  if (transport) return Promise.resolve(transport);
  opening ??= (window.phaethonDesktop ? desktopTransport(window.phaethonDesktop) : socketTransport()).then(
    (t) => {
      transport = t;
      setStatus("open");
      for (const frame of queue.splice(0)) t.send(frame);
      return t;
    },
    (e) => {
      opening = undefined;
      setStatus("lost");
      setTimeout(() => void open().catch(() => {}), 1500);
      throw e;
    },
  );
  return opening;
}

function sendFrame(frame: ClientFrame): void {
  const text = JSON.stringify(frame);
  if (transport) transport.send(text);
  else {
    queue.push(text);
    void open().catch(() => {});
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
