import fs from "node:fs";
import path from "node:path";
import type { UiMessage, UiRecord } from "#shared/agent.ts";
import { isNotFound, lstatOrNull, prettyJson } from "../core/fsx.ts";
import {
  ATTACHMENT_TYPE,
  HIDDEN_RECORDS,
  LEGACY_ATTACHMENT_TYPE,
  loadFile,
  recordBlock,
  recordFromBlock,
  shortTitle,
  threadKey,
  type Block,
  type Message,
  type Record_,
  attachPending,
  shownTexts,
} from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";
import { covers } from "../grants/grants.ts";

/**
 * A space's conversations: `thread.json` is always the current one; the others
 * are kept whole in `.phaethon/threads/<id>.json`. Starting a new conversation
 * or reopening an old one moves files by rename, so nothing is ever rewritten
 * or lost. Each conversation keeps its CLI session beside it
 * (`.phaethon/session` for the current one, `threads/<id>.session` for others).
 *
 * Functions take a space id; the `*In` variants take its folder (already
 * resolved with `spaceDir`).
 */

export const CURRENT_ID = "current";
export const STALE_EDIT =
  "That message can’t be changed: the conversation has changed since it was shown. Reload the conversation and try again.";

export type ThreadSummary = { id: string; title: string; updated: number; messages: number; current: boolean };

/** A store failure with the kind the Rust `io::ErrorKind` carried (callers and tests match on it). */
export class StoreError extends Error {
  constructor(
    readonly kind: "invalid" | "notFound" | "other",
    message: string,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const notAnId = () => new StoreError("invalid", "not a conversation id");
const gone = () => new StoreError("notFound", "that conversation is no longer there");

// ---- Paths ---------------------------------------------------------------------

const stateDir = (dir: string) => path.join(dir, ".phaethon");
const currentFile = (dir: string) => path.join(stateDir(dir), "thread.json");
const archiveDir = (dir: string) => path.join(stateDir(dir), "threads");
const archived = (dir: string, id: string) => path.join(archiveDir(dir), `${id}.json`);
const archivedSession = (dir: string, id: string) => path.join(archiveDir(dir), `${id}.session`);
export const sessionFile = (dir: string) => path.join(stateDir(dir), "session");

/** `digits` or `digits-digits`, each 1 to 20 ASCII digits; anything else never becomes a path. */
export function isValidThreadId(id: string): boolean {
  return /^[0-9]{1,20}(?:-[0-9]{1,20})?$/.test(id);
}

function isRegularFile(p: string): boolean {
  try {
    return lstatOrNull(p)?.isFile() ?? false;
  } catch {
    return false;
  }
}

function removeIfThere(p: string): void {
  try {
    fs.rmSync(p);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

// ---- Sessions ------------------------------------------------------------------

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(s: string): boolean {
  return UUID.test(s);
}

/** Called with each CLI session id a conversation lets go of (the CLI import remembers it). */
let sessionDropped: (dir: string, id: string) => void = () => {};
export function onSessionDropped(f: (dir: string, id: string) => void): void {
  sessionDropped = f;
}

/**
 * The CLI session the current conversation resumes. `tag` is undefined for
 * Claude Code (saved as a plain UUID) or `codex`/`gemini` (saved as
 * `tag:uuid`); one CLI never reads another's session.
 */
export function readSessionIn(dir: string, tag?: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile(dir), "utf8");
  } catch {
    return null;
  }
  const saved = raw.trim();
  let id = saved;
  if (tag !== undefined) {
    if (!saved.startsWith(`${tag}:`)) return null;
    id = saved.slice(tag.length + 1);
  }
  return isUuid(id) ? id : null;
}

/** Saves (or with null clears) the current conversation's CLI session. */
export function writeSessionIn(dir: string, id: string | null, tag?: string): void {
  if (id === null) {
    try {
      fs.rmSync(sessionFile(dir));
    } catch {
      // Already gone.
    }
    return;
  }
  if (!isUuid(id)) throw new Error("refusing to save a malformed session id");
  fs.mkdirSync(stateDir(dir), { recursive: true });
  fs.writeFileSync(sessionFile(dir), `${tag === undefined ? id : `${tag}:${id}`}\n`);
}

export function readSession(space: string, tag?: string): string | null {
  return readSessionIn(spaceDir(space), tag);
}

export function writeSession(space: string, id: string | null, tag?: string): void {
  writeSessionIn(spaceDir(space), id, tag);
}

export function clearSession(space: string): void {
  writeSessionIn(spaceDir(space), null);
}

function sessionToArchive(dir: string, id: string): void {
  const cur = sessionFile(dir);
  if (!isRegularFile(cur)) return;
  fs.renameSync(cur, archivedSession(dir, id));
}

function dropSession(dir: string, p: string): void {
  if (isRegularFile(p)) {
    try {
      const raw = fs.readFileSync(p, "utf8").trim();
      if (raw) sessionDropped(dir, raw);
    } catch {
      // Unreadable: only removed.
    }
  }
  removeIfThere(p);
}

function sessionFromArchive(dir: string, id: string): void {
  const kept = archivedSession(dir, id);
  if (isRegularFile(kept)) fs.renameSync(kept, sessionFile(dir));
  else dropSession(dir, sessionFile(dir));
}

// ---- Messages ------------------------------------------------------------------

function isMessage(m: unknown): boolean {
  const o = m as { role?: unknown; content?: unknown } | null;
  return !!o && typeof o === "object" && (o.role === "user" || o.role === "assistant") && Array.isArray(o.content);
}

function readMessages(p: string): Message[] {
  const v = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  if (!Array.isArray(v) || !v.every(isMessage)) throw new StoreError("other", "not a list of messages");
  return v as Message[];
}

function writeTmpThenRename(file: string, msgs: Message[]): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, prettyJson(msgs));
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw e;
  }
}

export function loadIn(dir: string): Message[] {
  return loadFile(currentFile(dir));
}

export function saveIn(dir: string, msgs: Message[]): void {
  fs.mkdirSync(stateDir(dir), { recursive: true });
  writeTmpThenRename(currentFile(dir), msgs);
}

function isAttachmentRef(b: Block): boolean {
  return b.type === ATTACHMENT_TYPE || b.type === LEGACY_ATTACHMENT_TYPE;
}

function nonNegInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

const BLANK = /^\p{White_Space}*$/u;

/** The conversation as the UI shows it: user messages, and each reply's text and records joined. */
export function toUi(msgs: Message[]): UiMessage[] {
  const out: UiMessage[] = [];
  let replyStart: number | undefined;
  msgs.forEach((m, index) => {
    if (m.role === "assistant" && replyStart === undefined) replyStart = index;
    const blocks = Array.isArray(m.content) ? m.content : [];
    // Text blocks, plus what the model sent with send_to_user (shown like text).
    const texts = shownTexts({ ...m, content: blocks.filter(Boolean) }).filter((t) => !BLANK.test(t));
    const files = blocks.filter((b) => b && isAttachmentRef(b)).map((b) => ({
      name: typeof b.name === "string" ? b.name : "",
      path: typeof b.path === "string" ? b.path : "",
      mediaType: typeof b.media_type === "string" ? b.media_type : "",
    }));
    const records = blocks
      .map((b) => (b ? recordFromBlock(b) : undefined))
      .filter((r): r is Record_ => !!r && !HIDDEN_RECORDS.has(r.kind)) as UiRecord[];
    const at = nonNegInt(m.at);
    if (m.role === "user" && (texts.length || files.length)) {
      replyStart = undefined;
      const u: UiMessage = { role: "user", text: texts.join("\n\n"), attachments: files, index, records: [] };
      if (at !== undefined) u.at = at;
      out.push(u);
    } else if (m.role === "assistant" && (texts.length || records.length)) {
      const joined = texts.join("\n\n");
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        if (last.text && joined) last.text += "\n\n";
        last.text += joined;
        last.records.push(...records);
        const finished = at ?? last.at;
        if (finished !== undefined) last.at = finished;
      } else {
        const a: UiMessage = { role: "assistant", text: joined, attachments: [], index: replyStart ?? index, records };
        if (at !== undefined) a.at = at;
        out.push(a);
      }
    }
  });
  // An unanswered lesson question stays open after a reload.
  return attachPending(out, msgs);
}

// ---- Records -------------------------------------------------------------------

function refusal(r: Record_): { space: string; path: string } | undefined {
  if ((r.kind === "access" && r.answer === "deny") || r.kind === "deniedEarlier") return { space: r.space, path: r.path };
  return undefined;
}

function allRecords(msgs: Message[]): Record_[] {
  const out: Record_[] = [];
  for (const m of msgs) for (const b of m.content ?? []) {
    const r = b ? recordFromBlock(b) : undefined;
    if (r) out.push(r);
  }
  return out;
}

/** Whether the user refused `space`'s `path` (or a folder holding it) earlier in this conversation. */
export function denied(msgs: Message[], space: string, p: string): boolean {
  return allRecords(msgs).some((r) => {
    const x = refusal(r);
    return !!x && x.space === space && covers(x.path, p);
  });
}

export function isUserBoundary(msgs: Message[], index: number): boolean {
  const m = msgs[index];
  return !!m && m.role === "user" && Array.isArray(m.content) && m.content.length > 0 && !m.content.some((b) => b?.type === "tool_result");
}

/** The current attachment blocks (not legacy ones) of user message `index` whose paths are in `keep`, in order. */
export function keptAttachments(msgs: Message[], index: number, keep: string[]): Block[] {
  if (!isUserBoundary(msgs, index)) return [];
  return msgs[index]!.content.filter((b) => b.type === ATTACHMENT_TYPE && typeof b.path === "string" && keep.includes(b.path));
}

/** Each attached file's saved path once, in order. */
export function attachmentPaths(msgs: Message[]): string[] {
  const out: string[] = [];
  for (const m of msgs) for (const b of m.content ?? []) {
    if (b && isAttachmentRef(b) && typeof b.path === "string" && !out.includes(b.path)) out.push(b.path);
  }
  return out;
}

// ---- Conversations -------------------------------------------------------------

function freeId(dir: string): string {
  fs.mkdirSync(archiveDir(dir), { recursive: true });
  const base = Date.now();
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? String(base) : `${base}-${n}`;
    let taken = true;
    try {
      taken = lstatOrNull(archived(dir, id)) !== null;
    } catch {
      taken = true;
    }
    if (!taken) return id;
  }
  throw new Error("no free name in the conversation archive");
}

function currentHasContent(dir: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(currentFile(dir), "utf8");
  } catch (e) {
    return !isNotFound(e);
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return !(Array.isArray(v) && v.length === 0);
  } catch {
    return true;
  }
}

function archiveCurrent(dir: string): string | null {
  const cur = currentFile(dir);
  if (!currentHasContent(dir)) {
    removeIfThere(cur);
    return null;
  }
  const id = freeId(dir);
  fs.renameSync(cur, archived(dir, id));
  try {
    sessionToArchive(dir, id);
  } catch {
    // Losing the session only means the CLI starts afresh.
  }
  return id;
}

function mtimeMs(p: string): number {
  try {
    return Math.floor(fs.statSync(p).mtimeMs);
  } catch {
    return 0;
  }
}

function titleOf(msgs: UiMessage[]): string {
  const first = msgs.find((m) => m.role === "user");
  const text = first ? first.text.split(/\p{White_Space}+/u).filter(Boolean).join(" ") : "";
  const t = text || first?.attachments[0]?.name;
  return t ? shortTitle(t) : "New conversation";
}

function importedTitle(msgs: Message[]): string | undefined {
  for (const r of allRecords(msgs)) {
    if (r.kind === "imported" && typeof r.title === "string" && r.title.trim()) return shortTitle(r.title);
  }
  return undefined;
}

function summary(p: string, id: string, current: boolean): ThreadSummary {
  let title: string;
  let messages: number;
  try {
    const msgs = readMessages(p);
    const ui = toUi(msgs);
    title = importedTitle(msgs) ?? titleOf(ui);
    messages = ui.length;
  } catch {
    title = "A conversation that couldn’t be read";
    messages = 0;
  }
  return { id, title, updated: mtimeMs(p), messages, current };
}

function existsFollowing(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listThreadsIn(dir: string): ThreadSummary[] {
  const cur = currentFile(dir);
  const out: ThreadSummary[] = [
    existsFollowing(cur)
      ? summary(cur, CURRENT_ID, true)
      : { id: CURRENT_ID, title: "New conversation", updated: Date.now(), messages: 0, current: true },
  ];
  let names: string[];
  try {
    names = fs.readdirSync(archiveDir(dir));
  } catch (e) {
    if (isNotFound(e)) return out;
    throw e;
  }
  const rest: ThreadSummary[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const p = path.join(archiveDir(dir), name);
    if (isValidThreadId(id) && isRegularFile(p)) rest.push(summary(p, id, false));
  }
  rest.sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out.concat(rest);
}

export function listThreads(space: string): ThreadSummary[] {
  return listThreadsIn(spaceDir(space));
}

/** Archives the current conversation (if it has anything) and starts an empty one with no CLI session. */
export function startNewIn(dir: string): void {
  archiveCurrent(dir);
  dropSession(dir, sessionFile(dir));
}

export function startNew(space: string): void {
  startNewIn(spaceDir(space));
}

/** Makes archived conversation `id` the current one (the current one is archived), with its own session. */
export function openThreadIn(dir: string, id: string): void {
  if (id === CURRENT_ID) return;
  if (!isValidThreadId(id)) throw notAnId();
  const chosen = archived(dir, id);
  if (!isRegularFile(chosen)) throw gone();
  const moved = archiveCurrent(dir);
  try {
    fs.renameSync(chosen, currentFile(dir));
  } catch (e) {
    if (moved) {
      try {
        fs.renameSync(archived(dir, moved), currentFile(dir));
        sessionFromArchive(dir, moved);
      } catch {
        // Both files are still in the archive; nothing is lost.
      }
    }
    throw e;
  }
  sessionFromArchive(dir, id);
}

export function openThread(space: string, id: string): void {
  openThreadIn(spaceDir(space), id);
}

/** Deletes one conversation with its CLI session; `"current"` empties the current one. Attached files stay. */
export function deleteThreadIn(dir: string, id: string): void {
  if (id === CURRENT_ID) {
    try {
      fs.rmSync(`${currentFile(dir)}.tmp`);
    } catch {
      // No leftover.
    }
    removeIfThere(currentFile(dir));
    dropSession(dir, sessionFile(dir));
    return;
  }
  if (!isValidThreadId(id)) throw notAnId();
  const chosen = archived(dir, id);
  if (!isRegularFile(chosen)) throw gone();
  fs.rmSync(chosen);
  dropSession(dir, archivedSession(dir, id));
}

export function deleteThread(space: string, id: string): void {
  deleteThreadIn(spaceDir(space), id);
}

/** The saved messages of `"current"` or a valid archived conversation; nothing is moved. */
export function loadConversationIn(dir: string, id: string): Message[] {
  if (id === CURRENT_ID) return loadIn(dir);
  if (!isValidThreadId(id)) throw notAnId();
  const p = archived(dir, id);
  if (!isRegularFile(p)) throw gone();
  return readMessages(p);
}

export function loadConversation(space: string, id: string): Message[] {
  return loadConversationIn(spaceDir(space), id);
}

/** Adds a whole conversation to the archive (the CLI import); `updated` sets its time in the list. */
export function addArchivedIn(dir: string, msgs: Message[], session?: string | null, updated?: number | null): string {
  const id = freeId(dir);
  const p = archived(dir, id);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, prettyJson(msgs));
  if (typeof updated === "number") {
    try {
      fs.utimesSync(tmp, new Date(), new Date(updated));
    } catch {
      // Only where it sorts.
    }
  }
  try {
    if (session) fs.writeFileSync(archivedSession(dir, id), `${session}\n`);
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(archivedSession(dir, id), { force: true });
    throw e;
  }
  return id;
}

export function addArchived(space: string, msgs: Message[], session?: string | null, updated?: number | null): string {
  return addArchivedIn(spaceDir(space), msgs, session, updated);
}

/**
 * Edit or regenerate from user message `index`: the whole conversation is kept
 * as an archived copy (with the CLI session), then `msgs` is cut before
 * `index`. Refusals in the dropped part carry over as hidden `deniedEarlier`
 * records, so a deny still holds. Mutates and returns `msgs`; the caller adds
 * the new message and saves.
 */
export function cutAtIn(dir: string, msgs: Message[], index: number): Message[] {
  if (!isUserBoundary(msgs, index)) throw new StoreError("other", STALE_EDIT);
  let id: string;
  try {
    id = freeId(dir);
    writeTmpThenRename(archived(dir, id), msgs);
  } catch (e) {
    throw new StoreError("other", `The earlier version of this conversation couldn’t be kept, so nothing was changed: ${(e as Error).message}`);
  }
  try {
    sessionToArchive(dir, id);
  } catch {
    // best effort
  }
  const dropped = msgs.splice(index);
  const carried: Block[] = [];
  const seen = new Set<string>();
  for (const r of allRecords(dropped)) {
    const x = refusal(r);
    if (!x) continue;
    const key = JSON.stringify([x.space, x.path]);
    if (!denied(msgs, x.space, x.path) && !seen.has(key)) {
      seen.add(key);
      carried.push(recordBlock({ kind: "deniedEarlier", space: x.space, path: x.path }));
    }
  }
  if (carried.length) msgs.push({ role: "assistant", content: carried });
  return msgs;
}

export function cutAt(space: string, msgs: Message[], index: number): Message[] {
  return cutAtIn(spaceDir(space), msgs, index);
}

export type ForgetPlan = { onlyHere: string[]; shared: number; key: string | undefined };

/**
 * What deleting conversation `id` with everything it brought would remove.
 * Other conversations are searched as raw text, so one that can't be read
 * still keeps any file it names.
 */
export function planForgetIn(dir: string, id: string): ForgetPlan {
  let msgs: Message[];
  try {
    msgs = loadConversationIn(dir, id);
  } catch (e) {
    if (e instanceof StoreError && (e.kind === "invalid" || e.kind === "notFound")) throw e;
    msgs = [];
  }
  const others: string[] = [];
  if (id !== CURRENT_ID) {
    try {
      others.push(fs.readFileSync(currentFile(dir), "utf8"));
    } catch {
      // No current conversation.
    }
  }
  try {
    for (const name of fs.readdirSync(archiveDir(dir))) {
      if (!name.endsWith(".json")) continue;
      const other = name.slice(0, -5);
      const p = path.join(archiveDir(dir), name);
      if (other !== id && isValidThreadId(other) && isRegularFile(p)) {
        try {
          others.push(fs.readFileSync(p, "utf8"));
        } catch {
          // Unreadable: it can't name anything.
        }
      }
    }
  } catch {
    // No archive.
  }
  const onlyHere: string[] = [];
  let shared = 0;
  for (const p of attachmentPaths(msgs)) {
    const quoted = JSON.stringify(p);
    if (others.some((raw) => raw.includes(quoted))) shared++;
    else onlyHere.push(p);
  }
  return { onlyHere, shared, key: threadKey(msgs) };
}

export function planForget(space: string, id: string): ForgetPlan {
  return planForgetIn(spaceDir(space), id);
}

