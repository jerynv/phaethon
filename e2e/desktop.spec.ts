import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { _electron as electron, expect, test } from "@playwright/test";

// Unlike an offscreen capture, this checks the normal ready-to-show path.
test("the desktop window becomes visible and connects to its core", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-desktop-e2e-"));
  const root = path.resolve(import.meta.dirname, "..");
  // Embedded Node hosts may set this for their own subprocesses. The app
  // launches here must run Electron's desktop runtime on both starts.
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  // Match Playwright's sandbox setting on both launches; Xvfb also needs software rendering.
  const args = [...(process.platform === "linux" ? ["--no-sandbox", "--disable-gpu"] : []), root, `--user-data-dir=${path.join(home, "profile")}`];
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    app = await electron.launch({
      args,
      env: {
        ...electronEnv,
        PHAETHON_HOME: home,
        PHAETHON_APP_DATA: path.join(home, "appdata"),
        PHAETHON_TEST: "1",
        PHAETHON_KEYRING: "memory",
        PHAETHON_CLAUDE_BIN: path.join(home, "no-claude"),
        PHAETHON_CODEX_BIN: path.join(home, "no-codex"),
        PHAETHON_GEMINI_BIN: path.join(home, "no-gemini"),
      },
    });
    const page = await app.firstWindow();
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()), { timeout: 20_000 }).toBe(true);
    await expect(page.getByRole("heading", { name: "Welcome to Phaethon" })).toBeVisible();
    expect(await page.evaluate(async () => (await fetch("app://phaethon/%ZZ")).status)).toBe(400);
    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "app://phaethon/index.html?navigation-check=1";
      document.body.append(link);
      link.click();
    });
    await expect(page).toHaveURL(/\?navigation-check=1$/, { timeout: 3000 });
    await expect(page.getByRole("heading", { name: "Welcome to Phaethon" })).toBeVisible();
    await page.getByRole("button", { name: "Get started" }).click();
    await expect(page.getByRole("heading", { name: "How should Phaethon answer?" })).toBeVisible();
    // The last step lists the vault's spaces, read from the core over the port.
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(page.getByRole("heading", { name: "Your spaces" })).toBeVisible();
    await expect(page.getByText("School", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Work", { exact: true }).first()).toBeVisible();

    // Relaunching an already-running hidden app must bring its window back.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    // Playwright's ChildProcess may be a cmd.exe wrapper on Windows.
    const executable = await app.evaluate(() => process.execPath);
    const second = spawn(executable, args, {
      env: { ...electronEnv, PHAETHON_HOME: home, PHAETHON_APP_DATA: path.join(home, "appdata"), PHAETHON_TEST: "1", PHAETHON_KEYRING: "memory" },
      stdio: ["ignore", "ignore", "pipe"], windowsHide: true, timeout: 10_000,
    });
    let secondStderr = "";
    second.stderr!.on("data", (chunk: Buffer) => { secondStderr = (secondStderr + chunk.toString()).slice(-16_000); });
    const secondExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      second.once("exit", (code, signal) => resolve({ code, signal }));
      second.once("error", reject);
    });
    expect(secondExit, secondStderr).toEqual({ code: 0, signal: null });
    await expect.poll(() => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()), { timeout: 5000 }).toBe(true);
  } catch (error) {
    if (app) {
      const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), url: w.webContents.getURL(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed() }))).catch(() => []);
      await test.info().attach("desktop-startup", { body: JSON.stringify(windows), contentType: "application/json" });
    }
    throw error;
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
