import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import type { Duplex } from "node:stream";
import type { CoreToHost, HostEventBody, HostOp, HostToCore } from "../shared/host.ts";

/**
 * Starts the Node core as a child of the desktop shell, using Electron's own
 * binary in Node mode. The token goes over fd 3 (never argv or env), and the
 * core answers with the port it bound. Only this one PID is ever signalled.
 */
export type CoreProcess = {
  port: number;
  token: string;
  child: ChildProcess;
  emit(event: HostEventBody): void;
  stop(): Promise<void>;
};

export function startCore(options: {
  entry: string;
  origins: string[];
  appVersion: string;
  handle: (op: HostOp) => Promise<unknown>;
  onExit: (code: number | null) => void;
}): Promise<CoreProcess> {
  const token = randomBytes(32).toString("hex");
  const child = spawn(process.execPath, [options.entry], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PHAETHON_HOST_FD: "3" },
    stdio: ["ignore", "inherit", "inherit", "pipe"],
    windowsHide: true,
  });
  const pipe = child.stdio[3] as Duplex;
  const write = (frame: HostToCore) => pipe.write(JSON.stringify(frame) + "\n");

  return new Promise((resolve, reject) => {
    let ready = false;
    const lines = createInterface({ input: pipe });
    lines.on("line", (text) => {
      let frame: CoreToHost;
      try {
        frame = JSON.parse(text) as CoreToHost;
      } catch {
        return;
      }
      if (frame.t === "ready" && !ready) {
        ready = true;
        resolve({
          port: frame.port,
          token,
          child,
          emit: (event) => write({ t: "hevt", event }),
          stop: () => stopChild(child),
        });
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
      if (!ready) reject(new Error(`The core exited before it was ready (code ${code}).`));
      options.onExit(code);
    });
    write({ t: "hello", token, origins: options.origins, appVersion: options.appVersion, platform: process.platform });
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
