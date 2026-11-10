import net from "node:net";
import { createInterface } from "node:readline";
import type { CoreToHost, HostEventBody, HostHello, HostOp, HostToCore } from "#shared/host.ts";
import { Refusal } from "./rpc/registry.ts";
import { log } from "./log.ts";

/**
 * The core's side of the control channel to Electron's main process. Without a
 * desktop shell (tests, a served page) native operations refuse with a message,
 * or a test can install its own fake with `setHost`.
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

class PipeHost implements Host {
  readonly available = true;
  #next = 1;
  #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  #listeners = new Set<(event: HostEventBody) => void>();

  constructor(private readonly socket: net.Socket) {}

  write(frame: CoreToHost): void {
    this.socket.write(JSON.stringify(frame) + "\n");
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

  failAll(why: string): void {
    for (const waiting of this.#pending.values()) waiting.reject(new Refusal(why));
    this.#pending.clear();
  }
}

let current: Host = new NoHost();

export function host(): Host {
  return current;
}

/** Tests install a fake desktop shell here. */
export function setHost(next: Host): void {
  current = next;
}

/**
 * Connects to the desktop shell on fd 3 and waits for its hello. Returns the
 * hello and a function to report readiness.
 */
export function connectHost(fd: number): Promise<{ hello: HostHello; ready: (port: number) => void }> {
  const socket = new net.Socket({ fd, readable: true, writable: true });
  const pipe = new PipeHost(socket);
  current = pipe;
  return new Promise((resolve, reject) => {
    let hello: HostHello | undefined;
    const lines = createInterface({ input: socket });
    lines.on("line", (text) => {
      let frame: HostToCore;
      try {
        frame = JSON.parse(text) as HostToCore;
      } catch {
        return;
      }
      if (frame.t === "hello" && !hello) {
        hello = frame;
        resolve({ hello, ready: (port) => pipe.write({ t: "ready", port }) });
        return;
      }
      pipe.receive(frame);
    });
    socket.on("close", () => {
      pipe.failAll("The desktop app closed.");
      if (!hello) reject(new Error("The desktop shell closed before saying hello."));
      else {
        log.info("desktop shell went away; stopping");
        process.emit("SIGTERM");
      }
    });
    socket.on("error", (e) => log.warn("control channel error", e));
  });
}
