/** Real local workerd + D1 + R2 check. No credentials, deployment, or remote calls. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { telemetrySignatureMessage, type TelemetryEnvelope } from "../../src/shared/telemetry.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const withConsole = process.argv.includes("--console");
const directory = await mkdtemp(path.join(tmpdir(), "phaethon-telemetry-smoke-"));
let dev: ChildProcess | undefined;
let browser: import("@playwright/test").Browser | undefined;
let appCore: import("../../e2e/core.ts").Core | undefined;
let output = "";
let passed = false;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
async function run(label: string, args: string[], input = "", expectedExit = 0): Promise<void> {
  const child = spawn(pnpm, args, { cwd: root, stdio: "pipe" });
  child.stdout?.on("data", chunk => { output += String(chunk); });
  child.stderr?.on("data", chunk => { output += String(chunk); });
  child.stdin?.end(input);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => code === expectedExit ? resolve() : reject(new Error(`${label} failed (exit ${code}); local logs: ${directory}`)));
  });
}
try {
  await run("local config", ["exec", "tsx", "telemetry/scripts/dev-config.ts", directory]);
  const configPath = path.join(directory, "wrangler.json");
  const state = path.join(directory, "state");
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No local port")); return; }
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
  const origin = `http://localhost:${port}`;
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.vars.CONSOLE_ORIGIN = origin;
  if (withConsole) {
    await access(path.join(root, "telemetry/console/dist/index.html"));
    await access(path.join(root, "dist/server/main.mjs"));
    config.assets.directory = path.join(root, "telemetry/console/dist");
  }
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await run("migrations", ["dlx", "wrangler@4.165.0", "d1", "migrations", "apply", "DB", "--local", "--config", configPath, "--persist-to", state], "y\n");
  const password = `${crypto.randomUUID()}-staff`;
  const staffArgs = ["--email", "local@example.test", "--config", configPath, "--persist-to", state];
  await run("provisioning", ["exec", "tsx", "telemetry/scripts/staff.ts", "provision", ...staffArgs, "--username", "local-staff", "--role", "owner"], `${password}\n`);
  dev = spawn(pnpm, ["dlx", "wrangler@4.165.0", "dev", "--config", configPath, "--persist-to", state, "--port", String(port), "--test-scheduled"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
  dev.stdout?.on("data", chunk => { output += String(chunk); });
  dev.stderr?.on("data", chunk => { output += String(chunk); });
  await writeFile(path.join(directory, "process.json"), JSON.stringify({ pid: dev.pid, port, directory }), { mode: 0o600 });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (dev.exitCode !== null) throw new Error(`Local Worker exited; logs: ${directory}`);
    try { if ((await fetch(`${origin}/api/session`)).status === 401) { ready = true; break; } } catch { /* startup */ }
    await delay(250);
  }
  assert(ready, "Local Worker did not become ready in 30 seconds");
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(body) });
  assert.equal((await post("/api/login", { email: "local-staff", password: "wrong" })).status, 401);
  const login = await post("/api/login", { email: "local-staff", password });
  assert.equal(login.status, 200, "workerd must support configured scrypt parameters");
  assert.deepEqual(await login.json(), { email: "local@example.test", role: "owner" });
  const Cookie = login.headers.get("Set-Cookie")!.split(";")[0];
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const e: TelemetryEnvelope = { v: 1, id: crypto.randomUUID(), sentAt: new Date().toISOString(), publicKey: Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64"),
    payload: JSON.stringify({ category: "usage", event: "app_opened", appVersion: "0.3.1", platform: "other", data: { count: 1 } }), signature: "" };
  e.signature = Buffer.from(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(telemetrySignatureMessage(e)))).toString("base64");
  const duplicates = await Promise.all(Array.from({ length: 5 }, () => post("/api/ingest", e)));
  assert(duplicates.every(response => [200, 201].includes(response.status)), `Concurrent ingestion: ${duplicates.map(response => response.status).join(",")}`);
  const receipts = await Promise.all(duplicates.map(response => response.json()));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal((await post("/api/ingest", { ...e, payload: e.payload + " " })).status, 400);
  const detail = await fetch(`${origin}/api/events/${e.id}`, { headers: { Cookie } });
  assert.equal(detail.status, 200); assert.equal((await detail.json() as { verification: string }).verification, "self-signed");
  const overview = await fetch(`${origin}/api/overview?days=7`, { headers: { Cookie } });
  assert.equal((await overview.json() as { totals: { usage: number } }).totals.usage, 1);
  const exported = await fetch(`${origin}/api/export?days=7`, { headers: { Cookie } });
  assert.equal(exported.status, 200); assert.equal(exported.headers.get("X-Result-Count"), "1");
  assert.equal((await post("/api/logout", {}, { Cookie, Origin: "https://evil.example" })).status, 403);
  if (withConsole) {
    const { chromium, expect } = await import("@playwright/test");
    const { startCore, openSettings } = await import("../../e2e/core.ts");
    const evidence = await mkdtemp(path.join(tmpdir(), "phaethon-telemetry-evidence-"));
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
    const consolePage = await context.newPage();
    await consolePage.goto(origin);
    await consolePage.getByLabel("Email", { exact: true }).fill("local@example.test");
    await consolePage.getByLabel("Password", { exact: true }).fill(password);
    await consolePage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(consolePage.getByRole("heading", { name: "Telemetry", exact: true })).toBeVisible();
    appCore = await startCore({ script: { claude: true, steps: [{ text: "Pipeline reply." }] }, env: { PHAETHON_TELEMETRY_ENDPOINT: `${origin}/api/ingest`, PHAETHON_TELEMETRY_ALLOW_LOCAL: "1" } });
    const appPage = await context.newPage();
    await appCore.open(appPage, { privacy: true });
    await appPage.getByRole("button", { name: "Save privacy choices" }).click();
    await appPage.getByRole("textbox", { name: "Message" }).fill("Pipeline prompt for person@example.test.");
    await appPage.keyboard.press("Enter");
    await expect(appPage.getByText("Pipeline reply.", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await fetch(`${origin}/api/events?category=traces`, { headers: { Cookie } });
      return (await response.json() as { items: unknown[] }).items.length;
    }, { timeout: 15_000 }).toBe(1);
    await consolePage.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(consolePage.getByRole("button", { name: "Chat trace", exact: true })).toBeVisible();
    await consolePage.getByRole("button", { name: "Chat trace", exact: true }).click();
    await expect(consolePage.getByRole("region", { name: "Event detail" })).toContainText("[redacted email]");
    await expect(consolePage.getByRole("region", { name: "Event detail" })).not.toContainText("person@example.test");
    await consolePage.screenshot({ path: path.join(evidence, "real-pipeline.png"), fullPage: true, animations: "disabled" });
    await openSettings(appPage, "Privacy");
    await appPage.getByRole("switch", { name: "Chat traces", exact: true }).uncheck();
    await expect(appPage.getByRole("switch", { name: "Chat traces", exact: true })).toBeEnabled();
    await appPage.keyboard.press("Escape");
    await appPage.getByRole("textbox", { name: "Message" }).fill("This prompt must not reach the collector.");
    await appPage.keyboard.press("Enter");
    await expect(appPage.getByRole("button", { name: "Send", exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await fetch(`${origin}/api/overview?days=7`, { headers: { Cookie } });
      return (await response.json() as { totals: { diagnostics: number } }).totals.diagnostics;
    }).toBe(2);
    const traceCount = await fetch(`${origin}/api/events?category=traces`, { headers: { Cookie } });
    assert.equal((await traceCount.json() as { items: unknown[] }).items.length, 1);
    await consolePage.getByRole("button", { name: "Staff", exact: true }).click();
    await expect(consolePage.getByRole("row").filter({ hasText: "local@example.test" })).toContainText("Super admin");
    await consolePage.getByRole("button", { name: "Add account", exact: true }).click();
    const editor = consolePage.getByRole("region", { name: "Account editor" });
    const viewerPassword = `${crypto.randomUUID()}-viewer`;
    await editor.getByLabel("Email", { exact: true }).fill("viewer@example.test");
    await editor.getByLabel("Username", { exact: true }).fill("viewer");
    await editor.getByLabel("Password", { exact: true }).fill(viewerPassword);
    await editor.getByRole("button", { name: "Save account" }).click();
    await expect(consolePage.getByRole("button", { name: "Manage viewer@example.test" })).toBeVisible();
    const viewerContext = await browser.newContext();
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(origin);
    await viewerPage.getByLabel("Email", { exact: true }).fill("viewer@example.test");
    await viewerPage.getByLabel("Password", { exact: true }).fill(viewerPassword);
    await viewerPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(viewerPage.getByRole("heading", { name: "Telemetry", exact: true })).toBeVisible();
    await expect(viewerPage.getByRole("button", { name: "Staff", exact: true })).toHaveCount(0);
    await consolePage.getByRole("button", { name: "Manage viewer@example.test" }).click();
    await editor.getByRole("switch", { name: "Allow sign-in" }).uncheck();
    await editor.getByRole("button", { name: "Save account" }).click();
    await expect(consolePage.getByRole("row").filter({ hasText: "viewer@example.test" })).toContainText("Disabled");
    await viewerPage.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(viewerPage.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await consolePage.screenshot({ path: path.join(evidence, "real-staff-access.png"), fullPage: true, animations: "disabled" });
    await consolePage.getByRole("button", { name: "Manage local@example.test" }).click();
    await editor.getByLabel("Role", { exact: true }).selectOption("viewer");
    const rejected = consolePage.waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes("/api/staff/"));
    await editor.getByRole("button", { name: "Save account" }).click();
    assert.equal((await rejected).status(), 409);
    await expect(consolePage.getByRole("alert")).toBeVisible();
    await consolePage.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(consolePage.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    process.stdout.write(`Real browser pipeline passed: app consent/signing/redaction, workerd/D1/R2, console login and traces, independent opt-out, staff creation, viewer permissions, revocation, last-super-admin protection, logout. Evidence: ${evidence}\n`);
  }
  await run("last-super-admin CLI disable", ["exec", "tsx", "telemetry/scripts/staff.ts", "disable", ...staffArgs], "", 1);
  await run("last-super-admin CLI demotion", ["exec", "tsx", "telemetry/scripts/staff.ts", "provision", ...staffArgs, "--username", "local-staff", "--role", "viewer"], `${password}\n`, 1);
  const preserved = await fetch(`${origin}/api/session`, { headers: { Cookie } });
  assert.equal(preserved.status, 200);
  assert.equal((await preserved.json() as { role: string }).role, "owner");
  await run("revocation", ["exec", "tsx", "telemetry/scripts/staff.ts", "revoke", ...staffArgs]);
  assert.equal((await fetch(`${origin}/api/session`, { headers: { Cookie } })).status, 401);
  assert.equal((await fetch(`${origin}/__scheduled`)).status, 200);
  assert.equal((await fetch(`${origin}/`)).status, 200);
  passed = true;
  process.stdout.write("Local workerd smoke passed: migrations, secure-stdin provisioning, scrypt login, unauthorized reads, Ed25519, concurrent idempotency, R2 receipts, raw read, overview/export, cross-origin rejection, CLI revocation, cron, assets.\n");
} finally {
  await browser?.close();
  await appCore?.stop();
  if (dev?.pid && dev.exitCode === null) {
    const stopped = new Promise<void>(resolve => dev!.once("exit", () => resolve()));
    if (process.platform === "win32") dev.kill("SIGTERM");
    else { try { process.kill(-dev.pid, "SIGTERM"); } catch { /* already stopped */ } }
    await Promise.race([stopped, delay(2000)]);
  }
  // Private logs may include local account details; never emit their contents.
  await writeFile(path.join(directory, "runtime.log"), output, { mode: 0o600 });
  if (passed) await rm(directory, { recursive: true, force: true });
}
