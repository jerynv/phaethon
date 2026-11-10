import type { CoreToHost, HostEventBody, HostHello, HostOp, HostToCore } from "#shared/host.ts";
import { attach } from "./rpc/connection.ts";
import { Refusal } from "./rpc/registry.ts";
import { log } from "./log.ts";

/**
 * The core's side of the control channel to Electron's main process (the
 * utility process's parent port). Without a desktop shell (tests, a served
 * page) native operations refuse with a message, or a test can install its
 * own fake with `setHost`.
 */
export interface Host {
  readonly available: boolean;
  call<T = unknown>(op: HostOp): Promise<T>;
  on(listener: (event: HostEventBody) => void): () => void;
}

class NoHost implements Host {
  readonly available = false;
  call<T>(): Promise<T> {
    return Promise.reject(new Refusal("That needs the Phaethon desktop app."));
  }
  on(): () => void {
    return () => {};
  }
}

/** Electron's MessagePortMain / parentPort, typed loosely (the core builds against Node's types). */
type PortLike = {
  postMessage(message: unknown): void;
  on(event: "message", listener: (e: { data: unknown; ports: PortLike[] }) => void): void;
  on(event: "close", listener: () => void): void;
  start(): void;
};

class ParentHost implements Host {
  readonly available = true;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #listeners = new Set<(event: HostEventBody) => void>();

  private readonly parent: PortLike;
  constructor(parent: PortLike) {
    this.parent = parent;
  }

  write(frame: CoreToHost): void {
    this.parent.postMessage(frame);
  }

  receive(frame: HostToCore): void {
    if (frame.t === "hres") {
      const waiting = this.#pending.get(frame.id);
      if (!waiting) return;
      this.#pending.delete(frame.id);
      if (frame.ok) waiting.resolve(frame.value);
      else waiting.reject(new Refusal(frame.error));
    } else if (frame.t === "hevt") {
      for (const listener of this.#listeners) listener(frame.event);
    }
  }

  call<T>(op: HostOp): Promise<T> {
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.write({ t: "hreq", id, op });
    });
  }

  on(listener: (event: HostEventBody) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

let current: Host = new NoHost();
let parentHost: ParentHost | undefined;

export function host(): Host {
  return current;
}

/** Tests install a fake desktop shell here. */
export function setHost(next: Host): void {
  current = next;
}

/** Tells the desktop shell which process groups to kill if the core dies. */
export function reportGroups(pgids: number[]): void {
  parentHost?.write({ t: "groups", pgids });
}

/** The utility process's parent port, when the desktop shell started this core. */
export function parentPort(): PortLike | undefined {
  return (process as unknown as { parentPort?: PortLike }).parentPort;
}

/**
 * Connects to the desktop shell and waits for its hello. Renderer connections
 * arrive later as MessagePorts and are attached as they come.
 */
export function connectHost(parent: PortLike): Promise<{ hello: HostHello; ready: () => void }> {
  const pipe = new ParentHost(parent);
  parentHost = pipe;
  current = pipe;
  return new Promise((resolve) => {
    let hello: HostHello | undefined;
    parent.on("message", (event) => {
      const frame = event.data as HostToCore;
      if (!frame || typeof frame !== "object") return;
      if (frame.t === "hello" && !hello) {
        hello = frame;
        resolve({ hello, ready: () => pipe.write({ t: "ready" }) });
        return;
      }
      if (frame.t === "connect") {
        const port = event.ports[0];
        if (!port) return;
        let closed = false;
        const closeListeners: Array<() => void> = [];
        attach({
          send: (text) => {
            if (closed) return false;
            port.postMessage(text);
            return true;
          },
          onMessage: (listener) => port.on("message", (e) => listener(typeof e.data === "string" ? e.data : JSON.stringify(e.data))),
          onClose: (listener) => closeListeners.push(listener),
        });
        port.on("close", () => {
          closed = true;
          for (const listener of closeListeners) listener();
        });
        port.start();
        log.debug("renderer connected");
        return;
      }
      pipe.receive(frame);
    });
  });
}
