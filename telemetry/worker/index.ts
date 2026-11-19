import {
  isTelemetryCategory, isTelemetryTimestamp, MAX_TELEMETRY_BODY_BYTES,
  parseStoredTelemetryEnvelope, parseTelemetryEnvelope, parseTelemetryPayload, TELEMETRY_CATEGORIES, TELEMETRY_UUID,
  type TelemetryCategory, type TelemetryEnvelope,
} from "../../src/shared/telemetry.ts";
import type { Env } from "./bindings.ts";
import { DUMMY_PASSWORD_HASH, makeReceipt, randomToken, sha256, verifyEnvelope, verifyPassword, verifyReceipt, type ArchiveReceipt } from "./crypto.ts";

const COOKIE = "__Host-phaethon_session";
const DAY = 86_400_000;
const PAGE_SIZE = 50;
const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
interface EventRow {
  id: string; category: TelemetryCategory; event: string; received_at: string; sent_at: string;
  app_version: string; platform: string; outcome: string | null; expires_at: number;
  archive_key: string; envelope_hash: string; receipt_json: string; pending_json: string | null; archived: number;
}
interface StaffSession { email: string; token_hash: string }
class HttpError extends Error { constructor(readonly status: number) { super(); } }
function json(value: unknown, status = 200, headers?: HeadersInit): Response { return Response.json(value, { status, headers }); }
function boundedSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid configuration");
  return number;
}
function sessionTTL(env: Env): number { return boundedSetting(env.SESSION_TTL_SECONDS, 28_800, 60, 86_400); }
function retention(env: Env, category: TelemetryCategory): number {
  return category === "reports" || category === "traces"
    ? boundedSetting(env.CONTENT_RETENTION_DAYS, 90, 1, 3650)
    : boundedSetting(env.METADATA_RETENTION_DAYS, 365, 1, 3650);
}
function sameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (!origin || origin !== env.CONSOLE_ORIGIN || new URL(request.url).origin !== env.CONSOLE_ORIGIN
    || (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none")) throw new HttpError(403);
}
async function readJSON(request: Request, max: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) throw new HttpError(415);
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > max)) throw new HttpError(413);
  if (!request.body) throw new HttpError(400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new HttpError(413); }
      chunks.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  } finally { reader.releaseLock(); }
}
async function counter(env: Env, scope: string, identity: string, limit: number, window: number): Promise<void> {
  const now = Date.now();
  const bucket = Math.floor(now / window);
  // Only a short-lived, keyed digest is stored; transport IP never enters an event/archive.
  const key = await sha256(`${env.ARCHIVE_RECEIPT_KEY}\n${scope}\n${bucket}\n${identity}`);
  const row = await env.DB.prepare(`INSERT INTO rate_limits(key,count,expires_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count`).bind(key, (bucket + 1) * window).first<{ count: number }>();
  if (!row || row.count > limit) throw new HttpError(429);
}
async function rateLimit(request: Request, env: Env, scope: "login" | "ingest"): Promise<void> {
  const window = scope === "login" ? 15 * 60_000 : 60_000;
  await counter(env, `${scope}:global`, "all", scope === "login" ? 120 : 2000, window);
  await counter(env, `${scope}:ip`, request.headers.get("CF-Connecting-IP") ?? "local", scope === "login" ? 20 : 60, window);
}
async function authenticate(request: Request, env: Env): Promise<StaffSession> {
  const token = request.headers.get("Cookie")?.split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(401);
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(`SELECT staff.email, sessions.token_hash FROM sessions JOIN staff ON staff.id=sessions.staff_id
    WHERE sessions.token_hash=? AND sessions.expires_at>? AND staff.disabled=0 AND sessions.auth_version=staff.auth_version`).bind(tokenHash, Date.now()).first<StaffSession>();
  if (!row) throw new HttpError(401);
  return row;
}
function cookie(token: string, ttl: number): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
}
async function login(request: Request, env: Env): Promise<Response> {
  sameOrigin(request, env);
  await rateLimit(request, env, "login");
  const value = await readJSON(request, 4096);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(401);
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some(key => key !== "email" && key !== "password") || typeof p.email !== "string"
    || typeof p.password !== "string" || p.email.length > 254 || p.password.length > 256) throw new HttpError(401);
  const identity = p.email.trim().toLowerCase();
  await counter(env, "login:account", identity, 10, 15 * 60_000);
  const staff = await env.DB.prepare("SELECT id,email,password_hash,disabled,auth_version FROM staff WHERE email=? OR username=? LIMIT 1")
    .bind(identity, identity).first<{ id: string; email: string; password_hash: string; disabled: number; auth_version: string }>();
  const valid = await verifyPassword(p.password, staff?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!staff || !valid || staff.disabled) throw new HttpError(401);
  const token = randomToken();
  const ttl = sessionTTL(env);
  // Re-login rotates the presented session as part of the same D1 transaction.
  const oldToken = request.headers.get("Cookie")?.match(/(?:^|;\s*)__Host-phaethon_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE token_hash=? OR expires_at<=?").bind(oldToken ? await sha256(oldToken) : "", Date.now()),
    env.DB.prepare("INSERT INTO sessions(token_hash,staff_id,auth_version,expires_at) VALUES (?,?,?,?)").bind(await sha256(token), staff.id, staff.auth_version, Date.now() + ttl * 1000),
  ]);
  return json({ email: staff.email }, 200, { "Set-Cookie": cookie(token, ttl) });
}
function canonicalEnvelope(e: TelemetryEnvelope): string {
  return JSON.stringify({ v: e.v, id: e.id, sentAt: e.sentAt, publicKey: e.publicKey, payload: e.payload, signature: e.signature });
}
async function rowById(env: Env, id: string): Promise<EventRow | null> {
  return env.DB.prepare("SELECT * FROM events WHERE id=?").bind(id).first<EventRow>();
}
/** Cross-service transaction uses an immutable D1 outbox and create-once R2 object. */
export async function archiveEvent(env: Env, row: EventRow): Promise<void> {
  if (row.archived || !row.pending_json) return;
  if (row.expires_at <= Date.now()) throw new HttpError(410);
  const archive = JSON.stringify({ envelope: JSON.parse(row.pending_json), receipt: JSON.parse(row.receipt_json) });
  const created = await env.RAW.put(row.archive_key, archive, {
    onlyIf: new Headers({ "If-None-Match": "*" }), httpMetadata: { contentType: "application/json" },
  });
  if (!created) {
    const existing = await env.RAW.get(row.archive_key);
    if (!existing || await existing.text() !== archive) throw new Error("Archive mismatch");
  }
  await env.DB.prepare("UPDATE events SET archived=1,pending_json=NULL WHERE id=? AND envelope_hash=?")
    .bind(row.id, row.envelope_hash).run();
  // A retention pass can race an in-flight R2 put. The sorted-key sweep also removes
  // this object if this process terminates before completing the deletion.
  if (row.expires_at <= Date.now() || !await rowById(env, row.id)) await env.RAW.delete(row.archive_key);
}
async function ingest(request: Request, env: Env): Promise<Response> {
  await rateLimit(request, env, "ingest");
  let e: TelemetryEnvelope;
  try { e = parseTelemetryEnvelope(await readJSON(request, MAX_TELEMETRY_BODY_BYTES)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400); }
  if (!await verifyEnvelope(e)) throw new HttpError(400);
  const payload = parseTelemetryPayload(e.payload);
  const encoded = canonicalEnvelope(e);
  const hash = await sha256(encoded);
  const now = Date.now();
  const receivedAt = new Date(now).toISOString();
  const expiresAt = now + retention(env, payload.category) * DAY;
  const receipt = await makeReceipt(env.ARCHIVE_RECEIPT_KEY, e.id, receivedAt, hash);
  const reservation = randomToken();
  // A batch is atomic. Only the winner may install the durable outbox for this UUID/hash.
  await env.DB.batch([
    env.DB.prepare("INSERT INTO replays(id,envelope_hash,reservation_token,expires_at) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .bind(e.id, hash, reservation, Math.max(expiresAt, now + 2 * DAY)),
    env.DB.prepare(`INSERT INTO events(id,category,event,received_at,sent_at,app_version,platform,outcome,expires_at,archive_key,envelope_hash,receipt_json,pending_json)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM replays WHERE id=? AND envelope_hash=? AND reservation_token=?)
      ON CONFLICT(id) DO NOTHING`).bind(e.id, payload.category, payload.event, receivedAt, e.sentAt, payload.appVersion, payload.platform,
      payload.category === "diagnostics" ? payload.data.outcome : null, expiresAt,
      `events/${payload.category === "reports" || payload.category === "traces" ? "content" : "metrics"}/${String(expiresAt).padStart(13, "0")}/${e.id}.json`,
      hash, JSON.stringify(receipt), encoded, e.id, hash, reservation),
  ]);
  const replay = await env.DB.prepare("SELECT envelope_hash FROM replays WHERE id=?").bind(e.id).first<{ envelope_hash: string }>();
  if (!replay || replay.envelope_hash !== hash) throw new HttpError(409);
  const row = await rowById(env, e.id);
  if (!row || row.expires_at <= now) throw new HttpError(410);
  await archiveEvent(env, row);
  return json({ id: e.id, receipt: JSON.parse(row.receipt_json) }, row.archived ? 200 : 201);
}
function daysParam(url: URL, extended = false): number {
  const value = url.searchParams.get("days") ?? "7";
  if (extended ? !/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 3650 : !["7", "30", "90"].includes(value)) throw new HttpError(400);
  return Number(value);
}
function categoryParam(url: URL): TelemetryCategory | null {
  const value = url.searchParams.get("category");
  if (value !== null && !isTelemetryCategory(value)) throw new HttpError(400);
  return value;
}
function cursorParam(url: URL): { time: string; id: string } | null {
  const value = url.searchParams.get("before");
  if (value === null) return null;
  if (value.length > 200) throw new HttpError(400);
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2 || !isTelemetryTimestamp(decoded[0])
      || typeof decoded[1] !== "string" || !TELEMETRY_UUID.test(decoded[1])) throw new Error();
    return { time: decoded[0], id: decoded[1] };
  } catch { throw new HttpError(400); }
}
function cursor(row: EventRow): string { return Buffer.from(JSON.stringify([row.received_at, row.id])).toString("base64url"); }
function metadata(row: EventRow): object {
  return { id: row.id, category: row.category, event: row.event, receivedAt: row.received_at,
    sentAt: row.sent_at, appVersion: row.app_version, platform: row.platform };
}
async function overview(url: URL, env: Env): Promise<Response> {
  const since = new Date(Date.now() - daysParam(url) * DAY).toISOString();
  const query = async <T>(group: string): Promise<T[]> => (await env.DB.prepare(`SELECT ${group},COUNT(*) AS count FROM events
    WHERE archived=1 AND received_at>=? AND expires_at>? GROUP BY ${group}`).bind(since, Date.now()).all<T>()).results;
  const [categories, days, events, outcomes] = await Promise.all([
    query<{ category: TelemetryCategory; count: number }>("category"),
    // Date comes from trusted server time, never from submitted strings.
    env.DB.prepare(`SELECT substr(received_at,1,10) AS day,COUNT(*) AS count FROM events
      WHERE archived=1 AND received_at>=? AND expires_at>? GROUP BY day ORDER BY day`).bind(since, Date.now()).all<{ day: string; count: number }>().then(r => r.results),
    query<{ event: string; count: number }>("event"), query<{ outcome: string | null; count: number }>("outcome"),
  ]);
  const totals = Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, 0]));
  for (const row of categories) totals[row.category] = row.count;
  return json({ totals, days, events, outcomes: outcomes.filter(row => row.outcome !== null) });
}
async function eventPage(url: URL, env: Env, exporting: boolean): Promise<Response> {
  const category = categoryParam(url);
  const before = cursorParam(url);
  const clauses = ["archived=1", "expires_at>?"];
  const values: unknown[] = [Date.now()];
  if (category) { clauses.push("category=?"); values.push(category); }
  clauses.push("received_at>=?"); values.push(new Date(Date.now() - daysParam(url, true) * DAY).toISOString());
  if (before) { clauses.push("(received_at<? OR (received_at=? AND id<?))"); values.push(before.time, before.time, before.id); }
  const result = await env.DB.prepare(`SELECT * FROM events WHERE ${clauses.join(" AND ")} ORDER BY received_at DESC,id DESC LIMIT ?`)
    .bind(...values, PAGE_SIZE + 1).all<EventRow>();
  const rows = result.results.slice(0, PAGE_SIZE);
  const nextCursor = result.results.length > PAGE_SIZE ? cursor(rows[rows.length - 1]) : null;
  if (!exporting) return json({ items: rows.map(metadata), nextCursor });
  // Bound response memory as well as record count; large traces get smaller pages.
  // Validate the whole returned page before sending any content.
  const lines: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const line = JSON.stringify({ ...await rawEvent(env, row), receipt: JSON.parse(row.receipt_json) });
    const size = new TextEncoder().encode(line).byteLength + 1;
    if (bytes + size > EXPORT_PAGE_BYTES && lines.length > 0) break;
    lines.push(line); bytes += size;
  }
  const exportCursor = lines.length < rows.length || nextCursor !== null ? cursor(rows[lines.length - 1]) : null;
  return new Response(lines.length ? `${lines.join("\n")}\n` : "", { headers: {
    "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="phaethon-telemetry.ndjson"',
    "X-Result-Count": String(lines.length), "X-Has-More": String(exportCursor !== null),
    ...(exportCursor ? { "X-Next-Cursor": exportCursor } : {}),
  } });
}
async function rawEvent(env: Env, row: EventRow): Promise<object> {
  const object = await env.RAW.get(row.archive_key);
  if (!object) throw new Error("Archive unavailable");
  const archive = JSON.parse(await object.text()) as { envelope: unknown; receipt: ArchiveReceipt };
  const envelope = parseStoredTelemetryEnvelope(archive.envelope);
  const hash = await sha256(canonicalEnvelope(envelope));
  if (envelope.id !== row.id || hash !== row.envelope_hash || !await verifyEnvelope(envelope)
    || !await verifyReceipt(archive.receipt, env.ARCHIVE_RECEIPT_KEY, env.ARCHIVE_RECEIPT_PREVIOUS_KEYS)
    || archive.receipt.id !== row.id || archive.receipt.envelopeHash !== hash || archive.receipt.receivedAt !== row.received_at
    || JSON.stringify(archive.receipt) !== row.receipt_json) throw new Error("Archive mismatch");
  return { envelope, payload: parseTelemetryPayload(envelope.payload), receivedAt: row.received_at, verification: "self-signed" };
}

/** Bounded cron batches: retention is enforced on reads even if cleanup is behind. */
export async function maintain(env: Env): Promise<void> {
  const now = Date.now();
  const expired = await env.DB.prepare("SELECT * FROM events WHERE expires_at<=? ORDER BY expires_at LIMIT 100").bind(now).all<EventRow>();
  for (const row of expired.results) {
    // Delete R2 first; a crash leaves an invisible expired row for the next cleanup pass.
    try { await env.RAW.delete(row.archive_key); } catch { /* Expiry-key sweep and bucket lifecycle retry deletion. */ }
  }
  // Remove expired content even during R2 outages. A single indexed SQL operation
  // clears up to 20k rows; orphan objects remain discoverable by their expiry keys.
  await env.DB.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events WHERE expires_at<=? ORDER BY expires_at LIMIT 20000)").bind(now).run();
  const pending = await env.DB.prepare("SELECT * FROM events WHERE archived=0 AND expires_at>? LIMIT 50").bind(now).all<EventRow>();
  for (const row of pending.results) {
    try { await archiveEvent(env, row); } catch { /* Durable outbox retries on the next scheduled run. */ }
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<=?").bind(now),
    env.DB.prepare("DELETE FROM replays WHERE expires_at<=? AND NOT EXISTS (SELECT 1 FROM events WHERE events.id=replays.id)").bind(now),
  ]);
  // Keys sort by expiry. This catches orphan objects from crashes after a put and
  // concurrent expiry cleanup, even if the corresponding D1 row no longer exists.
  for (const kind of ["content", "metrics"]) {
    const objects = await env.RAW.list({ prefix: `events/${kind}/`, limit: 100 });
    for (const object of objects.objects) {
      const expiry = Number(object.key.split("/")[2]);
      if (expiry > now) break;
      if (Number.isSafeInteger(expiry) && expiry > 0) await env.RAW.delete(object.key);
    }
  }
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") {
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Console assets unavailable", { status: 404 });
  }
  if (url.pathname === "/api/ingest" && request.method === "POST") return ingest(request, env);
  if (url.pathname === "/api/login" && request.method === "POST") return login(request, env);
  const session = await authenticate(request, env);
  if (url.pathname === "/api/session" && request.method === "GET") return json({ email: session.email });
  if (url.pathname === "/api/logout" && request.method === "POST") {
    sameOrigin(request, env);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(session.token_hash).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });
  }
  if (request.method !== "GET") throw new HttpError(405);
  if (url.pathname === "/api/overview") return overview(url, env);
  if (url.pathname === "/api/events") return eventPage(url, env, false);
  if (url.pathname === "/api/export") return eventPage(url, env, true);
  const match = /^\/api\/events\/([0-9a-f-]+)$/.exec(url.pathname);
  if (match && TELEMETRY_UUID.test(match[1])) {
    const row = await rowById(env, match[1]);
    if (!row || !row.archived || row.expires_at <= Date.now()) throw new HttpError(404);
    return json(await rawEvent(env, row), 200, { "X-Archive-Receipt": Buffer.from(row.receipt_json).toString("base64url") });
  }
  throw new HttpError(404);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try { response = await route(request, env); }
    catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      response = json({ error: status === 401 ? "Unauthorized" : status === 429 ? "Too many requests" : status === 503 ? "Temporarily unavailable" : "Request rejected" }, status,
        status === 429 || status === 503 ? { "Retry-After": status === 429 ? "900" : "30" } : undefined);
    }
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    if (new URL(request.url).protocol === "https:") headers.set("Strict-Transport-Security", "max-age=31536000");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller: unknown, env: Env): Promise<void> { await maintain(env); },
};
