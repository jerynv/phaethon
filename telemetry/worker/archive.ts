import {
  parseStoredTelemetryEnvelope,
  parseTelemetryPayload,
  type TelemetryCategory,
  type TelemetryEnvelope,
  type TelemetryPayload,
} from "../../src/shared/telemetry.ts";
import type { Env } from "./bindings.ts";
import { sha256, verifyEnvelope, verifyReceipt, type ArchiveReceipt } from "./crypto.ts";
import { HttpError } from "./http.ts";
import { isContentCategory } from "./settings.ts";

export interface EventRow {
  id: string;
  category: TelemetryCategory;
  event: string;
  received_at: string;
  sent_at: string;
  app_version: string;
  platform: string;
  outcome: string | null;
  expires_at: number;
  archive_key: string;
  envelope_hash: string;
  receipt_json: string;
  /** The outbox: the canonical envelope, kept until the R2 copy is confirmed. */
  pending_json: string | null;
  archived: number;
}

export interface ArchivedEvent {
  envelope: TelemetryEnvelope;
  payload: TelemetryPayload;
  receivedAt: string;
  verification: "self-signed";
}

export const ARCHIVE_PREFIXES = ["events/content/", "events/metrics/"];

/** Keys sort by expiry time, so the cron sweep can find expired objects without consulting D1. */
export function archiveKey(category: TelemetryCategory, expiresAt: number, id: string): string {
  const kind = isContentCategory(category) ? "content" : "metrics";
  return `events/${kind}/${String(expiresAt).padStart(13, "0")}/${id}.json`;
}

export function archiveKeyExpiry(key: string): number {
  return Number(key.split("/")[2]);
}

/** Fixed field order, so the envelope hash doesn't depend on how a client ordered its JSON. */
export function canonicalEnvelope(e: TelemetryEnvelope): string {
  return JSON.stringify({
    v: e.v,
    id: e.id,
    sentAt: e.sentAt,
    publicKey: e.publicKey,
    payload: e.payload,
    signature: e.signature,
  });
}

export function findEvent(env: Env, id: string): Promise<EventRow | null> {
  return env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(id).first<EventRow>();
}

/**
 * Copies an event from its D1 outbox to R2, then clears the outbox. D1 and R2 share no
 * transaction, so the outbox row is the durable record until the create-once R2 object exists,
 * and the cron job retries any event left unarchived.
 */
export async function archiveEvent(env: Env, row: EventRow): Promise<void> {
  if (row.archived || !row.pending_json) return;
  if (row.expires_at <= Date.now()) throw new HttpError(410);
  const archive = JSON.stringify({
    envelope: JSON.parse(row.pending_json),
    receipt: JSON.parse(row.receipt_json),
  });
  // If-None-Match: * makes the put create-only: a retry or a concurrent request never overwrites
  // an archived object, and instead checks that the stored copy is identical.
  const created = await env.RAW.put(row.archive_key, archive, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/json" },
  });
  if (!created) {
    const existing = await env.RAW.get(row.archive_key);
    if (!existing || (await existing.text()) !== archive) throw new Error("Archive mismatch");
  }
  await env.DB.prepare(
    "UPDATE events SET archived = 1, pending_json = NULL WHERE id = ? AND envelope_hash = ?",
  )
    .bind(row.id, row.envelope_hash)
    .run();
  // Retention cleanup can delete the row while the put is in flight. If this process dies before
  // the delete below, the expiry-ordered key sweep in maintain() removes the object instead.
  if (row.expires_at <= Date.now() || !(await findEvent(env, row.id))) {
    await env.RAW.delete(row.archive_key);
  }
}

/** Reads an event back from R2 and checks it against its D1 row, signature and receipt. */
export async function readArchivedEvent(env: Env, row: EventRow): Promise<ArchivedEvent> {
  const object = await env.RAW.get(row.archive_key);
  if (!object) throw new Error("Archive unavailable");
  const archive = JSON.parse(await object.text()) as { envelope: unknown; receipt: ArchiveReceipt };
  const envelope = parseStoredTelemetryEnvelope(archive.envelope);
  const hash = await sha256(canonicalEnvelope(envelope));
  if (envelope.id !== row.id || hash !== row.envelope_hash || !(await verifyEnvelope(envelope))) {
    throw new Error("Archive mismatch");
  }

  const { receipt } = archive;
  const receiptValid = await verifyReceipt(
    receipt,
    env.ARCHIVE_RECEIPT_KEY,
    env.ARCHIVE_RECEIPT_PREVIOUS_KEYS,
  );
  const receiptMatchesRow =
    receiptValid &&
    receipt.id === row.id &&
    receipt.envelopeHash === hash &&
    receipt.receivedAt === row.received_at &&
    JSON.stringify(receipt) === row.receipt_json;
  if (!receiptMatchesRow) throw new Error("Archive mismatch");

  return {
    envelope,
    payload: parseTelemetryPayload(envelope.payload),
    receivedAt: row.received_at,
    verification: "self-signed",
  };
}
