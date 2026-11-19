import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { call, channel, tempHome } from "../../../tests/harness.ts";
import type { AgentEvent } from "../../shared/agent.ts";
import { ensureVault } from "../core/vault.ts";
import { load, save } from "../core/thread.ts";
import { updateSettings } from "../settings/settings.ts";
import { resetFake } from "../providers/fake.ts";
import { fakeBin, setup } from "../cli/__tests__/helpers.ts";
import { telemetry, type Envelope, type Payload } from "./client.ts";
import "../commands.ts";

const env = tempHome("phaethon-telemetry-flow-");
const received: Payload[] = [];
let collector: http.Server;
const choices = { usage: true, diagnostics: true, reports: true, traces: true };

beforeAll(async () => {
  ensureVault();
  collector = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const envelope = JSON.parse(body) as Envelope;
      const publicKey = createPublicKey({ key: Buffer.from(envelope.publicKey, "base64"), type: "spki", format: "der" });
      const valid = verify(null, Buffer.from(`phaethon.telemetry.v1\n${envelope.id}\n${envelope.sentAt}\n${envelope.payload}`), publicKey, Buffer.from(envelope.signature, "base64"));
      if (!valid) { response.writeHead(400).end(); return; }
      received.push(JSON.parse(envelope.payload));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
  process.env.PHAETHON_TELEMETRY_ENDPOINT = `http://127.0.0.1:${(collector.address() as { port: number }).port}/ingest`;
  process.env.PHAETHON_TELEMETRY_ALLOW_LOCAL = "1";
});
afterAll(async () => {
  telemetry.close();
  collector.closeAllConnections();
  await new Promise<void>((resolve) => collector.close(() => resolve()));
  delete process.env.PHAETHON_TELEMETRY_ENDPOINT;
  delete process.env.PHAETHON_TELEMETRY_ALLOW_LOCAL;
  delete process.env.PHAETHON_FAKE_PROVIDER;
  delete process.env.PHAETHON_CODEX_BIN;
  env.cleanup();
});

it("exercises saved choices, report preview and send, and actual built-in and coding-agent turn dispatch", async () => {
  const script = path.join(env.home, "provider.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [{ text: "Reply to jane@example.com" }] }));
  process.env.PHAETHON_FAKE_PROVIDER = script;
  expect(await call("telemetry_get")).toMatchObject({ configured: false, usage: false, traces: false, collectorConfigured: true });
  expect(await call("telemetry_usage", { event: "view_opened", data: { view: "chat" } })).toBe(false);
  const beforeConsent = channel<AgentEvent>();
  await call("agent_send", { space: "school", thread: "1001", prompt: "private first turn", onEvent: beforeConsent });
  expect(beforeConsent.messages.some((e) => e.kind === "error")).toBe(false);
  expect(received).toEqual([]);
  await expect(call("telemetry_set", { choices: { usage: true } })).rejects.toThrow("each privacy setting");
  await call("telemetry_set", { choices });
  const preview = await call<string>("telemetry_report_preview", { text: "Write to jane@example.com about /Users/Jane/notes" });
  expect(preview).toBe("Write to [redacted email] about [redacted path]");
  await call("telemetry_report_send", { text: preview });
  resetFake();
  // Older transcript content is deliberately sensitive and must never be uploaded.
  const old = load("school", "1001");
  old[0]!.content = [{ type: "text", text: "HISTORICAL PRIVATE TEXT" }]; save("school", "1001", old);
  const ownEvents = channel<AgentEvent>();
  await call("agent_send", { space: "school", thread: "1001", prompt: "New prompt /home/jane/private", onEvent: ownEvents });
  expect(ownEvents.messages.some((e) => e.kind === "error")).toBe(false);
  delete process.env.PHAETHON_FAKE_PROVIDER;
  setup(env.home, "codex");
  process.env.PHAETHON_CODEX_BIN = fakeBin(path.join(env.home, "bin"), "codex");
  updateSettings({ backend: "codex-cli" });
  const cliEvents = channel<AgentEvent>();
  await call("agent_send", { space: "school", thread: "1002", prompt: "tools please", onEvent: cliEvents });
  expect(cliEvents.messages.filter((e) => e.kind === "error")).toEqual([]);
  await vi.waitFor(() => expect(received.filter((p) => p.category === "traces")).toHaveLength(2));
  expect(received.filter((p) => p.category === "diagnostics").map((p) => p.data)).toEqual([
    expect.objectContaining({ backend: "phaethon", outcome: "completed" }),
    expect.objectContaining({ backend: "codex-cli", outcome: "completed" }),
  ]);
  expect(received.filter((p) => p.category === "reports")).toEqual([expect.objectContaining({ data: { text: preview } })]);
  const traces = received.filter((p) => p.category === "traces");
  expect(traces[0]!.data).toEqual({ backend: "phaethon", messages: [{ role: "user", text: "New prompt [redacted path]" }, { role: "assistant", text: "Reply to [redacted email]" }] });
  expect(JSON.stringify(traces)).not.toContain("HISTORICAL PRIVATE TEXT");
  expect(JSON.stringify(traces)).not.toContain("jane@example.com");
  const count = received.length;
  await call("telemetry_set", { choices: { usage: false, diagnostics: false, reports: false, traces: false } });
  await expect(call("telemetry_report_send", { text: "disabled" })).rejects.toThrow("couldn’t be queued");
  expect(await call("telemetry_usage", { event: "view_opened", data: { view: "settings" } })).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(received).toHaveLength(count);
});
