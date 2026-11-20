import { ARCHIVE_PREFIXES, archiveEvent, archiveKeyExpiry, type EventRow } from "./archive.ts";
import type { Env } from "./bindings.ts";

/**
 * Cron job, in bounded batches. Reads enforce retention themselves, so falling behind here
 * never exposes expired events.
 */
export async function maintain(env: Env): Promise<void> {
  const now = Date.now();
  await deleteExpiredEvents(env, now);
  await retryOutbox(env, now);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= ?").bind(now),
    env.DB.prepare(
      `DELETE FROM replays WHERE expires_at <= ?
       AND NOT EXISTS (SELECT 1 FROM events WHERE events.id = replays.id)`,
    ).bind(now),
  ]);
  await sweepExpiredObjects(env, now);
}

async function deleteExpiredEvents(env: Env, now: number): Promise<void> {
  const expired = await env.DB.prepare(
    "SELECT * FROM events WHERE expires_at <= ? ORDER BY expires_at LIMIT 100",
  )
    .bind(now)
    .all<EventRow>();
  // R2 goes first: if this run dies midway, the row stays (unreadable, since it's expired)
  // and the next run tries again.
  for (const row of expired.results) {
    try {
      await env.RAW.delete(row.archive_key);
    } catch {
      // The expiry-ordered key sweep retries the delete.
    }
  }
  // Rows are deleted even when R2 is down; any objects left behind are still found by
  // sweepExpiredObjects through their expiry-ordered keys.
  await env.DB.prepare(
    `DELETE FROM events WHERE id IN
       (SELECT id FROM events WHERE expires_at <= ? ORDER BY expires_at LIMIT 20000)`,
  )
    .bind(now)
    .run();
}

async function retryOutbox(env: Env, now: number): Promise<void> {
  const pending = await env.DB.prepare("SELECT * FROM events WHERE archived = 0 AND expires_at > ? LIMIT 50")
    .bind(now)
    .all<EventRow>();
  for (const row of pending.results) {
    try {
      await archiveEvent(env, row);
    } catch {
      // The row stays in the outbox for the next run.
    }
  }
}

/**
 * Removes expired objects whose D1 row is already gone: left by a crash after a put, or by
 * expiry cleanup racing an in-flight archive. Keys sort by expiry, so each prefix's listing
 * stops at the first object that hasn't expired.
 */
async function sweepExpiredObjects(env: Env, now: number): Promise<void> {
  for (const prefix of ARCHIVE_PREFIXES) {
    const { objects } = await env.RAW.list({ prefix, limit: 100 });
    for (const object of objects) {
      const expiry = archiveKeyExpiry(object.key);
      if (expiry > now) break;
      if (Number.isSafeInteger(expiry) && expiry > 0) await env.RAW.delete(object.key);
    }
  }
}
