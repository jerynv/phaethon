import {
  isTelemetryCategory,
  isTelemetryTimestamp,
  TELEMETRY_CATEGORIES,
  TELEMETRY_UUID,
  type TelemetryCategory,
} from "../../src/shared/telemetry.ts";
import { findEvent, readArchivedEvent, type EventRow } from "./archive.ts";
import type { Env } from "./bindings.ts";
import { HttpError, json } from "./http.ts";
import { DAY_MS } from "./settings.ts";

const PAGE_SIZE = 50;
const EXPORT_PAGE_BYTES = 4 * 1024 * 1024;
const OVERVIEW_DAYS = ["7", "30", "90"];
const MAX_DAYS = 3650;
const encoder = new TextEncoder();

/** The overview offers fixed ranges; event lists and exports accept any range up to MAX_DAYS. */
function daysParam(url: URL, anyRange: boolean): number {
  const value = url.searchParams.get("days") ?? "7";
  const valid = anyRange
    ? /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_DAYS
    : OVERVIEW_DAYS.includes(value);
  if (!valid) throw new HttpError(400);
  return Number(value);
}

function categoryParam(url: URL): TelemetryCategory | null {
  const value = url.searchParams.get("category");
  if (value !== null && !isTelemetryCategory(value)) throw new HttpError(400);
  return value;
}

interface Cursor {
  time: string;
  id: string;
}

/** Cursors are base64url JSON `[received_at, id]` of the last row on the previous page. */
function encodeCursor(row: EventRow): string {
  return Buffer.from(JSON.stringify([row.received_at, row.id])).toString("base64url");
}

function isCursorPair(value: unknown): value is [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isTelemetryTimestamp(value[0]) &&
    typeof value[1] === "string" &&
    TELEMETRY_UUID.test(value[1])
  );
}

function cursorParam(url: URL): Cursor | null {
  const value = url.searchParams.get("before");
  if (value === null) return null;
  if (value.length > 200) throw new HttpError(400);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new HttpError(400);
  }
  if (!isCursorPair(decoded)) throw new HttpError(400);
  return { time: decoded[0], id: decoded[1] };
}

function metadata(row: EventRow): object {
  return {
    id: row.id,
    category: row.category,
    event: row.event,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    appVersion: row.app_version,
    platform: row.platform,
  };
}

/** Counts of archived, unexpired events, by category, day, event and diagnostics outcome. */
export async function overview(url: URL, env: Env): Promise<Response> {
  const since = new Date(Date.now() - daysParam(url, false) * DAY_MS).toISOString();
  const countBy = async <T>(column: string): Promise<T[]> => {
    const { results } = await env.DB.prepare(
      `SELECT ${column}, COUNT(*) AS count FROM events
       WHERE archived = 1 AND received_at >= ? AND expires_at > ?
       GROUP BY ${column}`,
    )
      .bind(since, Date.now())
      .all<T>();
    return results;
  };
  // received_at is server time in ISO 8601, so its first ten characters are the UTC date.
  const countByDay = async (): Promise<Array<{ day: string; count: number }>> => {
    const { results } = await env.DB.prepare(
      `SELECT substr(received_at, 1, 10) AS day, COUNT(*) AS count FROM events
       WHERE archived = 1 AND received_at >= ? AND expires_at > ?
       GROUP BY day ORDER BY day`,
    )
      .bind(since, Date.now())
      .all<{ day: string; count: number }>();
    return results;
  };

  const [categories, days, events, outcomes] = await Promise.all([
    countBy<{ category: TelemetryCategory; count: number }>("category"),
    countByDay(),
    countBy<{ event: string; count: number }>("event"),
    countBy<{ outcome: string | null; count: number }>("outcome"),
  ]);
  const totals = Object.fromEntries(TELEMETRY_CATEGORIES.map(category => [category, 0]));
  for (const row of categories) totals[row.category] = row.count;
  return json({ totals, days, events, outcomes: outcomes.filter(row => row.outcome !== null) });
}

/** One page of archived, unexpired events, newest first. */
async function eventPage(url: URL, env: Env): Promise<{ rows: EventRow[]; hasMore: boolean }> {
  const category = categoryParam(url);
  const before = cursorParam(url);
  const since = new Date(Date.now() - daysParam(url, true) * DAY_MS).toISOString();

  const clauses = ["archived = 1", "expires_at > ?"];
  const values: unknown[] = [Date.now()];
  if (category) {
    clauses.push("category = ?");
    values.push(category);
  }
  clauses.push("received_at >= ?");
  values.push(since);
  if (before) {
    clauses.push("(received_at < ? OR (received_at = ? AND id < ?))");
    values.push(before.time, before.time, before.id);
  }

  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE ${clauses.join(" AND ")}
     ORDER BY received_at DESC, id DESC LIMIT ?`,
  )
    .bind(...values, PAGE_SIZE + 1)
    .all<EventRow>();
  return { rows: results.slice(0, PAGE_SIZE), hasMore: results.length > PAGE_SIZE };
}

export async function listEvents(url: URL, env: Env): Promise<Response> {
  const { rows, hasMore } = await eventPage(url, env);
  const nextCursor = hasMore ? encodeCursor(rows[rows.length - 1]) : null;
  return json({ items: rows.map(metadata), nextCursor });
}

/** NDJSON of full, verified events with their receipts. */
export async function exportEvents(url: URL, env: Env): Promise<Response> {
  const { rows, hasMore } = await eventPage(url, env);
  // Pages are capped by size as well as count, so large traces get shorter pages. Every line is
  // read and verified before the response starts, so a tampered archive fails the whole page.
  const lines: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const event = await readArchivedEvent(env, row);
    const line = JSON.stringify({ ...event, receipt: JSON.parse(row.receipt_json) });
    const size = encoder.encode(line).byteLength + 1;
    if (bytes + size > EXPORT_PAGE_BYTES && lines.length > 0) break;
    lines.push(line);
    bytes += size;
  }

  const truncated = lines.length < rows.length || hasMore;
  const nextCursor = truncated ? encodeCursor(rows[lines.length - 1]) : null;
  const headers: Record<string, string> = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": 'attachment; filename="phaethon-telemetry.ndjson"',
    "X-Result-Count": String(lines.length),
    "X-Has-More": String(nextCursor !== null),
  };
  if (nextCursor) headers["X-Next-Cursor"] = nextCursor;
  const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return new Response(body, { headers });
}

export async function eventDetail(env: Env, id: string): Promise<Response> {
  const row = await findEvent(env, id);
  if (!row || !row.archived || row.expires_at <= Date.now()) throw new HttpError(404);
  const event = await readArchivedEvent(env, row);
  const receipt = Buffer.from(row.receipt_json).toString("base64url");
  return json(event, 200, { "X-Archive-Receipt": receipt });
}
