import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test as base, type Page } from "@playwright/test";

/**
 * Starts the real core on a throwaway home folder, serving the built UI, with
 * an optional fake-provider script. Each test gets its own core.
 */
export type Core = {
  home: string;
  url: string;
  /** Opens the app in `page` and waits for the shell (first-run setup skipped unless `onboarding`). */
  open(page: Page, options?: { onboarding?: boolean }): Promise<void>;
  /** Requests the fake provider received (system prompt, effort, tools). */
  requests(): Array<Record<string, unknown>>;
  /** What the core wrote to stderr. */
  log(): string;
  stop(): Promise<void>;
};

const root = path.resolve(import.meta.dirname, "..");

export async function startCore(options: { script?: object; setup?: (home: string) => void } = {}): Promise<Core> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-e2e-"));
  let scriptFile: string | undefined;
  if (options.script) {
    scriptFile = path.join(home, "fake-script.json");
    fs.writeFileSync(scriptFile, JSON.stringify(options.script));
  }
  options.setup?.(home);
  const child: ChildProcess = spawn(process.execPath, [path.join(root, "dist/server/main.mjs")], {
    env: {
      ...process.env,
      PHAETHON_HOME: home,
      PHAETHON_APP_DATA: path.join(home, "appdata"),
      PHAETHON_KEYRING: "memory",
      PHAETHON_WEB_ROOT: path.join(root, "dist/web"),
      ...(scriptFile ? { PHAETHON_FAKE_PROVIDER: scriptFile } : {}),
      // Never touch the CLIs installed on this machine: point each at a path that doesn't exist.
      PHAETHON_TEST: "1",
      PHAETHON_CLAUDE_BIN: path.join(home, "no-claude"),
      PHAETHON_CODEX_BIN: path.join(home, "no-codex"),
      PHAETHON_GEMINI_BIN: path.join(home, "no-gemini"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stderr!.on("data", (d) => (log += String(d)));
  const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.t === "ready") resolve(frame);
      } catch {
        // not ours
      }
    });
    child.once("exit", (code) => reject(new Error(`core exited (${code}):\n${log}`)));
  });
  const url = `http://127.0.0.1:${ready.port}/`;
  return {
    home,
    url,
    async open(page, opts = {}) {
      if (!opts.onboarding) await page.addInitScript(() => localStorage.setItem("phaethon.onboarded", "1"));
      await page.goto(`${url}#token=${ready.token}`);
      if (opts.onboarding) await page.getByRole("heading", { level: 1 }).first().waitFor();
      else await page.getByRole("navigation").first().waitFor();
    },
    requests() {
      if (!scriptFile || !fs.existsSync(`${scriptFile}.requests.jsonl`)) return [];
      return fs.readFileSync(`${scriptFile}.requests.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    log: () => log,
    async stop() {
      if (process.env.E2E_CORE_LOG) process.stderr.write(log);
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((r) => child.once("exit", r));
      }
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

export const test = base;
export { expect } from "@playwright/test";
