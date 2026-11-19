import { createServer, type Server } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, openSettings, startCore, test, type Core } from "./core";

type Captured = { category: string; event: string; data: { text?: string; messages?: { role: string; text: string }[] } };
let core: Core | undefined;
let collector: Server | undefined;
test.afterEach(async () => {
  await core?.stop(); core = undefined;
  if (collector) { collector.closeAllConnections(); await new Promise<void>((resolve) => collector!.close(() => resolve())); collector = undefined; }
});

async function capture() {
  const events: Captured[] = [];
  const failures: string[] = [];
  collector = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const envelope = JSON.parse(Buffer.concat(chunks).toString());
      const bytes = Buffer.from(`phaethon.telemetry.v1\n${envelope.id}\n${envelope.sentAt}\n${envelope.payload}`);
      const publicKey = createPublicKey({ format: "der", type: "spki", key: Buffer.from(envelope.publicKey, "base64") });
      if (!verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64"))) throw new Error("Invalid signature");
      events.push(JSON.parse(envelope.payload));
      res.writeHead(202).end();
    } catch { failures.push("Malformed or unsigned telemetry"); res.writeHead(400).end(); }
  });
  await new Promise<void>((resolve) => collector!.listen(0, "127.0.0.1", resolve));
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("No collector port");
  return { events, failures, env: { PHAETHON_TELEMETRY_ENDPOINT: `http://127.0.0.1:${address.port}/api/ingest`, PHAETHON_TELEMETRY_ALLOW_LOCAL: "1" } };
}

test("saved choices govern signed new-turn traces, reports, and independent opt-outs", async ({ page }, testInfo) => {
  const received = await capture();
  core = await startCore({ script: { claude: true, steps: [{ text: "A safe reply." }] }, env: received.env });
  await core.open(page, { privacy: true });
  await expect(page.getByRole("heading", { name: "Your privacy choices", exact: true })).toBeVisible();
  for (const label of ["Anonymous usage", "Diagnostics", "Testing reports", "Chat traces"]) await expect(page.getByRole("switch", { name: label, exact: true })).toBeChecked();
  expect(received.events).toHaveLength(0);
  await page.screenshot({ path: testInfo.outputPath("consent.png"), fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Save privacy choices" }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Help me study. Email tester@example.test and use /Users/tester/private/course.txt.");
  await page.keyboard.press("Enter");
  await expect(page.getByText("A safe reply.", { exact: true })).toBeVisible();
  await expect.poll(() => received.events.filter((e) => e.category === "traces").length).toBe(1);
  await expect.poll(() => received.events.some((e) => e.category === "diagnostics")).toBe(true);
  const trace = received.events.find((e) => e.category === "traces")!;
  expect(trace.data.messages?.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(JSON.stringify(trace)).not.toContain("tester@example.test");
  expect(JSON.stringify(trace)).not.toContain("/Users/tester");
  await openSettings(page, "Privacy");
  await page.getByLabel("What happened?", { exact: true }).fill("A test report from tester@example.test.");
  await page.getByRole("button", { name: "Preview redacted report" }).click();
  await expect(page.getByLabel("Review the text to send", { exact: true })).not.toHaveValue(/tester@example/);
  await page.getByRole("button", { name: "Send report", exact: true }).click();
  await expect.poll(() => received.events.filter((e) => e.category === "reports").length).toBe(1);
  await page.getByRole("switch", { name: "Chat traces", exact: true }).uncheck();
  await expect(page.getByRole("switch", { name: "Chat traces", exact: true })).toBeEnabled();
  await expect(page.getByRole("switch", { name: "Chat traces", exact: true })).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("privacy.png"), fullPage: true, animations: "disabled" });
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill("This turn must have diagnostics without a trace.");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect.poll(() => received.events.filter((e) => e.category === "diagnostics").length).toBe(2);
  expect(received.events.filter((e) => e.category === "traces")).toHaveLength(1);
  await openSettings(page, "Privacy");
  for (const label of ["Anonymous usage", "Diagnostics", "Testing reports"]) {
    await page.getByRole("switch", { name: label, exact: true }).uncheck();
    await expect(page.getByRole("switch", { name: label, exact: true })).toBeEnabled();
  }
  const choices = JSON.parse(fs.readFileSync(path.join(core.home, "appdata", "telemetry-consent.json"), "utf8"));
  expect(choices).toMatchObject({ usage: false, diagnostics: false, reports: false, traces: false });
  const count = received.events.length;
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill("All sharing is disabled.");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  expect(received.events).toHaveLength(count);
  expect(received.failures).toEqual([]);
  await openSettings(page, "Privacy");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await expect(page.getByRole("switch", { name: "Anonymous usage", exact: true })).not.toBeChecked();
  await page.getByRole("switch", { name: "Chat traces", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("privacy-mobile-dark.png"), fullPage: true, animations: "disabled" });
});

test("declining every category at the initial gate persists across reload", async ({ page }) => {
  const received = await capture();
  core = await startCore({ env: received.env });
  await core.open(page, { privacy: true });
  for (const label of ["Anonymous usage", "Diagnostics", "Testing reports", "Chat traces"]) await page.getByRole("switch", { name: label, exact: true }).uncheck();
  await page.getByRole("button", { name: "Save privacy choices" }).click();
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
  expect(received.events).toEqual([]);
});
