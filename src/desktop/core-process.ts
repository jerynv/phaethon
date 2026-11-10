import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import type { CoreToHost, HostEventBody, HostOp, HostToCore } from "../shared/host.ts";

/**
 * Runs the Node core as an Electron utility process (no RunAsNode fuse, no
 * TCP port). Main talks to it over the parent port; each renderer gets its
 * own MessagePort to it. The core reports the process groups its agents lead,
 * and main kills them if the core dies, so nothing outlives a crash.
 */
export type CoreProcess = {
  child: UtilityProcess;
  emit(event: HostEventBody): void;
  /** A new port for a renderer, already connected to the core. */
  connect(): MessagePortMain;
  stop(): Promise<void>;
};

function killGroups(pgids: Iterable<number>): void {
  for (const pgid of pgids) {
    try {
      if (process.platform === "win32") process.kill(pgid, "SIGKILL");
      else process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

export function startCore(options: {
  entry: string;
  appVersion: string;
  /** Extra environment for the core (whether this is a packaged release). */
  env?: Record<string, string>;
  handle: (op: HostOp) => Promise<unknown>;
  onExit: (code: number) => void;
}): Promise<CoreProcess> {
  const child = utilityProcess.fork(options.entry, [], {
    serviceName: "Phaethon core",
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
  const write = (frame: HostToCore, transfer: MessagePortMain[] = []) => child.postMessage(frame, transfer);
  let groups: number[] = [];
  let stopping = false;

  return new Promise((resolve, reject) => {
    let ready = false;
    child.on("message", (frame: CoreToHost) => {
      if (!frame || typeof frame !== "object") return;
      if (frame.t === "ready" && !ready) {
        ready = true;
        resolve({
          child,
          emit: (event) => write({ t: "hevt", event }),
          connect: () => {
            const { port1, port2 } = new MessageChannelMain();
            write({ t: "connect" }, [port1]);
            return port2;
          },
          stop: () =>
            new Promise<void>((done) => {
              stopping = true;
              if (child.pid === undefined) return done();
              const timer = setTimeout(() => {
                child.kill();
                killGroups(groups);
              }, 5000);
              child.once("exit", () => {
                clearTimeout(timer);
                done();
              });
              // SIGTERM lets the core stop its agents itself.
              try {
                process.kill(child.pid, "SIGTERM");
              } catch {
                child.kill();
              }
            }),
        });
        return;
      }
      if (frame.t === "groups") {
        groups = frame.pgids;
        return;
      }
      if (frame.t === "hreq") {
        const { id, op } = frame;
        options.handle(op).then(
          (value) => write({ t: "hres", id, ok: true, value: value ?? null }),
          (e: unknown) => write({ t: "hres", id, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
      }
    });
    child.once("exit", (code) => {
      // Whatever the core's agents were doing, they don't outlive it.
      killGroups(groups);
      groups = [];
      if (!ready) reject(new Error(`The core exited before it was ready (code ${code}).`));
      else if (!stopping) options.onExit(code);
    });
    write({ t: "hello", appVersion: options.appVersion, platform: process.platform });
  });
}
