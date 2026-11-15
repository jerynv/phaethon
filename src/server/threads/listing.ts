import fs from "node:fs";
import path from "node:path";
import { isValidThreadId, replaceFresh } from "../core/thread.ts";
import { log } from "../log.ts";

/**
 * A space's conversation summaries, kept in `.phaethon/threads/index` so a
 * listing reads only the conversations that changed since the last one.
 *
 * Each entry holds what a summary needs from a conversation's file (its
 * title from the first message or an import record, and its message count)
 * and from its `.meta` (title, pin, writes allowed), each with the stamp
 * (mtime, ctime, size) of the file it came from. A listing stats every file
 * and re-reads one only when its stamp differs, so an edit by another
 * process, a sync or a text editor is picked up on the next listing.
 *
 * The index is derived and disposable: a missing, damaged, linked or foreign
 * one is ignored and rebuilt from the files, it is only ever replaced
 * through a fresh temporary file and a rename (never written through a
 * link), and nothing about permissions is decided from it. Its name doesn't
 * end in `.json`, so cores from before it never list it as a conversation.
 */

export const INDEX_NAME = "index";
const VERSION = 1;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_TITLE = 400;

type Stamp = { mtimeMs: number; ctimeMs: number; size: number };

/** What a summary needs from a conversation's file. `keep: false` marks a result from an error that may pass (it isn't cached). */
export type Content = { title: string; messages: number; keep?: boolean };

/** What the person set by hand, as read from a conversation's `.meta`. */
export type MetaView = { title?: string; pinned?: number; allowWrites?: number };

type MetaEntry = MetaView & Stamp;
type Entry = Stamp & { id: string; title: string; messages: number; meta?: MetaEntry };

/** One listed conversation: its content summary, its meta (empty without a `.meta`), and its file's mtime. */
export type Row = { id: string; title: string; messages: number; meta: MetaView; mtimeMs: number };

/** How a listing reads a conversation's file and its `.meta` when the index doesn't hold them. */
export type Sources = { content(file: string): Content; meta(file: string): MetaView };

/** Counters for tests and diagnostics: files read because the index didn't hold them, and index reads and writes. */
export const indexStats = { contentReads: 0, metaReads: 0, indexReads: 0, indexWrites: 0 };

/** The last index this process read or wrote, per index path, with the stamp it had then. */
const memo = new Map<string, { stamp: Stamp; entries: Map<string, Entry> }>();

const stampOf = (st: fs.Stats): Stamp => ({ mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, size: st.size });
const sameStamp = (a: Stamp | undefined, b: Stamp) => !!a && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.size === b.size;

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const positive = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const isStamp = (o: Record<string, unknown>) => finite(o.mtimeMs) && finite(o.ctimeMs) && count(o.size);

function metaEntry(v: unknown): MetaEntry | undefined | null {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isStamp(o)) return null;
  const out: MetaEntry = { mtimeMs: o.mtimeMs as number, ctimeMs: o.ctimeMs as number, size: o.size as number };
  if (o.title !== undefined) {
    if (typeof o.title !== "string" || !o.title || o.title.length > MAX_TITLE) return null;
    out.title = o.title;
  }
  for (const key of ["pinned", "allowWrites"] as const) {
    if (o[key] === undefined) continue;
    if (!positive(o[key])) return null;
    out[key] = o[key] as number;
  }
  return out;
}

/** An index entry checked field by field; null drops it (its conversation is read again). */
function entry(v: unknown): Entry | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!isValidThreadId(o.id) || typeof o.title !== "string" || o.title.length > MAX_TITLE || !count(o.messages) || !isStamp(o)) return null;
  const meta = metaEntry(o.meta);
  if (meta === null) return null;
  const out: Entry = { id: o.id, title: o.title, messages: o.messages, mtimeMs: o.mtimeMs as number, ctimeMs: o.ctimeMs as number, size: o.size as number };
  if (meta) out.meta = meta;
  return out;
}

/** The entries of an index file's text; a damaged entry is dropped, a damaged file gives none. `whole` is false when anything was dropped. */
function parseIndex(text: string): { entries: Map<string, Entry>; whole: boolean } {
  const entries = new Map<string, Entry>();
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { entries, whole: false };
  }
  const o = v as { v?: unknown; threads?: unknown } | null;
  if (!o || typeof o !== "object" || o.v !== VERSION || !Array.isArray(o.threads)) return { entries, whole: false };
  let whole = true;
  for (const raw of o.threads) {
    const e = entry(raw);
    if (e && !entries.has(e.id)) entries.set(e.id, e);
    else whole = false;
  }
  return { entries, whole };
}

/** The index file's text, never through a link; null when it isn't a plain file there. */
function readIndexText(p: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(p, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_INDEX_BYTES) return null;
    return fs.readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function lstatQuiet(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** The index as it is on disk now: the memo when its stamp still matches, else read again. `fresh` is false when it has to be rewritten. */
function loadIndex(p: string): { entries: Map<string, Entry>; fresh: boolean } {
  const st = lstatQuiet(p);
  if (!st) return { entries: new Map(), fresh: false };
  // A link or a folder at its name isn't followed; it is replaced (a rename swaps the link itself, never its target).
  if (!st.isFile()) return { entries: new Map(), fresh: false };
  const known = memo.get(p);
  if (known && sameStamp(known.stamp, stampOf(st))) return { entries: known.entries, fresh: true };
  indexStats.indexReads++;
  const text = readIndexText(p);
  if (text === null) return { entries: new Map(), fresh: false };
  const { entries, whole } = parseIndex(text);
  return { entries, fresh: whole };
}

function saveIndex(p: string, entries: Map<string, Entry>): void {
  const threads = [...entries.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  try {
    replaceFresh(p, `${JSON.stringify({ v: VERSION, threads })}\n`);
    indexStats.indexWrites++;
    const st = lstatQuiet(p);
    if (st?.isFile()) memo.set(p, { stamp: stampOf(st), entries });
    else memo.delete(p);
  } catch (e) {
    // Only slower: the next listing reads what changed again.
    memo.delete(p);
    log.debug("couldn't save the conversation index", { error: (e as Error).message });
  }
}

/**
 * Every saved conversation in `threads` (a folder already checked by
 * `threadsDirIn`) with its summary parts, in no particular order. Only
 * conversations and `.meta` files whose stamp changed since the index was
 * saved are read; the index is saved again when anything changed.
 */
export function indexedRows(threads: string, sources: Sources): Row[] {
  let names: string[];
  try {
    names = fs.readdirSync(threads);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const ids: string[] = [];
  const metas = new Set<string>();
  for (const n of names) {
    if (n.endsWith(".json")) {
      const id = n.slice(0, -5);
      if (isValidThreadId(id)) ids.push(id);
    } else if (n.endsWith(".meta")) {
      const id = n.slice(0, -5);
      if (isValidThreadId(id)) metas.add(id);
    }
  }
  const indexPath = path.join(threads, INDEX_NAME);
  if (!ids.length && !names.includes(INDEX_NAME)) return [];

  const { entries: old, fresh } = loadIndex(indexPath);
  let changed = !fresh;
  const next = new Map<string, Entry>();
  const rows: Row[] = [];
  for (const id of ids) {
    const file = path.join(threads, `${id}.json`);
    const st = lstatQuiet(file);
    if (!st?.isFile()) continue;
    const stamp = stampOf(st);
    const before = old.get(id);
    let e: Entry;
    let keep = true;
    if (before && sameStamp(before, stamp)) {
      e = { ...before };
    } else {
      indexStats.contentReads++;
      // Stamped before it is read: a write in between leaves a stamp that differs next time, so it is read again.
      const c = sources.content(file);
      keep = c.keep !== false;
      e = { id, title: c.title, messages: c.messages, ...stamp };
      changed = true;
    }
    delete e.meta;
    if (metas.has(id)) {
      const metaFile = path.join(threads, `${id}.meta`);
      const mst = lstatQuiet(metaFile);
      if (mst) {
        const mstamp = stampOf(mst);
        if (before?.meta && sameStamp(before.meta, mstamp)) {
          e.meta = before.meta;
        } else {
          indexStats.metaReads++;
          e.meta = { ...sources.meta(metaFile), ...mstamp };
          changed = true;
        }
      }
    }
    if (!e.meta && before?.meta) changed = true;
    if (keep) next.set(id, e);
    else changed = true;
    const meta: MetaView = {};
    if (e.meta?.title) meta.title = e.meta.title;
    if (e.meta?.pinned) meta.pinned = e.meta.pinned;
    if (e.meta?.allowWrites) meta.allowWrites = e.meta.allowWrites;
    rows.push({ id, title: e.title, messages: e.messages, meta, mtimeMs: e.mtimeMs });
  }
  if (next.size !== old.size) changed = true;
  if (changed) saveIndex(indexPath, next);
  return rows;
}

/** Forgets what this process remembers of every index (tests). */
export function forgetIndexes(): void {
  memo.clear();
}
