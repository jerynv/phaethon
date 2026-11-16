import path from "node:path";
import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";
import { readSettings } from "../settings/settings.ts";

/**
 * Timed and contextual memories: the front burner and its archive, in
 * `<vault>/.phaethon/memories.json`. Unlike MEMORY.md (kept facts, always
 * read), these are only put in front of the model when a message makes them
 * relevant (relevance.ts), and they die off: an event once its outcome is
 * known, a state once its window ends, a task once done. A closed item keeps
 * the conversation it came from, so `recall` still finds it.
 */

export type MemoryKind = "event" | "state" | "task" | "note";
export const MEMORY_KINDS: readonly MemoryKind[] = ["event", "state", "task", "note"];
export type MemoryStatus = "active" | "done" | "expired" | "dismissed";
export type MemoryScope = "space" | "vault";

export type MemoryItem = {
  id: string;
  kind: MemoryKind;
  /** The gist, one line, in plain words. */
  text: string;
  /** Why it matters: for a note, the underlying dynamic rather than what was said. */
  why?: string;
  /** The space it came from. */
  space: string;
  /** "vault" items (sick, travelling) may reach other spaces when the setting allows. */
  scope: MemoryScope;
  created: number;
  updated: number;
  /** When an event happens or a task is due (ms). */
  when?: number;
  /** When a state or note stops mattering (ms). */
  until?: number;
  status: MemoryStatus;
  /** How it ended ("attended, went well", "rescheduled to Monday"). */
  outcome?: string;
  closed?: number;
  keywords: string[];
  /** Person ids (people/). */
  people: string[];
  /** The conversation it was mentioned in. */
  source?: { space: string; thread: string };
  origin: "agent" | "user" | "review";
  /** When a reminder for it was shown (so it is shown once). */
  reminded?: number;
};

/** How long after its time an event with no outcome stays on the front burner. */
export const DEFAULT_EVENT_GRACE_DAYS = 3;
/** How long a closed item stays in the archive. 0 keeps it for good. */
export const DEFAULT_ARCHIVE_DAYS = 90;
/** A state with no stated end. */
export const DEFAULT_STATE_HOURS = 24;
/** A task past its due date expires after this many days. */
const TASK_OVERDUE_DAYS = 14;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const MAX_TEXT = 280;
const MAX_ITEMS = 2000;

export type MemorySettings = {
  /** Agents may remember things (the remember/update_memory tools). */
  capture: boolean;
  /** The daily review job reads new conversations for memories. */
  review: boolean;
  /** Vault-scoped items reach the other spaces. */
  shareAcrossSpaces: boolean;
  /** Agents may add to the global and space profiles. */
  profileLearning: boolean;
  eventGraceDays: number;
  archiveDays: number;
  /** Spaces that never see vault-scoped items from elsewhere. */
  isolatedSpaces: string[];
};

export const DEFAULT_MEMORY_SETTINGS: Readonly<MemorySettings> = Object.freeze({
  capture: true,
  review: true,
  shareAcrossSpaces: true,
  profileLearning: true,
  eventGraceDays: DEFAULT_EVENT_GRACE_DAYS,
  archiveDays: DEFAULT_ARCHIVE_DAYS,
  isolatedSpaces: [],
});

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : d);

/** `memory` in settings.json, each field checked on its own. */
export function parseMemorySettings(raw: unknown): MemorySettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const bool = (k: keyof MemorySettings) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (DEFAULT_MEMORY_SETTINGS[k] as boolean));
  return {
    capture: bool("capture"),
    review: bool("review"),
    shareAcrossSpaces: bool("shareAcrossSpaces"),
    profileLearning: bool("profileLearning"),
    eventGraceDays: num(o.eventGraceDays, 0, 60, DEFAULT_EVENT_GRACE_DAYS),
    archiveDays: num(o.archiveDays, 0, 3650, DEFAULT_ARCHIVE_DAYS),
    isolatedSpaces: Array.isArray(o.isolatedSpaces) ? o.isolatedSpaces.filter((s): s is string => typeof s === "string").slice(0, 200) : [],
  };
}

export function memorySettings(): MemorySettings {
  return parseMemorySettings(readSettings().memory);
}

export function memoriesFile(): string {
  return path.join(vaultStateDir(), "memories.json");
}

export function newId(prefix = "m"): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}

const str = (v: unknown, max = MAX_TEXT) => (typeof v === "string" && v.trim() ? [...v.trim()].slice(0, max).join("") : undefined);
const time = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const strings = (v: unknown, max = 24) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()).slice(0, max) : []);

/** One stored item, or null when it can't be one. Hand edits that break a field drop only that field. */
export function parseItem(raw: unknown): MemoryItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = str(o.id, 64);
  const text = str(o.text);
  const space = str(o.space, 64);
  if (!id || !text || !space) return null;
  const kind = MEMORY_KINDS.includes(o.kind as MemoryKind) ? (o.kind as MemoryKind) : "note";
  const status = (["active", "done", "expired", "dismissed"] as const).includes(o.status as MemoryStatus) ? (o.status as MemoryStatus) : "active";
  const created = time(o.created) ?? Date.now();
  const src = o.source && typeof o.source === "object" ? (o.source as Record<string, unknown>) : undefined;
  return {
    id,
    kind,
    text,
    ...(str(o.why) ? { why: str(o.why) } : {}),
    space,
    scope: o.scope === "vault" ? "vault" : "space",
    created,
    updated: time(o.updated) ?? created,
    ...(time(o.when) ? { when: time(o.when) } : {}),
    ...(time(o.until) ? { until: time(o.until) } : {}),
    status,
    ...(str(o.outcome) ? { outcome: str(o.outcome) } : {}),
    ...(time(o.closed) ? { closed: time(o.closed) } : {}),
    keywords: strings(o.keywords).map((k) => k.toLowerCase()),
    people: strings(o.people),
    ...(src && typeof src.space === "string" && typeof src.thread === "string" ? { source: { space: src.space, thread: src.thread } } : {}),
    origin: o.origin === "user" || o.origin === "review" ? o.origin : "agent",
    ...(time(o.reminded) ? { reminded: time(o.reminded) } : {}),
  };
}

export function readItems(): MemoryItem[] {
  let doc: unknown;
  try {
    doc = readJson<unknown>(memoriesFile(), { items: [] });
  } catch {
    return [];
  }
  const list = doc && typeof doc === "object" && Array.isArray((doc as { items?: unknown }).items) ? (doc as { items: unknown[] }).items : [];
  return list.map(parseItem).filter((x): x is MemoryItem => x !== null);
}

export function writeItems(items: MemoryItem[]): void {
  writeJsonAtomic(memoriesFile(), { version: 1, items: items.slice(-MAX_ITEMS) }, { newline: true });
}

/** Read, change, write; returns what `f` returns. */
export function mutateItems<T>(f: (items: MemoryItem[]) => T): T {
  const items = readItems();
  const out = f(items);
  writeItems(items);
  return out;
}

/** Whether an event's time has passed and it is waiting to hear how it went. */
export function awaitingOutcome(item: MemoryItem, now: number): boolean {
  return item.status === "active" && item.kind === "event" && item.when !== undefined && now > item.when + HOUR;
}

/**
 * Closes what has died off. Returns the ids it changed. Pure apart from the
 * array it is given:
 * - a state or note ends at `until`;
 * - an event with no outcome ends `graceDays` after its time;
 * - a task ends 14 days past its due date;
 * - closed items leave the archive after `archiveDays` (0 keeps them).
 */
export function sweep(items: MemoryItem[], now: number, s: Pick<MemorySettings, "eventGraceDays" | "archiveDays"> = DEFAULT_MEMORY_SETTINGS): { expired: string[]; purged: string[] } {
  const expired: string[] = [];
  for (const it of items) {
    if (it.status !== "active") continue;
    let end: number | undefined;
    if ((it.kind === "state" || it.kind === "note") && it.until !== undefined) end = it.until;
    else if (it.kind === "event" && it.when !== undefined) end = it.when + Math.max(s.eventGraceDays, 0) * DAY + HOUR;
    else if (it.kind === "task" && it.when !== undefined) end = it.when + TASK_OVERDUE_DAYS * DAY;
    if (end !== undefined && now > end) {
      it.status = "expired";
      it.closed = now;
      it.updated = now;
      if (it.kind === "event" && !it.outcome) it.outcome = "No outcome was recorded.";
      expired.push(it.id);
    }
  }
  const purged: string[] = [];
  if (s.archiveDays > 0) {
    const cutoff = now - s.archiveDays * DAY;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.status !== "active" && (it.closed ?? it.updated) < cutoff) {
        purged.push(it.id);
        items.splice(i, 1);
      }
    }
  }
  return { expired, purged };
}

/** Whether `item` may be seen from `space` under these settings. */
export function visibleIn(item: MemoryItem, space: string, s: Pick<MemorySettings, "shareAcrossSpaces" | "isolatedSpaces"> = DEFAULT_MEMORY_SETTINGS): boolean {
  if (item.space === space) return true;
  return item.scope === "vault" && s.shareAcrossSpaces && !s.isolatedSpaces.includes(space);
}

export function itemsFor(space: string, opts: { includeClosed?: boolean } = {}): MemoryItem[] {
  const s = memorySettings();
  return readItems().filter((it) => visibleIn(it, space, s) && (opts.includeClosed || it.status === "active"));
}

/** The sweep job: expire and purge, write only when something changed. */
export function sweepNow(now = Date.now()): { expired: string[]; purged: string[] } {
  const items = readItems();
  const out = sweep(items, now, memorySettings());
  if (out.expired.length || out.purged.length) writeItems(items);
  return out;
}

const fmt = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function formatWhen(ms: number): string {
  return fmt.format(new Date(ms));
}

/** One line for a prompt or a tool result. */
export function describeItem(it: MemoryItem, now: number): string {
  const parts = [`[${it.id}] ${it.kind}: ${it.text}`];
  if (it.why) parts.push(`(why: ${it.why})`);
  if (it.when !== undefined) parts.push(`${it.kind === "task" ? "due" : "at"} ${formatWhen(it.when)}`);
  if (it.until !== undefined) parts.push(`until ${formatWhen(it.until)}`);
  if (awaitingOutcome(it, now)) parts.push("— has passed; outcome not known yet");
  if (it.status !== "active") parts.push(`— ${it.status}${it.outcome ? `: ${it.outcome}` : ""}`);
  return parts.join(" ");
}

export const _test = { HOUR, DAY, TASK_OVERDUE_DAYS };
