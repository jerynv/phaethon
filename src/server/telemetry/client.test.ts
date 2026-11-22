import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  telemetrySignatureMessage,
  type TelemetryCategory,
  type TelemetryChoices,
  type TelemetryEnvelope,
} from "../../shared/telemetry.ts";
import { collectorEndpoint, OFF, signedEnvelope, TelemetryClient } from "./client.ts";
import { redactText } from "./redact.ts";
import { recordTurn } from "./turn.ts";

const ALL: TelemetryChoices = { usage: true, diagnostics: true, reports: true, traces: true };
const CATEGORIES = Object.keys(ALL) as TelemetryCategory[];
const SAMPLE: Record<TelemetryCategory, { event: string; data: object }> = {
  usage: { event: "view_opened", data: { view: "chat" } },
  diagnostics: { event: "turn_completed", data: { backend: "phaethon", outcome: "completed", durationMs: 20, steps: 1 } },
  reports: { event: "testing_report", data: { text: "A report" } },
  traces: {
    event: "chat_trace",
    data: { backend: "codex-cli", messages: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi" }] },
  },
};

let dir: string;
let file: string;
let request: ReturnType<typeof vi.fn<typeof fetch>>;
const received: TelemetryEnvelope[] = [];
const clients: TelemetryClient[] = [];

function client(overrides: ConstructorParameters<typeof TelemetryClient>[0] = {}) {
  const c = new TelemetryClient({
    file: () => file,
    endpoint: () => "https://collector.example/ingest",
    fetch: request,
    retryMs: [10, 20],
    ...overrides,
  });
  clients.push(c);
  return c;
}
const capture = (c: TelemetryClient, category: TelemetryCategory) =>
  c.capture(category, SAMPLE[category].event, SAMPLE[category].data);
const categoryOf = (e: TelemetryEnvelope) => JSON.parse(e.payload).category as TelemetryCategory;
const sent = (n: number) => vi.waitFor(() => expect(request).toHaveBeenCalledTimes(n));
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request that hangs until aborted, reporting the abort. */
function hangUntilAborted(onAbort: () => void) {
  return async (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => (onAbort(), reject(new Error("aborted"))), { once: true });
    });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-telemetry-"));
  file = path.join(dir, "appdata", "telemetry-consent.json");
  received.length = 0;
  request = vi.fn<typeof fetch>(async (_url, init) => {
    received.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 204 });
  });
});

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("consent", () => {
  it("sends nothing before choices are saved, when all are off, or without a collector", async () => {
    const c = client();
    for (const category of CATEGORIES) expect(capture(c, category)).toBe(false);
    c.save(OFF);
    for (const category of CATEGORIES) expect(capture(c, category)).toBe(false);
    c.save(ALL);
    expect(capture(client({ endpoint: () => null }), "usage")).toBe(false);
    await settle(30);
    expect(request).not.toHaveBeenCalled();
    expect(capture(c, "usage")).toBe(true);
    await sent(1);
  });

  it.each(CATEGORIES)("%s can be enabled on its own, and that survives a restart", async (category) => {
    client().save({ ...OFF, [category]: true });
    const restarted = client();
    expect(restarted.consent()).toEqual({ ...OFF, [category]: true, configured: true });
    for (const other of CATEGORIES) expect(capture(restarted, other)).toBe(other === category);
    await sent(1);
    expect(categoryOf(received[0]!)).toBe(category);
    expect(fs.readdirSync(dir)).toEqual(["appdata"]);
  });

  it("treats a malformed choices file as no choice made", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const contents of [
      "{",
      JSON.stringify({ v: 1, configured: true, usage: true }),
      JSON.stringify({ v: 1, configured: true, ...ALL, traces: "yes" }),
      JSON.stringify({ v: 2, configured: true, ...ALL }),
    ]) {
      fs.writeFileSync(file, contents);
      const c = client();
      expect(c.consent()).toEqual({ ...OFF, configured: false });
      expect(capture(c, "usage")).toBe(false);
    }
  });

  it("rejects incomplete choices, and pauses everything when the save fails", () => {
    const c = client();
    c.save(ALL);
    expect(() => c.save({ usage: true })).toThrow();
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => c.save(ALL)).toThrow("Collection is paused");
    expect(c.consent()).toEqual({ ...OFF, configured: false });
    expect(capture(c, "usage")).toBe(false);
  });

  it("turning a category off cancels its upload and drops its queue; others still send", async () => {
    let aborted = false;
    request.mockImplementationOnce(hangUntilAborted(() => (aborted = true)));
    const c = client();
    c.save(ALL);
    capture(c, "traces");
    capture(c, "traces");
    capture(c, "diagnostics");
    await sent(1);
    c.save({ ...ALL, traces: false });
    expect(aborted).toBe(true);
    c.save(ALL);
    await sent(2);
    await settle(60);
    expect(request).toHaveBeenCalledTimes(2);
    expect(received.map(categoryOf)).toEqual(["diagnostics"]);
  });
});

describe("delivery", () => {
  it("retries transient failures a bounded number of times, and never a rejection", async () => {
    request.mockResolvedValue(new Response(null, { status: 503 }));
    const c = client();
    c.save(ALL);
    capture(c, "usage");
    await sent(3);
    await settle(60);
    expect(request).toHaveBeenCalledTimes(3);
    request.mockResolvedValue(new Response(null, { status: 400 }));
    capture(c, "reports");
    await sent(4);
    await settle(60);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("retries with the identical envelope when a delivered request loses its response", async () => {
    const bodies: TelemetryEnvelope[] = [];
    request.mockImplementation(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) throw new TypeError("connection closed after acceptance");
      return new Response(null, { status: 204 });
    });
    const c = client();
    c.save(ALL);
    capture(c, "reports");
    await sent(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("drops a waiting retry when its category is turned off, even if turned straight back on", async () => {
    request.mockResolvedValue(new Response(null, { status: 429 }));
    const c = client({ retryMs: [100] });
    c.save(ALL);
    capture(c, "reports");
    await sent(1);
    c.save({ ...ALL, reports: false });
    c.save(ALL);
    await settle(150);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds the in-memory queue and keeps nothing across a restart", async () => {
    const c = client();
    c.save(ALL);
    for (let i = 0; i < 64; i++) expect(capture(c, "usage")).toBe(true);
    expect(capture(c, "usage")).toBe(false);
    c.close();
    const restarted = client();
    expect(restarted.consent().usage).toBe(true);
    await settle(30);
    expect(request).not.toHaveBeenCalled();
    const huge = { backend: "phaethon", messages: Array.from({ length: 20 }, () => ({ role: "user", text: "a".repeat(8000) })) };
    for (let i = 0; i < 3; i++) expect(restarted.capture("traces", "chat_trace", huge)).toBe(true);
    expect(restarted.capture("traces", "chat_trace", huge)).toBe(false);
  });

  it("signs each envelope with its own verifiable Ed25519 key", async () => {
    const c = client();
    c.save(ALL);
    capture(c, "usage");
    capture(c, "usage");
    await sent(2);
    expect(received[0]!.publicKey).not.toBe(received[1]!.publicKey);
    for (const e of received) {
      expect(Object.keys(e).sort()).toEqual(["id", "payload", "publicKey", "sentAt", "signature", "v"]);
      expect(new Date(e.sentAt).toISOString()).toBe(e.sentAt);
      const key = createPublicKey({ key: Buffer.from(e.publicKey, "base64"), format: "der", type: "spki" });
      const bytes = Buffer.from(telemetrySignatureMessage(e), "utf8");
      const signature = Buffer.from(e.signature, "base64");
      expect(verify(null, bytes, key, signature)).toBe(true);
      expect(verify(null, Buffer.concat([bytes, Buffer.from("!")]), key, signature)).toBe(false);
      expect(JSON.parse(e.payload)).toMatchObject({ category: "usage", appVersion: "0.0.0-dev", data: { view: "chat" } });
    }
    // The core sets the version after this module loaded (the shell's hello); events still carry it.
    vi.stubEnv("PHAETHON_VERSION", "0.4.0");
    capture(c, "usage");
    await sent(3);
    expect(JSON.parse(received[2]!.payload)).toMatchObject({ appVersion: "0.4.0" });
    const unicode = signedEnvelope({ category: "reports", event: "testing_report", appVersion: "1.0.0", platform: "other", data: { text: "日本語" } });
    expect(unicode.payload).toContain("日本語");
  });
});

it("refuses events outside the schema", () => {
  const c = client();
  c.save(ALL);
  const refused = (category: TelemetryCategory, event: string, data: object) =>
    expect(c.capture(category, event, data)).toBe(false);
  for (const extra of [{ path: "/Users/Jane/file" }, { name: "Jane" }, { model: "https://private" }, { apiKey: "secret" }]) {
    refused("usage", "view_opened", { view: "chat", ...extra });
    refused("diagnostics", "turn_completed", { ...SAMPLE.diagnostics.data, ...extra });
  }
  refused("usage", "view_opened", { view: "Jane" });
  refused("usage", "view_opened", {});
  refused("usage", "action_completed", { action: "search_used", count: 1.5 });
  refused("diagnostics", "turn_completed", { ...SAMPLE.diagnostics.data, backend: "custom" });
  refused("reports", "testing_report", { text: "   " });
  refused("traces", "chat_trace", { backend: "phaethon", messages: [{ role: "system", text: "secret" }] });
  refused("usage", "something_else", {});
});

it("uses a collector only in release builds, or a loopback one when explicitly allowed", () => {
  const endpoint = (url: string) => (vi.stubEnv("PHAETHON_TELEMETRY_ENDPOINT", url), collectorEndpoint());
  expect(endpoint("")).toBeNull();
  expect(endpoint("https://collector.example/ingest")).toBeNull();
  vi.stubEnv("PHAETHON_TEST", "0");
  vi.stubEnv("PHAETHON_PACKAGED", "1");
  expect(endpoint("https://collector.example/ingest")).toBe("https://collector.example/ingest");
  for (const url of ["http://collector.example/ingest", "https://u:p@collector.example", "https://collector.example?key=1", "file:///tmp/x"]) {
    expect(endpoint(url)).toBeNull();
  }
  expect(endpoint("http://127.0.0.1:1234/ingest")).toBeNull();
  vi.stubEnv("PHAETHON_TELEMETRY_ALLOW_LOCAL", "1");
  expect(endpoint("http://127.0.0.1:1234/ingest")).toBe("http://127.0.0.1:1234/ingest");
  expect(endpoint("http://collector.example")).toBeNull();
});

it("redacts common secrets, identifiers, URLs, private keys, and home paths", () => {
  const raw =
    'Jane@example.com /Users/Jane/Documents/test.txt /home/jane/a C:\\Users\\Jane\\secret.txt ~/notes token=abc123 password: "hunter2" ' +
    "Bearer eyJsecret sk-proj-123456789abcdef ghp_123456789012345 https://private.example/model " +
    "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----";
  const redacted = redactText(raw);
  for (const secret of ["Jane@example", "Jane", "/home/jane", "~/notes", "abc123", "hunter2", "eyJsecret", "sk-proj", "ghp_", "private.example", "ABC"]) {
    expect(redacted).not.toContain(secret);
  }
  expect(redactText(redacted)).toBe(redacted);
  expect(redactText("hello", 3)).toBe("hel");
  // Prose can still identify someone; redaction doesn't pretend otherwise.
  expect(redactText("Alice studies biology")).toBe("Alice studies biology");
});

describe("chat turns", () => {
  it("traces only the redacted new prompt and answer, never tools or reasoning", async () => {
    const c = client();
    c.save(ALL);
    const turn = recordTurn("codex-cli", "email me jane@example.com", c.grant("traces"), c);
    turn.event({ kind: "tool", label: "secret tool result" });
    turn.event({ kind: "thinking", delta: "secret system reasoning" });
    turn.event({ kind: "text", delta: "Hello /Users/Jane/private" });
    turn.finish(false);
    await sent(2);
    const trace = JSON.parse(received.find((e) => categoryOf(e) === "traces")!.payload);
    expect(trace.data).toEqual({
      backend: "codex-cli",
      messages: [
        { role: "user", text: "email me [redacted email]" },
        { role: "assistant", text: "Hello [redacted path]" },
      ],
    });
  });

  it("needs trace consent from the start of the turn to its end", async () => {
    const c = client();
    c.save(ALL);
    const revoked = recordTurn("phaethon", "new prompt", c.grant("traces"), c);
    revoked.event({ kind: "text", delta: "Do not send me" });
    c.save({ ...ALL, traces: false });
    c.save(ALL);
    revoked.finish(false);

    const late = client();
    late.save({ ...ALL, traces: false });
    const turn = recordTurn("claude-cli", "no consent at start", late.grant("traces"), late);
    late.save(ALL);
    turn.event({ kind: "text", delta: "also private" });
    turn.finish(false);

    await sent(2);
    await settle();
    expect(received.map(categoryOf)).toEqual(["diagnostics", "diagnostics"]);
  });

  it("never traces a failed or cancelled turn", async () => {
    const c = client();
    c.save(ALL);
    for (const kind of ["failed", "cancelled"] as const) {
      const turn = recordTurn("gemini-cli", "prompt", c.grant("traces"), c);
      turn.event({ kind: "text", delta: "partial response" });
      if (kind === "failed") turn.event({ kind: "error", code: "network", message: "private error" });
      turn.finish(kind === "cancelled");
    }
    await sent(2);
    expect(received.map((e) => JSON.parse(e.payload).data.outcome)).toEqual(["failed", "cancelled"]);
  });
});
