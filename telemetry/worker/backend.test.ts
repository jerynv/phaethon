import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeAll, test } from "vitest";
import worker from "./index.ts";
import { maintain } from "./maintain.ts";
import type { Bucket, Database, Env, Statement } from "./bindings.ts";
import { base64, hashPassword, makeReceipt, sha256 } from "./crypto.ts";
import { MAX_TELEMETRY_BODY_BYTES, parseTelemetryEnvelope, parseTelemetryPayload, telemetrySignatureMessage, type TelemetryEnvelope, type TelemetryPayload } from "../../src/shared/telemetry.ts";

const ORIGIN = "https://console.example.test";
const DAY = 86_400_000;
let password: string;
let passwordHash: string;
beforeAll(async () => { password = `${crypto.randomUUID()}-staff`; passwordHash = await hashPassword(password); });
const open: DatabaseSync[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

class LocalDB implements Database {
  readonly sql = new DatabaseSync(":memory:");
  failFinalize = false;
  failStaffAudit = false;
  beforeBatch?: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  constructor() { this.sql.exec(readFileSync(new URL("../migrations/0001_telemetry.sql", import.meta.url), "utf8")); open.push(this.sql); }
  prepare(sql: string): Statement {
    const db = this;
    let values: unknown[] = [];
    return {
      bind(...args: unknown[]) { values = args; return this; },
      async first<T>() { return (db.sql.prepare(sql).get(...values as never[]) ?? null) as T | null; },
      async all<T>() { return { results: db.sql.prepare(sql).all(...values as never[]) as T[] }; },
      async run() {
        if (db.failFinalize && sql.startsWith("UPDATE events SET archived")) throw new Error("Injected D1 finalization failure");
        if (db.failStaffAudit && sql.startsWith("INSERT INTO staff_audit")) throw new Error("Injected staff audit failure");
        const result = db.sql.prepare(sql).run(...values as never[]);
        return { meta: { changes: Number(result.changes) } };
      },
    };
  }
  async batch(statements: Statement[]): Promise<unknown[]> {
    const run = this.queue.then(async () => {
      const before = this.beforeBatch; this.beforeBatch = undefined; before?.();
      this.sql.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        this.sql.exec("COMMIT"); return results;
      } catch (error) { this.sql.exec("ROLLBACK"); throw error; }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
class LocalBucket implements Bucket {
  readonly objects = new Map<string, string>();
  fail = false;
  putCount = 0;
  async put(key: string, value: string): Promise<object | null> {
    if (this.fail) throw new Error("Injected R2 failure");
    if (this.objects.has(key)) return null;
    this.objects.set(key, value); this.putCount++; return { key };
  }
  async get(key: string): Promise<{ text(): Promise<string> } | null> {
    const value = this.objects.get(key); return value === undefined ? null : { text: async () => value };
  }
  async delete(key: string): Promise<void> { if (this.fail) throw new Error("Injected R2 failure"); this.objects.delete(key); }
  async list({ prefix, limit }: { prefix: string; limit: number }): Promise<{ objects: Array<{ key: string }> }> {
    return { objects: [...this.objects.keys()].filter(key => key.startsWith(prefix)).sort().slice(0, limit).map(key => ({ key })) };
  }
}
function harness() {
  const DB = new LocalDB();
  const RAW = new LocalBucket();
  const env: Env = { DB, RAW, CONSOLE_ORIGIN: ORIGIN, ARCHIVE_RECEIPT_KEY: base64(crypto.getRandomValues(new Uint8Array(32))) };
  DB.sql.prepare("INSERT INTO staff(id,email,username,password_hash,auth_version) VALUES (?,?,?,?,?)")
    .run("staff", "staff@example.test", "staff", passwordHash, "version1");
  const call = (path: string, options: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, options), env);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const login = async () => {
    const response = await post("/api/login", { email: "staff@example.test", password });
    assert.equal(response.status, 200);
    return response.headers.get("Set-Cookie")!.split(";")[0];
  };
  return { DB, RAW, env, call, post, login };
}
function payload(category: TelemetryPayload["category"] = "usage"): TelemetryPayload {
  const common = { appVersion: "0.3.1", platform: "darwin" as const };
  switch (category) {
    case "usage": return { ...common, category, event: "app_opened", data: { count: 1 } };
    case "diagnostics": return { ...common, category, event: "turn_completed", data: { backend: "phaethon", outcome: "completed", durationMs: 100, steps: 2 } };
    case "reports": return { ...common, category, event: "testing_report", data: { text: "A locally redacted report" } };
    case "traces": return { ...common, category, event: "chat_trace", data: { backend: "codex-cli", messages: [{ role: "assistant", text: "A locally redacted trace" }] } };
  }
}
async function envelope(p: TelemetryPayload = payload(), overrides: Partial<TelemetryEnvelope> = {}): Promise<TelemetryEnvelope> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const e: TelemetryEnvelope = { v: 1, id: crypto.randomUUID(), sentAt: new Date().toISOString(),
    publicKey: base64(await crypto.subtle.exportKey("spki", keys.publicKey)), payload: JSON.stringify(p), signature: "", ...overrides };
  e.signature = base64(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(telemetrySignatureMessage(e))));
  return e;
}

test("valid signatures for all categories archive exact envelopes with a stable server receipt and no transport metadata", async () => {
  const h = harness();
  for (const category of ["usage", "diagnostics", "reports", "traces"] as const) {
    const e = await envelope(payload(category));
    const response = await h.post("/api/ingest", e, { "CF-Connecting-IP": "192.0.2.1", Authorization: "Bearer public-ingestion", "X-Account": "private" });
    assert.equal(response.status, 201);
    const { receipt } = await response.json() as { receipt: Awaited<ReturnType<typeof makeReceipt>> };
    assert.deepEqual(receipt, await makeReceipt(h.env.ARCHIVE_RECEIPT_KEY, e.id, receipt.receivedAt, await sha256(JSON.stringify(e))));
    const row = h.DB.sql.prepare("SELECT * FROM events WHERE id=?").get(e.id)!;
    assert.equal(row.pending_json, null); assert.equal(row.archived, 1);
    assert.equal(Number(row.expires_at) - Date.parse(String(row.received_at)), (category === "reports" || category === "traces" ? 90 : 365) * DAY);
    const archive = h.RAW.objects.get(String(row.archive_key))!;
    assert.deepEqual(JSON.parse(archive).envelope, e);
    assert(!archive.includes("192.0.2.1")); assert(!archive.includes("private"));
    assert(!JSON.stringify(h.DB.sql.prepare("SELECT * FROM rate_limits").all()).includes("192.0.2.1"));
  }
  const cookie = await h.login();
  const response = await h.call("/api/overview?days=90", { headers: { Cookie: cookie } });
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body.totals, { usage: 1, diagnostics: 1, reports: 1, traces: 1 });
  assert.deepEqual(body.outcomes, [{ outcome: "completed", count: 1 }]);
  assert.deepEqual(body.days, [{ day: new Date().toISOString().slice(0, 10), count: 4 }]);
});

test("malformed, noncanonical, stale, future, tampered and wrong-key envelopes never reserve a UUID", async () => {
  const h = harness();
  const e = await envelope();
  const wrongKey = await envelope();
  const cases = [null, {}, { ...e, payload: e.payload + " " }, { ...e, id: crypto.randomUUID() },
    { ...e, publicKey: wrongKey.publicKey }, { ...e, signature: "A".repeat(86) + "==" },
    { ...e, sentAt: new Date(Date.now() - 2 * DAY).toISOString() },
    { ...e, sentAt: new Date(Date.now() + 10 * 60_000).toISOString() },
    { ...e, sentAt: "2026-02-30T00:00:00Z" }, { ...e, installId: "forbidden" },
    { ...e, publicKey: e.publicKey + "AAAA" }, { ...e, payload: "{" }];
  for (const value of cases) assert.equal((await h.post("/api/ingest", value)).status, 400);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM replays").get()!.count, 0);
});

test("payload allow-list rejects nested attributes, URLs, accounts, preference data, raw errors and out-of-bounds content", () => {
  const p = payload();
  const bad: unknown[] = [
    { ...p, account: "private" }, { ...p, preferences: {} }, { ...p, event: "custom" },
    { ...p, platform: "custom" }, { ...p, appVersion: "https://host/?token=x" },
    { ...p, data: { url: "https://host/?token=x" } }, { ...p, data: { count: -1 } },
    { ...p, data: { count: 1.1 } }, { ...p, data: { count: 10001 } },
    { ...payload("diagnostics"), data: { backend: "custom-model", outcome: "completed", durationMs: 1, steps: 1 } },
    { ...payload("diagnostics"), data: { backend: "phaethon", outcome: "failed", durationMs: 1, steps: 1, error: "private" } },
    { ...payload("diagnostics"), data: { backend: "phaethon", outcome: "failed", durationMs: 86_400_001, steps: 1 } },
    { ...payload("reports"), data: { text: "x".repeat(4001) } },
    { ...payload("traces"), data: { backend: "phaethon", messages: [{ role: "system", text: "private" }] } },
    { ...payload("traces"), data: { backend: "phaethon", messages: [{ role: "user", text: "x".repeat(8001) }] } },
    { ...payload("traces"), data: { backend: "phaethon", messages: Array.from({ length: 21 }, () => ({ role: "user", text: "x" })) } },
    { ...payload("traces"), data: { backend: "phaethon", messages: [{ role: "user", text: "x", account: "private" }] } },
  ];
  for (const value of bad) assert.throws(() => parseTelemetryPayload(value));
  assert.throws(() => parseTelemetryPayload(" ".repeat(193 * 1024)));
});

test("body sizes are bounded by bytes with or without Content-Length, including invalid UTF8", async () => {
  const h = harness();
  assert.equal((await h.post("/api/ingest", { oversized: "x".repeat(MAX_TELEMETRY_BODY_BYTES) })).status, 413);
  assert.equal((await h.call("/api/ingest", { method: "POST", body: "{}", headers: { "Content-Type": "application/json", "Content-Length": String(MAX_TELEMETRY_BODY_BYTES + 1) } })).status, 413);
  assert.equal((await h.call("/api/ingest", { method: "POST", body: "{}" })).status, 415);
  assert.equal((await h.call("/api/ingest", { method: "POST", body: new Uint8Array([0xff]), headers: { "Content-Type": "application/json" } })).status, 400);
});

test("same UUID retry is idempotent; valid conflicting signature/payload is rejected atomically", async () => {
  const h = harness(); const e = await envelope();
  const first = await h.post("/api/ingest", e);
  assert.equal(first.status, 201);
  const second = await h.post("/api/ingest", e);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  const conflict = await envelope(payload("reports"), { id: e.id });
  assert.equal((await h.post("/api/ingest", conflict)).status, 409);
  assert.equal(h.RAW.putCount, 1); assert.equal(h.RAW.objects.size, 1);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM events").get()!.count, 1);
});

test("archive failure retains outbox, never exposes pending data, and retries preserve the receipt", async () => {
  const h = harness(); const e = await envelope(); const cookie = await h.login();
  h.RAW.fail = true;
  assert.equal((await h.post("/api/ingest", e)).status, 503);
  const pending = h.DB.sql.prepare("SELECT * FROM events WHERE id=?").get(e.id)!;
  assert.equal(pending.pending_json, JSON.stringify(e));
  assert.equal((await h.call(`/api/events/${e.id}`, { headers: { Cookie: cookie } })).status, 404);
  assert.deepEqual((await (await h.call("/api/events", { headers: { Cookie: cookie } })).json() as { items: unknown[] }).items, []);
  h.RAW.fail = false;
  await maintain(h.env);
  const retry = await h.post("/api/ingest", e);
  assert.equal(retry.status, 200);
  assert.deepEqual((await retry.json() as { receipt: unknown }).receipt, JSON.parse(String(pending.receipt_json)));
});

test("D1 finalization failure after R2 success is repaired without a second archive or receipt", async () => {
  const h = harness(); const e = await envelope(); h.DB.failFinalize = true;
  assert.equal((await h.post("/api/ingest", e)).status, 503);
  const saved = [...h.RAW.objects.values()][0];
  h.DB.failFinalize = false;
  assert.equal((await h.post("/api/ingest", e)).status, 201);
  assert.equal(h.RAW.putCount, 1); assert.equal([...h.RAW.objects.values()][0], saved);
});

test("R2 conflicting content fails closed instead of overwriting; authenticated reads detect archive tampering", async () => {
  const h = harness(); const e = await envelope(); h.DB.failFinalize = true;
  await h.post("/api/ingest", e);
  const key = [...h.RAW.objects.keys()][0]; h.RAW.objects.set(key, "{}"); h.DB.failFinalize = false;
  assert.equal((await h.post("/api/ingest", e)).status, 503);
  assert.equal(h.RAW.objects.get(key), "{}");
  const h2 = harness(); const e2 = await envelope(); await h2.post("/api/ingest", e2);
  const key2 = [...h2.RAW.objects.keys()][0]; const archive = JSON.parse(h2.RAW.objects.get(key2)!);
  archive.envelope.payload += " "; h2.RAW.objects.set(key2, JSON.stringify(archive));
  assert.equal((await h2.call(`/api/events/${e2.id}`, { headers: { Cookie: await h2.login() } })).status, 503);
});

test("read and export reject rewritten R2 payload plus D1 hash with unchanged server receipt", async () => {
  const h = harness(); const e = await envelope(payload("reports")); await h.post("/api/ingest", e);
  const key = [...h.RAW.objects.keys()][0]; const archive = JSON.parse(h.RAW.objects.get(key)!);
  archive.envelope.payload = JSON.stringify({ ...payload("reports"), data: { text: "Altered content" } });
  h.RAW.objects.set(key, JSON.stringify(archive));
  h.DB.sql.prepare("UPDATE events SET envelope_hash=? WHERE id=?").run(await sha256(JSON.stringify(archive.envelope)), e.id);
  const Cookie = await h.login();
  for (const path of [`/api/events/${e.id}`, "/api/export?days=90"]) {
    const response = await h.call(path, { headers: { Cookie } });
    assert.equal(response.status, 503); assert(!(await response.text()).includes("Altered content"));
  }
});

test("even a freshly self-signed replacement cannot forge the server receipt; corrupt receipt bindings fail closed", async () => {
  const h = harness(); const e = await envelope(payload("reports")); await h.post("/api/ingest", e);
  const key = [...h.RAW.objects.keys()][0]; const archive = JSON.parse(h.RAW.objects.get(key)!);
  const replacement = await envelope(payload("reports"), { id: e.id });
  archive.envelope = replacement;
  archive.receipt.envelopeHash = await sha256(JSON.stringify(replacement));
  // Both stores are rewritten consistently, but the attacker lacks the receipt key.
  h.RAW.objects.set(key, JSON.stringify(archive));
  h.DB.sql.prepare("UPDATE events SET envelope_hash=?,receipt_json=? WHERE id=?")
    .run(archive.receipt.envelopeHash, JSON.stringify(archive.receipt), e.id);
  const Cookie = await h.login();
  assert.equal((await h.call(`/api/events/${e.id}`, { headers: { Cookie } })).status, 503);
  for (const field of ["id", "receivedAt", "envelopeHash", "mac"] as const) {
    const h2 = harness(); const original = await envelope(); await h2.post("/api/ingest", original);
    const key2 = [...h2.RAW.objects.keys()][0]; const a = JSON.parse(h2.RAW.objects.get(key2)!);
    a.receipt[field] = field === "id" ? crypto.randomUUID() : field === "receivedAt" ? new Date(Date.now() - DAY).toISOString() : field === "envelopeHash" ? "0".repeat(64) : "A".repeat(43) + "=";
    h2.RAW.objects.set(key2, JSON.stringify(a)); h2.DB.sql.prepare("UPDATE events SET receipt_json=?").run(JSON.stringify(a.receipt));
    assert.equal((await h2.call(`/api/events/${original.id}`, { headers: { Cookie: await h2.login() } })).status, 503);
  }
});

test("old retained envelopes remain readable beyond freshness and across receipt-key rotation", async () => {
  const h = harness(); const e = await envelope(payload("reports"), { sentAt: new Date(Date.now() - 30 * DAY).toISOString() });
  const encoded = JSON.stringify(e); const hash = await sha256(encoded); const time = new Date(Date.now() - 30 * DAY).toISOString();
  const receipt = await makeReceipt(h.env.ARCHIVE_RECEIPT_KEY, e.id, time, hash);
  h.DB.sql.prepare("INSERT INTO replays VALUES (?,?,?,?)").run(e.id, hash, "fixture", Date.now() + 60 * DAY);
  const key = `events/content/${Date.now() + 60 * DAY}/${e.id}.json`;
  h.DB.sql.prepare(`INSERT INTO events(id,category,event,received_at,sent_at,app_version,platform,expires_at,archive_key,envelope_hash,receipt_json,archived)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(e.id, "reports", "testing_report", time, e.sentAt, "0.3.1", "darwin", Date.now() + 60 * DAY, key, hash, JSON.stringify(receipt));
  h.RAW.objects.set(key, JSON.stringify({ envelope: e, receipt }));
  const Cookie = await h.login();
  h.env.ARCHIVE_RECEIPT_PREVIOUS_KEYS = JSON.stringify([h.env.ARCHIVE_RECEIPT_KEY]);
  h.env.ARCHIVE_RECEIPT_KEY = base64(crypto.getRandomValues(new Uint8Array(32)));
  assert.equal((await h.call(`/api/events/${e.id}`, { headers: { Cookie } })).status, 200);
  h.env.ARCHIVE_RECEIPT_PREVIOUS_KEYS = "[]";
  assert.equal((await h.call(`/api/events/${e.id}`, { headers: { Cookie } })).status, 503);
});

test("concurrent identical requests and conflicting UUID requests produce exactly one archive", async () => {
  const h = harness(); const e = await envelope();
  const responses = await Promise.all(Array.from({ length: 6 }, () => h.post("/api/ingest", e)));
  assert(responses.every(response => [200, 201].includes(response.status)));
  assert.equal(h.RAW.putCount, 1); assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM events").get()!.count, 1);
  const h2 = harness(); const same = crypto.randomUUID();
  const candidates = await Promise.all(Array.from({ length: 4 }, () => envelope(payload(), { id: same })));
  const conflicting = await Promise.all(candidates.map(candidate => h2.post("/api/ingest", candidate)));
  assert.equal(conflicting.filter(response => response.status === 201).length, 1);
  assert.equal(conflicting.filter(response => response.status === 409).length, 3);
  assert.equal(h2.RAW.putCount, 1);
});

test("all staff APIs return 401 without sessions, including ingestion bearer credentials and forged cookies", async () => {
  const h = harness();
  for (const path of ["/api/session", "/api/overview", "/api/events?category=reports", `/api/events/${crypto.randomUUID()}`, "/api/export", "/api/unknown"]) {
    for (const headers of [{}, { Authorization: "Bearer ingestion" }, { Cookie: "__Host-phaethon_session=" + "a".repeat(43) }] as Record<string, string>[]) {
      const response = await h.call(path, { headers }); assert.equal(response.status, 401); assert.deepEqual(await response.json(), { error: "Unauthorized" });
      assert.equal(response.headers.get("Access-Control-Allow-Origin"), null); assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  }
  assert.equal((await h.post("/api/logout", {})).status, 401);
});

test("provisioned email and username logins have generic failures and protected expiring opaque sessions", async () => {
  const h = harness();
  const wrong = await h.post("/api/login", { email: "staff@example.test", password: "incorrect" });
  const unknown = await h.post("/api/login", { email: "unknown@example.test", password: "incorrect" });
  assert.equal(wrong.status, 401); assert.equal(unknown.status, 401); assert.deepEqual(await wrong.json(), await unknown.json());
  const response = await h.post("/api/login", { email: "STAFF", password });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { email: "staff@example.test", role: "viewer" });
  const setCookie = response.headers.get("Set-Cookie")!;
  for (const value of ["__Host-", "HttpOnly", "Secure", "SameSite=Strict", "Path=/", "Max-Age=28800"]) assert(setCookie.includes(value));
  assert(!setCookie.includes("Domain="));
  const Cookie = setCookie.split(";")[0]; const token = Cookie.split("=")[1];
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert(!JSON.stringify(h.DB.sql.prepare("SELECT * FROM sessions").all()).includes(token));
  assert.deepEqual(await (await h.call("/api/session", { headers: { Cookie } })).json(), { email: "staff@example.test", role: "viewer" });
  h.DB.sql.prepare("UPDATE sessions SET expires_at=?").run(Date.now() - 1);
  assert.equal((await h.call("/api/session", { headers: { Cookie } })).status, 401);
});

test("logout, re-login rotation, account revocation, password replacement and disable invalidate sessions", async () => {
  const h = harness(); const first = await h.login();
  const rotated = await h.post("/api/login", { email: "staff", password }, { Cookie: first });
  const second = rotated.headers.get("Set-Cookie")!.split(";")[0];
  assert.equal((await h.call("/api/session", { headers: { Cookie: first } })).status, 401);
  const out = await h.post("/api/logout", {}, { Cookie: second }); assert.equal(out.status, 200); assert(out.headers.get("Set-Cookie")!.includes("Max-Age=0"));
  assert.equal((await h.call("/api/session", { headers: { Cookie: second } })).status, 401);
  const third = await h.login(); h.DB.sql.prepare("UPDATE staff SET auth_version=?").run("reprovisioned");
  assert.equal((await h.call("/api/session", { headers: { Cookie: third } })).status, 401);
  const fourth = await h.login(); h.DB.sql.prepare("UPDATE staff SET disabled=1").run();
  assert.equal((await h.call("/api/session", { headers: { Cookie: fourth } })).status, 401);
  assert.equal((await h.post("/api/login", { email: "staff", password })).status, 401);
});

test("cross-origin, null-origin, missing-origin and cross-site login/logout are rejected without mutation", async () => {
  const h = harness(); const Cookie = await h.login();
  for (const headers of [{ Origin: "https://evil.example" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
    assert.equal((await h.post("/api/login", { email: "staff", password }, headers)).status, 403);
    assert.equal((await h.post("/api/logout", {}, { Cookie, ...headers })).status, 403);
  }
  assert.equal((await h.call("/api/login", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } })).status, 403);
  assert.equal((await h.call("/api/logout", { method: "POST", headers: { Cookie } })).status, 403);
  assert.equal((await h.call("/api/session", { headers: { Cookie } })).status, 200);
});

type Harness = ReturnType<typeof harness>;
async function owner(h: Harness): Promise<string> {
  h.DB.sql.prepare("UPDATE staff SET role='owner' WHERE id='staff'").run();
  return h.login();
}
async function accountLogin(h: Harness, email: string, secret = password): Promise<string> {
  const response = await h.post("/api/login", { email, password: secret });
  assert.equal(response.status, 200);
  return response.headers.get("Set-Cookie")!.split(";")[0];
}
function patchStaff(h: Harness, id: string, body: unknown, Cookie: string, extra: Record<string, string> = {}): Promise<Response> {
  return h.call(`/api/staff/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie, ...extra } });
}

test("viewers cannot list staff, read audit records, create, update, or revoke accounts", async () => {
  const h = harness(); const Cookie = await h.login();
  for (const path of ["/api/staff", "/api/staff/audit"]) assert.equal((await h.call(path, { headers: { Cookie } })).status, 403);
  assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "new", role: "owner", password }, { Cookie })).status, 403);
  assert.equal((await patchStaff(h, "staff", { email: "staff@example.test", username: "staff", role: "owner", disabled: false }, Cookie)).status, 403);
  assert.equal((await h.post("/api/staff/staff/revoke", {}, { Cookie })).status, 403);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff_audit").get()!.count, 0);
  assert.equal(h.DB.sql.prepare("SELECT role FROM staff").get()!.role, "viewer");
});

test("owners manage accounts, credentials, roles, enabled access, revocation, and credential-free audit records", async () => {
  const h = harness(); const Cookie = await owner(h);
  assert.deepEqual(await (await h.call("/api/session", { headers: { Cookie } })).json(), { email: "staff@example.test", role: "owner" });
  assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "new-staff", role: "viewer", password }, { Cookie })).status, 201);
  const list = await (await h.call("/api/staff", { headers: { Cookie } })).json() as { items: Array<{ id: string; email: string; username: string; role: string; disabled: boolean }> };
  const created = list.items.find(row => row.email === "new@example.test")!;
  assert.equal(created.role, "viewer"); assert.equal(created.disabled, false);
  assert.deepEqual(Object.keys(created).sort(), ["disabled", "email", "id", "role", "username"]);
  const oldSession = await accountLogin(h, created.email);
  const nextPassword = `${crypto.randomUUID()}-replacement`;
  const changes = { email: "changed@example.test", username: "changed-staff", role: "owner", disabled: false };
  assert.equal((await patchStaff(h, created.id, { ...changes, password: nextPassword }, Cookie)).status, 200);
  assert.equal((await h.call("/api/session", { headers: { Cookie: oldSession } })).status, 401);
  assert.equal((await h.post("/api/login", { email: changes.email, password })).status, 401);
  const newSession = await accountLogin(h, changes.email, nextPassword);
  assert.equal((await patchStaff(h, created.id, { ...changes, disabled: true }, Cookie)).status, 200);
  assert.equal((await h.call("/api/session", { headers: { Cookie: newSession } })).status, 401);
  assert.equal((await h.post("/api/login", { email: changes.email, password: nextPassword })).status, 401);
  assert.equal((await patchStaff(h, created.id, changes, Cookie)).status, 200);
  const active = await accountLogin(h, changes.username, nextPassword);
  assert.equal((await h.post(`/api/staff/${created.id}/revoke`, {}, { Cookie })).status, 200);
  assert.equal((await h.call("/api/session", { headers: { Cookie: active } })).status, 401);
  const audit = await (await h.call("/api/staff/audit", { headers: { Cookie } })).json() as { items: Array<{ action: string; actorEmail: string; targetEmail: string; createdAt: string }> };
  assert.equal(audit.items.length, 5);
  assert.deepEqual(new Set(audit.items.map(item => item.action)), new Set(["created", "updated", "sessions_revoked"]));
  assert(audit.items.every(item => item.actorEmail === "staff@example.test" && item.targetEmail === (item.action === "created" ? created.email : changes.email) && Number.isFinite(Date.parse(item.createdAt))));
  assert.equal((await patchStaff(h, "staff", { email: "renamed-owner@example.test", username: "staff", role: "owner", disabled: false }, Cookie)).status, 200);
  const renamedSession = await accountLogin(h, "renamed-owner@example.test");
  const history = await (await h.call("/api/staff/audit", { headers: { Cookie: renamedSession } })).json() as typeof audit;
  assert.equal(history.items.find(item => item.action === "created")?.actorEmail, "staff@example.test");
  assert.equal(history.items.find(item => item.action === "created")?.targetEmail, "new@example.test");
  assert(!JSON.stringify(audit).includes("scrypt")); assert(!JSON.stringify(audit).includes(nextPassword));
  const stored = h.DB.sql.prepare("SELECT password_hash FROM staff WHERE id=?").get(created.id)!;
  assert.notEqual(stored.password_hash, nextPassword); assert.match(String(stored.password_hash), /^scrypt\$/);
});

test("staff writes reject cross-origin requests, invalid fields, duplicates, and removing the last owner", async () => {
  const h = harness(); const Cookie = await owner(h);
  const self = { email: "staff@example.test", username: "staff", role: "owner", disabled: false };
  for (const body of [{ ...self, role: "viewer" }, { ...self, disabled: true }]) {
    const result = await patchStaff(h, "staff", body, Cookie);
    assert.equal(result.status, 409); assert.match((await result.json() as { error: string }).error, /active super admin/);
  }
  for (const Origin of ["https://evil.example", "null"]) {
    assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "new", role: "viewer", password }, { Cookie, Origin })).status, 403);
    assert.equal((await patchStaff(h, "staff", self, Cookie, { Origin })).status, 403);
    assert.equal((await h.post("/api/staff/staff/revoke", {}, { Cookie, Origin })).status, 403);
  }
  assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "new", role: "owner", password: "weak" }, { Cookie })).status, 400);
  assert.equal((await h.post("/api/staff", { email: "staff@example.test", username: "new", role: "viewer", password }, { Cookie })).status, 409);
  assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "staff", role: "viewer", password }, { Cookie })).status, 409);
  assert.equal((await patchStaff(h, "missing", self, Cookie)).status, 404);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff_audit").get()!.count, 0);
  assert.equal((await h.call("/api/session", { headers: { Cookie } })).status, 200);
});

test("concurrent owner demotions and disables preserve one enabled owner atomically", async () => {
  for (const disabling of [false, true]) {
    const h = harness(); const first = await owner(h);
    h.DB.sql.prepare("INSERT INTO staff(id,email,username,role,password_hash,auth_version) VALUES (?,?,?,?,?,?)")
      .run("second", "second@example.test", "second", "owner", passwordHash, "second-version");
    const second = await accountLogin(h, "second");
    const role = disabling ? "owner" : "viewer";
    const results = await Promise.all([
      patchStaff(h, "staff", { email: "staff@example.test", username: "staff", role, disabled: disabling }, first),
      patchStaff(h, "second", { email: "second@example.test", username: "second", role, disabled: disabling }, second),
    ]);
    assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
    assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff WHERE role='owner' AND disabled=0").get()!.count, 1);
    assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff_audit").get()!.count, 1);
  }
});

test("staff mutation authorization is rechecked inside the write after credentials have been prepared", async () => {
  for (const revoke of ["version", "role", "disabled"]) {
    const h = harness(); const Cookie = await owner(h);
    h.DB.beforeBatch = () => {
      h.DB.sql.prepare(revoke === "version" ? "UPDATE staff SET auth_version='revoked'" : revoke === "role" ? "UPDATE staff SET role='viewer'" : "UPDATE staff SET disabled=1").run();
    };
    const response = await h.post("/api/staff", { email: "new@example.test", username: "new-staff", role: "owner", password }, { Cookie });
    assert.equal(response.status, revoke === "role" ? 403 : 401);
    assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff").get()!.count, 1);
    assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff_audit").get()!.count, 0);
  }
});

test("staff mutations and audit records commit or roll back together", async () => {
  const h = harness(); const Cookie = await owner(h);
  h.DB.failStaffAudit = true;
  assert.equal((await h.post("/api/staff", { email: "new@example.test", username: "new-staff", role: "viewer", password }, { Cookie })).status, 503);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff").get()!.count, 1);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM staff_audit").get()!.count, 0);
});

test("login and public ingestion are rate limited with short-lived digests only", async () => {
  const h = harness();
  // Invalid schemas avoid expensive hashing and still consume the IP budget.
  for (let i = 0; i < 20; i++) assert.equal((await h.post("/api/login", {}, { "CF-Connecting-IP": "192.0.2.8" })).status, 401);
  assert.equal((await h.post("/api/login", {}, { "CF-Connecting-IP": "192.0.2.8" })).status, 429);
  for (let i = 0; i < 60; i++) assert.equal((await h.post("/api/ingest", {}, { "CF-Connecting-IP": "192.0.2.9" })).status, 400);
  assert.equal((await h.post("/api/ingest", {}, { "CF-Connecting-IP": "192.0.2.9" })).status, 429);
  const rows = h.DB.sql.prepare("SELECT * FROM rate_limits").all();
  for (const row of rows) { assert.match(String(row.key), /^[0-9a-f]{64}$/); assert(Number(row.expires_at) <= Date.now() + 15 * 60_000); }
  assert(!JSON.stringify(rows).includes("192.0.2."));
});

test("list and NDJSON export paginate ties without gaps and respect days/category filters", async () => {
  const h = harness(); const Cookie = await h.login();
  // Real schema with > one page of already archived fixture records at the same timestamp.
  const now = new Date().toISOString();
  for (let i = 0; i < 53; i++) {
    const e = await envelope(payload(i === 52 ? "reports" : "usage"));
    const encoded = JSON.stringify(e); const hash = await sha256(encoded);
    const time = i === 51 ? new Date(Date.now() - 20 * DAY).toISOString() : now;
    const receipt = await makeReceipt(h.env.ARCHIVE_RECEIPT_KEY, e.id, time, hash);
    const key = `events/metrics/${Date.now() + 365 * DAY}/${e.id}.json`;
    h.DB.sql.prepare("INSERT INTO replays VALUES (?,?,?,?)").run(e.id, hash, "fixture", Date.now() + 365 * DAY);
    h.DB.sql.prepare(`INSERT INTO events(id,category,event,received_at,sent_at,app_version,platform,expires_at,archive_key,envelope_hash,receipt_json,archived)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`).run(e.id, i === 52 ? "reports" : "usage", i === 52 ? "testing_report" : "app_opened", time, e.sentAt, "0.3.1", "darwin", Date.now() + 365 * DAY, key, hash, JSON.stringify(receipt));
    h.RAW.objects.set(key, JSON.stringify({ envelope: e, receipt }));
  }
  const all: string[] = []; let before: string | null = null;
  do {
    const response = await h.call(`/api/events?days=7&category=usage${before ? `&before=${before}` : ""}`, { headers: { Cookie } });
    assert.equal(response.status, 200);
    const page = await response.json() as { items: Array<{ id: string }>; nextCursor: string | null };
    assert(page.items.length <= 50); all.push(...page.items.map(item => item.id)); before = page.nextCursor;
  } while (before);
  assert.equal(all.length, 51); assert.equal(new Set(all).size, 51);
  const exported: string[] = []; before = null;
  do {
    const response = await h.call(`/api/export?days=30&category=usage${before ? `&before=${before}` : ""}`, { headers: { Cookie } });
    assert.equal(response.status, 200); assert.match(response.headers.get("Content-Type")!, /application\/x-ndjson/);
    const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(Number(response.headers.get("X-Result-Count")), lines.length);
    for (const item of lines) { exported.push(item.envelope.id); assert(item.receipt.mac); assert.deepEqual(item.payload, parseTelemetryPayload(item.envelope.payload)); }
    before = response.headers.get("X-Next-Cursor"); assert.equal(response.headers.get("X-Has-More"), String(before !== null));
  } while (before);
  assert.equal(exported.length, 52); assert.equal(new Set(exported).size, 52);
  const detail = await h.call(`/api/events/${all[0]}`, { headers: { Cookie } });
  const body = await detail.json() as { payload: TelemetryPayload; verification: string };
  assert.equal(body.payload.category, "usage"); assert.equal(body.verification, "self-signed"); assert(detail.headers.get("X-Archive-Receipt"));
  for (const query of ["days=0", "days=3651", "category=other", "before=bad"]) assert.equal((await h.call(`/api/events?${query}`, { headers: { Cookie } })).status, 400);
});

test("retention hides and deletes expired D1/R2 content, sweeps orphans, cleans sessions/rates, and tombstones forbid resurrection", async () => {
  const h = harness(); const e = await envelope(payload("reports")); await h.post("/api/ingest", e);
  const row = h.DB.sql.prepare("SELECT * FROM events WHERE id=?").get(e.id)!;
  h.DB.sql.prepare("UPDATE events SET expires_at=?").run(Date.now() - 1);
  const Cookie = await h.login();
  assert.equal((await h.call(`/api/events/${e.id}`, { headers: { Cookie } })).status, 404);
  h.RAW.objects.set(`events/content/${Date.now() - 10000}/${crypto.randomUUID()}.json`, "orphan");
  await maintain(h.env);
  assert.equal(h.RAW.objects.size, 0); assert(!h.RAW.objects.has(String(row.archive_key)));
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM events").get()!.count, 0);
  assert.equal((await h.post("/api/ingest", e)).status, 410);
  assert.equal(h.RAW.objects.size, 0);
  h.DB.sql.prepare("UPDATE rate_limits SET expires_at=0").run(); h.DB.sql.prepare("UPDATE sessions SET expires_at=0").run();
  await maintain(h.env);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM rate_limits").get()!.count, 0);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM sessions").get()!.count, 0);
});

test("large trace exports obey the byte cap and paginate every record without truncation", async () => {
  const h = harness();
  const trace: TelemetryPayload = { ...payload("traces"), category: "traces", event: "chat_trace", data: {
    backend: "phaethon", messages: Array.from({ length: 20 }, () => ({ role: "user", text: "x".repeat(8000) })),
  } };
  for (let index = 0; index < 15; index++) assert.equal((await h.post("/api/ingest", await envelope(trace))).status, 201);
  const Cookie = await h.login();
  let before: string | null = null; const ids = new Set<string>(); let pages = 0;
  do {
    const response = await h.call(`/api/export?days=90&category=traces${before ? `&before=${before}` : ""}`, { headers: { Cookie } });
    assert.equal(response.status, 200);
    const text = await response.text(); assert(new TextEncoder().encode(text).byteLength <= 4 * 1024 * 1024);
    const lines = text.trim().split("\n"); assert.equal(Number(response.headers.get("X-Result-Count")), lines.length);
    for (const line of lines) { const id = JSON.parse(line).envelope.id as string; assert(!ids.has(id)); ids.add(id); }
    before = response.headers.get("X-Next-Cursor"); pages++;
  } while (before);
  assert.equal(ids.size, 15); assert(pages >= 2);
});

test("expired outbox content is erased during an R2 outage while the replay tombstone survives", async () => {
  const h = harness(); const e = await envelope(payload("reports")); h.RAW.fail = true;
  assert.equal((await h.post("/api/ingest", e)).status, 503);
  h.DB.sql.prepare("UPDATE events SET expires_at=? WHERE id=?").run(Date.now() - 1, e.id);
  await maintain(h.env);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM events").get()!.count, 0);
  assert.equal(h.DB.sql.prepare("SELECT COUNT(*) AS count FROM replays").get()!.count, 1);
  h.RAW.fail = false;
  assert.equal((await h.post("/api/ingest", e)).status, 410);
});

test("non-API routes use ASSETS and APIs never fall back to console HTML", async () => {
  const h = harness(); h.env.ASSETS = { fetch: async () => new Response("console") };
  assert.equal(await (await h.call("/events/route")).text(), "console");
  assert.match((await h.call("/")).headers.get("Content-Security-Policy")!, /script-src 'self'/);
  assert.equal((await h.call("/api/unknown")).status, 401);
});

test("shared parser accepts canonical envelope and rejects byte-bound payloads", async () => {
  const e = await envelope(); assert.deepEqual(parseTelemetryEnvelope(e), e);
  assert.throws(() => parseTelemetryEnvelope({ ...e, payload: "x".repeat(193 * 1024) }));
});
