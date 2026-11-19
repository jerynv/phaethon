import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanData, collectorEndpoint, OFF, signedEnvelope, TelemetryClient, type Category, type Choices, type Envelope, type Payload } from "./client.ts";
import { redactText } from "./redact.ts";
import { recordTurn, turnConsent } from "./turn.ts";

const ALL: Choices = { usage: true, diagnostics: true, reports: true, traces: true };
const data: Record<Category, { event: string; data: object }> = {
  usage: { event: "view_opened", data: { view: "chat" } },
  diagnostics: { event: "turn_completed", data: { backend: "phaethon", outcome: "completed", durationMs: 20, steps: 1 } },
  reports: { event: "testing_report", data: { text: "A report" } },
  traces: { event: "chat_trace", data: { backend: "codex-cli", messages: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }] } },
};
let dir: string;
let file: string;
const clients: TelemetryClient[] = [];
const received: Envelope[] = [];
let request: ReturnType<typeof vi.fn<typeof fetch>>;
function client(overrides: ConstructorParameters<typeof TelemetryClient>[0] = {}) {
  const c = new TelemetryClient({ file: () => file, endpoint: () => "https://collector.example/ingest", fetch: request, retryMs: [10, 20], ...overrides });
  clients.push(c); return c;
}
function capture(c: TelemetryClient, category: Category) { return c.capture(category, data[category].event, data[category].data); }
const waitCalls = (n: number) => vi.waitFor(() => expect(request).toHaveBeenCalledTimes(n));
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-telemetry-")); file = path.join(dir, "appdata", "telemetry-consent.json");
  received.length = 0;
  request = vi.fn<typeof fetch>(async (_url, init) => { received.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); });
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("telemetry consent and transport", () => {
  it("drops events without saved consent, all off, or a configured endpoint; never backfills them", async () => {
    const c = client();
    for (const category of Object.keys(data) as Category[]) expect(capture(c, category)).toBe(false);
    c.save(OFF);
    for (const category of Object.keys(data) as Category[]) expect(capture(c, category)).toBe(false);
    c.save(ALL);
    expect(capture(client({ endpoint: () => null }), "usage")).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(request).not.toHaveBeenCalled();
    expect(capture(c, "usage")).toBe(true);
    await waitCalls(1);
  });

  it.each(Object.keys(data) as Category[])("%s is independently enabled, persisted outside the vault, and survives restart", async (category) => {
    const c = client(); c.save({ ...OFF, [category]: true });
    const restarted = client();
    expect(restarted.consent()).toEqual({ ...OFF, [category]: true, configured: true });
    for (const other of Object.keys(data) as Category[]) expect(capture(restarted, other)).toBe(other === category);
    await waitCalls(1);
    expect(JSON.parse(received[0]!.payload).category).toBe(category);
    expect(fs.readdirSync(dir)).toEqual(["appdata"]);
  });

  it("aborts an active category and discards its queued events on revocation; other categories still send", async () => {
    let aborted = false;
    request.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    }));
    const c = client(); c.save(ALL);
    capture(c, "traces"); capture(c, "traces"); capture(c, "diagnostics");
    await waitCalls(1);
    c.save({ ...ALL, traces: false });
    expect(aborted).toBe(true);
    c.save(ALL);
    await waitCalls(2);
    await new Promise((r) => setTimeout(r, 60));
    expect(request).toHaveBeenCalledTimes(2);
    expect(received.map((e) => JSON.parse(e.payload).category)).toEqual(["diagnostics"]);
  });

  it("bounds retries, retries transient failures, and never retries a permanent rejection", async () => {
    request.mockResolvedValue(new Response(null, { status: 503 }));
    const c = client(); c.save(ALL); capture(c, "usage");
    await waitCalls(3);
    await new Promise((r) => setTimeout(r, 60));
    expect(request).toHaveBeenCalledTimes(3);
    request.mockResolvedValue(new Response(null, { status: 400 })); capture(c, "reports");
    await waitCalls(4);
    await new Promise((r) => setTimeout(r, 60)); expect(request).toHaveBeenCalledTimes(4);
  });

  it("reuses the exact signed envelope if accepted delivery loses its response", async () => {
    const accepted: Envelope[] = [];
    request.mockImplementation(async (_url, init) => {
      accepted.push(JSON.parse(String(init?.body)));
      if (accepted.length === 1) throw new TypeError("connection closed after acceptance");
      return new Response(null, { status: 204 });
    });
    const c = client(); c.save(ALL); capture(c, "reports");
    await waitCalls(2);
    expect(accepted).toHaveLength(2);
    expect(accepted[1]).toEqual(accepted[0]);
  });

  it("clears delayed retries when disabled, even if immediately re-enabled", async () => {
    request.mockResolvedValue(new Response(null, { status: 429 }));
    const c = client({ retryMs: [100] }); c.save(ALL); capture(c, "reports");
    await waitCalls(1);
    c.save({ ...ALL, reports: false }); c.save(ALL);
    await new Promise((r) => setTimeout(r, 150)); expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed preferences, including corruption during a request", async () => {
    const c = client(); c.save(ALL);
    let aborted = false;
    request.mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); }, { once: true });
    }));
    capture(c, "usage"); await waitCalls(1);
    fs.writeFileSync(file, "{");
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(c.consent()).toEqual({ ...OFF, configured: false });
    for (const invalid of [{ v: 1, configured: true, usage: true }, { v: 1, configured: true, ...ALL, traces: "yes" }, { v: 2, configured: true, ...ALL }]) {
      fs.writeFileSync(file, JSON.stringify(invalid)); expect(capture(c, "usage")).toBe(false);
    }
    c.save(ALL); await new Promise((r) => setTimeout(r, 40)); expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete choices and pauses collection after a disk save failure", () => {
    const c = client(); c.save(ALL);
    expect(() => c.save({ usage: true })).toThrow();
    fs.unlinkSync(file); fs.mkdirSync(file);
    expect(() => c.save(OFF)).toThrow("Collection is paused");
    expect(c.consent()).toEqual({ ...OFF, configured: false });
    expect(capture(c, "usage")).toBe(false);
  });

  it("bounds the memory queue and discards it on process shutdown", async () => {
    const c = client(); c.save(ALL);
    for (let i = 0; i < 64; i++) expect(capture(c, "usage")).toBe(true);
    expect(capture(c, "usage")).toBe(false);
    c.close();
    const restarted = client(); expect(restarted.consent().usage).toBe(true);
    await new Promise((r) => setTimeout(r, 30)); expect(request).not.toHaveBeenCalled();
    const huge = { backend: "phaethon", messages: Array.from({ length: 20 }, () => ({ role: "user", text: "a".repeat(8000) })) };
    expect(restarted.capture("traces", "chat_trace", huge)).toBe(true);
    expect(restarted.capture("traces", "chat_trace", huge)).toBe(true);
    expect(restarted.capture("traces", "chat_trace", huge)).toBe(true);
    expect(restarted.capture("traces", "chat_trace", huge)).toBe(false);
  });
});

it("signs the exact envelope bytes with a fresh, verifiable Ed25519 public key per event", async () => {
  const c = client(); c.save(ALL); capture(c, "usage"); capture(c, "usage"); await waitCalls(2);
  expect(received[0]!.publicKey).not.toBe(received[1]!.publicKey);
  for (const e of received) {
    expect(Object.keys(e).sort()).toEqual(["id", "payload", "publicKey", "sentAt", "signature", "v"]);
    expect(e.v).toBe(1); expect(e.id).toMatch(/^[0-9a-f-]{36}$/); expect(new Date(e.sentAt).toISOString()).toBe(e.sentAt);
    const key = createPublicKey({ key: Buffer.from(e.publicKey, "base64"), format: "der", type: "spki" });
    const bytes = Buffer.from(`phaethon.telemetry.v1\n${e.id}\n${e.sentAt}\n${e.payload}`, "utf8");
    expect(verify(null, bytes, key, Buffer.from(e.signature, "base64"))).toBe(true);
    expect(verify(null, Buffer.concat([bytes, Buffer.from("!")]), key, Buffer.from(e.signature, "base64"))).toBe(false);
    expect(JSON.parse(e.payload)).toMatchObject({ category: "usage", appVersion: "0.0.0-dev", data: { view: "chat" } });
  }
  const e = await signedEnvelope({ category: "reports", event: "testing_report", appVersion: "1.0.0", platform: "other", data: { text: "日本語" } });
  expect(e.payload).toContain("日本語");
});

it("accepts only allow-listed usage/diagnostic values and text payload bounds", () => {
  for (const forbidden of [{ path: "/Users/Jane/file" }, { name: "Jane" }, { course: "CS101" }, { model: "https://private" }, { apiKey: "secret" }]) {
    expect(cleanData("usage", "view_opened", { view: "chat", ...forbidden })).toBeNull();
    expect(cleanData("diagnostics", "turn_completed", { ...data.diagnostics.data, ...forbidden })).toBeNull();
  }
  expect(cleanData("usage", "view_opened", { view: "Jane" })).toBeNull();
  expect(cleanData("usage", "view_opened", { view: ["chat"] })).toBeNull();
  expect(cleanData("diagnostics", "turn_completed", { ...data.diagnostics.data, backend: ["phaethon"] })).toBeNull();
  expect(cleanData("usage", "action_completed", { action: "search_used", count: 1.5 })).toBeNull();
  expect(cleanData("diagnostics", "turn_completed", { ...data.diagnostics.data, backend: "custom" })).toBeNull();
  expect(cleanData("reports", "testing_report", { text: "x".repeat(4001) })).toBeNull();
  expect(cleanData("traces", "chat_trace", { backend: "phaethon", messages: [{ role: "system", text: "secret" }] })).toBeNull();
});

it("requires an explicit secure collector and restricts test/dev traffic to explicitly enabled loopback", () => {
  vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", ""); expect(collectorEndpoint()).toBeNull();
  vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", "https://collector.example/ingest"); expect(collectorEndpoint()).toBeNull();
  vi.stubEnv("PHAETHON_TEST", "0"); vi.stubEnv("PHAETHON_PACKAGED", "1"); expect(collectorEndpoint()).toBe("https://collector.example/ingest");
  for (const url of ["http://collector.example/ingest", "https://u:p@collector.example", "https://collector.example?key=secret", "file:///tmp/data"]) {
    vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", url); expect(collectorEndpoint()).toBeNull();
  }
  vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", "http://127.0.0.1:1234/ingest"); expect(collectorEndpoint()).toBeNull();
  vi.stubEnv("PHAETHON_TELEMETRY_ALLOW_LOCAL", "1"); expect(collectorEndpoint()).toBe("http://127.0.0.1:1234/ingest");
  vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", "http://collector.example"); expect(collectorEndpoint()).toBeNull();
});

it("redacts common secrets, identifiers, URLs, private keys, and home paths locally", () => {
  const raw = 'Jane@example.com /Users/Jane/Documents/test.txt /home/jane/a C:\\Users\\Jane\\secret.txt ~/notes token=abc123 password: "hunter2" Bearer eyJsecret sk-proj-123456789abcdef ghp_123456789012345 https://private.example/model -----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----';
  const redacted = redactText(raw);
  for (const secret of ["Jane@example", "Jane", "/home/jane", "~/notes", "abc123", "hunter2", "eyJsecret", "sk-proj", "ghp_", "private.example", "ABC"]) expect(redacted).not.toContain(secret);
  expect(redactText(redacted)).toBe(redacted);
  expect(redactText("hello", 3)).toBe("hel");
  expect(redactText("Alice studies biology")).toBe("Alice studies biology"); // Cannot promise anonymity.
});

it("requires trace consent at both turn boundaries and never includes tools, reasoning, or history", async () => {
  const c = client(); c.save(ALL);
  const consent = turnConsent(c);
  const turn = recordTurn("codex-cli", "email me jane@example.com", consent, c);
  turn.event({ kind: "tool", label: "secret tool result" });
  turn.event({ kind: "thinking", delta: "secret system reasoning" });
  turn.event({ kind: "text", delta: "Hello /Users/Jane/private" });
  turn.finish(false);
  await waitCalls(2);
  const trace = JSON.parse(received.find((e) => JSON.parse(e.payload).category === "traces")!.payload) as Payload;
  expect(trace.data).toEqual({ backend: "codex-cli", messages: [{ role: "user", text: "email me [redacted email]" }, { role: "assistant", text: "Hello [redacted path]" }] });
  const revoked = recordTurn("phaethon", "new prompt", turnConsent(c), c);
  revoked.event({ kind: "text", delta: "Do not send me" });
  c.save({ ...ALL, traces: false }); c.save(ALL); revoked.finish(false);
  const disabledStart = client(); disabledStart.save({ ...ALL, traces: false });
  const later = recordTurn("claude-cli", "no consent at start", turnConsent(disabledStart), disabledStart);
  disabledStart.save(ALL); later.event({ kind: "text", delta: "also private" }); later.finish(false);
  await waitCalls(4);
  expect(received.filter((e) => JSON.parse(e.payload).category === "traces")).toHaveLength(1);
});

it("never collects a trace from a failed or cancelled turn", async () => {
  const c = client(); c.save(ALL);
  for (const kind of ["failed", "cancelled"] as const) {
    const turn = recordTurn("gemini-cli", "prompt", turnConsent(c), c);
    turn.event({ kind: "text", delta: "partial response" });
    if (kind === "failed") turn.event({ kind: "error", code: "network", message: "private error" });
    turn.finish(kind === "cancelled");
  }
  await waitCalls(2);
  expect(received.map((e) => JSON.parse(e.payload).data.outcome)).toEqual(["failed", "cancelled"]);
});
