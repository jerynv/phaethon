import {
  MAX_TELEMETRY_BODY_BYTES,
  parseTelemetryEnvelope,
  parseTelemetryPayload,
  type TelemetryEnvelope,
} from "../../src/shared/telemetry.ts";
import { archiveEvent, archiveKey, canonicalEnvelope, findEvent } from "./archive.ts";
import { rateLimit } from "./auth.ts";
import type { Env } from "./bindings.ts";
import { makeReceipt, randomToken, sha256, verifyEnvelope } from "./crypto.ts";
import { HttpError, json, readJSON } from "./http.ts";
import { DAY_MS, retentionDays } from "./settings.ts";

async function readEnvelope(request: Request): Promise<TelemetryEnvelope> {
  const body = await readJSON(request, MAX_TELEMETRY_BODY_BYTES);
  try {
    return parseTelemetryEnvelope(body);
  } catch {
    throw new HttpError(400);
  }
}

/**
 * Accepts one signed envelope. Retrying the same envelope is idempotent and returns the same
 * receipt (200 once already archived); reusing its UUID for different content is a 409.
 */
export async function ingest(request: Request, env: Env): Promise<Response> {
  await rateLimit(request, env, "ingest");
  const envelope = await readEnvelope(request);
  if (!(await verifyEnvelope(envelope))) throw new HttpError(400);

  const payload = parseTelemetryPayload(envelope.payload);
  const encoded = canonicalEnvelope(envelope);
  const hash = await sha256(encoded);
  const now = Date.now();
  const receivedAt = new Date(now).toISOString();
  const expiresAt = now + retentionDays(env, payload.category) * DAY_MS;
  const receipt = await makeReceipt(env.ARCHIVE_RECEIPT_KEY, envelope.id, receivedAt, hash);
  const outcome = payload.category === "diagnostics" ? payload.data.outcome : null;
  const reservation = randomToken();

  // The batch is atomic, and the event insert requires this request's reservation, so when the
  // same UUID arrives concurrently only the request that claimed the replay row installs the outbox.
  // The replay row outlives the envelope's 24-hour freshness window even under short retention,
  // so a deleted event can't be submitted again.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO replays(id, envelope_hash, reservation_token, expires_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(envelope.id, hash, reservation, Math.max(expiresAt, now + 2 * DAY_MS)),
    env.DB.prepare(
      `INSERT INTO events(id, category, event, received_at, sent_at, app_version, platform, outcome,
         expires_at, archive_key, envelope_hash, receipt_json, pending_json)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM replays WHERE id = ? AND envelope_hash = ? AND reservation_token = ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      envelope.id,
      payload.category,
      payload.event,
      receivedAt,
      envelope.sentAt,
      payload.appVersion,
      payload.platform,
      outcome,
      expiresAt,
      archiveKey(payload.category, expiresAt, envelope.id),
      hash,
      JSON.stringify(receipt),
      encoded,
      envelope.id,
      hash,
      reservation,
    ),
  ]);

  const replay = await env.DB.prepare("SELECT envelope_hash FROM replays WHERE id = ?")
    .bind(envelope.id)
    .first<{ envelope_hash: string }>();
  if (!replay || replay.envelope_hash !== hash) throw new HttpError(409);
  const row = await findEvent(env, envelope.id);
  if (!row || row.expires_at <= now) throw new HttpError(410);
  await archiveEvent(env, row);
  return json({ id: envelope.id, receipt: JSON.parse(row.receipt_json) }, row.archived ? 200 : 201);
}
