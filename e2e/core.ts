import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { expect, test as base, type Page } from "@playwright/test";

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

export async function startCore(options: { script?: object; setup?: (home: string) => void; env?: Record<string, string> } = {}): Promise<Core> {
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
      // "__HOME__" in a value stands for this core's throwaway home.
      ...Object.fromEntries(Object.entries(options.env ?? {}).map(([k, v]) => [k, v.replaceAll("__HOME__", home)])),
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
      // A Windows runner can run out of socket buffers (net::ERR_NO_BUFFER_SPACE) while the page loads its
      // scripts; the app then never starts ("Failed to fetch dynamically imported module"). That's the runner,
      // not Phaethon, so the page loads once more. An app that really fails to start fails the second time too.
      const shell = () => (opts.onboarding ? page.getByRole("heading", { level: 1 }).first() : page.getByRole("navigation").first());
      let onError: (e: Error) => void = () => {};
      const bootFailed = new Promise<"failed">((resolve) => {
        onError = (e) => {
          if (/Failed to fetch dynamically imported module|Importing a module script failed/.test(e.message)) resolve("failed");
        };
      });
      page.on("pageerror", onError);
      try {
        await page.goto(`${url}#token=${ready.token}`);
        const shown = shell().waitFor().then(() => "shown" as const);
        // Settled either way, so the loser of the race never surfaces as an unhandled rejection.
        shown.catch(() => {});
        const first = await Promise.race([shown, bootFailed]);
        if (first === "failed") {
          await page.reload();
          await shell().waitFor();
        }
      } finally {
        page.off("pageerror", onError);
      }
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
export { expect };

/** Shows space `name` from the switcher at the top of the sidebar. */
export async function switchSpace(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: /^Space: / }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).click();
  await expect(page.getByRole("button", { name: `Space: ${name}` })).toBeVisible();
}

/** Opens the New space dialog from the switcher's menu. */
export async function openNewSpace(page: Page): Promise<void> {
  await page.getByRole("button", { name: /^Space: / }).click();
  await page.getByRole("menuitem", { name: "New space" }).click();
}

/** Opens Settings from the sidebar and goes to `section` (Settings isn't a tab). */
export async function openSettings(page: Page, section: string): Promise<void> {
  await page.locator("[aria-keyshortcuts]").filter({ hasText: /^Settings/ }).first().click();
  // A section's row may carry a count or a status dot after its name ("Spaces 3").
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: new RegExp(`^${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`) }).click();
}
