import fs from "node:fs";
import path from "node:path";
import type { UiMessage, UiRecord } from "#shared/agent.ts";
import { isNotFound, lstatOrNull, prettyJson } from "../core/fsx.ts";
import {
  ATTACHMENT_TYPE,
  HIDDEN_RECORDS,
  isValidThreadId,
  LEGACY_ATTACHMENT_TYPE,
  loadFile,
  replaceFresh,
  saveIn as saveThreadIn,
  readThreadText,
  threadsDirIn,
  writeFresh,
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
 * A space's conversations, each kept whole in `.phaethon/threads/<id>.json`
 * with its sidecars beside it: the CLI session it resumes (`<id>.session`),
 * the model chosen for it (`<id>.model`, see `pick.ts`) and what the person
 * set by hand (`<id>.meta`: title, pin, writes allowed). Every operation names
 * its conversation, and a conversation's files are never moved while it is in
 * use, so several conversations can reply at once.
 *
 * Before 0.3 the space's "current" conversation was `.phaethon/thread.json`
 * with `session`, `model` and `meta` beside it, and opening another moved
 * files by rename. `migrateIn` moves such a conversation into `threads/`
 * under a fresh id, sidecars included, the first time the space is listed or
 * read; an empty one is removed. No sidecar name ends in `.json`, so the
 * listing and older cores never mistake one for a conversation.
 *
 * Functions take a space id; the `*In` variants take its folder (already
 * resolved with `spaceDir`).
 */

export const STALE_EDIT =
  "That message can’t be changed: the conversation has changed since it was shown. Reload the conversation and try again.";

/** `pinned` is when it was pinned (ms), absent when it isn't; `renamed` when the title was given by hand; `allowWrites` when its writes were allowed without asking. */
export type ThreadSummary = { id: string; title: string; updated: number; messages: number; pinned?: number; renamed?: boolean; allowWrites?: number };

/** What the person set on a conversation by hand. `allowWrites` is when they let it write files in its space without asking. */
export type ThreadMeta = { title?: string; pinned?: number; allowWrites?: number };

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

export { isValidThreadId };

// ---- Paths ---------------------------------------------------------------------

const stateDir = (dir: string) => path.join(dir, ".phaethon");
const threadsDir = (dir: string) => threadsDirIn(dir);
function checked(id: string): string {
  if (!isValidThreadId(id)) throw notAnId();
  return id;
}
export const threadPath = (dir: string, id: string) => path.join(threadsDir(dir), `${checked(id)}.json`);
export const sessionPath = (dir: string, id: string) => path.join(threadsDir(dir), `${checked(id)}.session`);
export const pickPath = (dir: string, id: string) => path.join(threadsDir(dir), `${checked(id)}.model`);
export const metaPath = (dir: string, id: string) => path.join(threadsDir(dir), `${checked(id)}.meta`);

/** The single-conversation layout before 0.3. */
const legacy = {
  thread: (dir: string) => path.join(stateDir(dir), "thread.json"),
  session: (dir: string) => path.join(stateDir(dir), "session"),
  pick: (dir: string) => path.join(stateDir(dir), "model"),
  meta: (dir: string) => path.join(stateDir(dir), "meta"),
};

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

/** Reads a small sidecar, never through a link; undefined when it isn't a regular file or is too big. */
function readSmall(p: string, max = 4096): string | undefined {
  try {
    const st = lstatOrNull(p);
    if (!st?.isFile() || st.size > max) return undefined;
    return fs.readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
}

/** Whether conversation `id` has been saved (a new chat isn't until its first message). */
export function existsIn(dir: string, id: string): boolean {
  return isValidThreadId(id) && isRegularFile(threadPath(dir, id));
}

// ---- Ids -----------------------------------------------------------------------

/** Ids handed out by `createIn` this run, so two new chats never get the same one before either is saved. */
const reserved = new Set<string>();

function taken(dir: string, id: string): boolean {
  if (reserved.has(`${dir}\0${id}`)) return true;
  for (const p of [threadPath(dir, id), sessionPath(dir, id), pickPath(dir, id), metaPath(dir, id)]) {
    try {
      if (lstatOrNull(p) !== null) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function freeId(dir: string): string {
  fs.mkdirSync(threadsDir(dir), { recursive: true });
  const base = Date.now();
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? String(base) : `${base}-${n}`;
    if (!taken(dir, id)) return id;
  }
  throw new Error("no free name for a conversation");
}

/** A new conversation's id. Nothing is written until its first message is saved, so an unsent new chat leaves no file. */
export function createIn(dir: string): string {
  const id = freeId(dir);
  reserved.add(`${dir}\0${id}`);
  return id;
}

export function create(space: string): string {
  return createIn(spaceDir(space));
}

// ---- Migration -----------------------------------------------------------------

function hasContent(p: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (e) {
    return !isNotFound(e);
  }
  try {
    const v = JSON.parse(raw) as unknown;
    return !(Array.isArray(v) && v.length === 0);
  } catch {
    // Damaged: kept, so it's listed as one that couldn't be read rather than lost.
    return true;
  }
}

/**
 * Moves a space's pre-0.3 current conversation (`.phaethon/thread.json`) into
 * `threads/` under a fresh id, with its session, model and meta. An empty one
 * is removed with its sidecars. A link or folder at that name is left alone.
 * Returns the new id, or null when there was nothing to move.
 */
export function migrateIn(dir: string): string | null {
  // Checked before anything is read, moved or removed: a linked `.phaethon` must not touch another space's files.
  threadsDir(dir);
  const cur = legacy.thread(dir);
  if (!isRegularFile(cur)) return null;
  removeIfThere(`${cur}.tmp`);
  if (!hasContent(cur)) {
    removeIfThere(cur);
    dropSession(dir, legacy.session(dir));
    for (const p of [legacy.pick(dir), legacy.meta(dir)]) if (isRegularFile(p)) removeIfThere(p);
    return null;
  }
  const id = freeId(dir);
  fs.renameSync(cur, threadPath(dir, id));
  for (const [from, to] of [
    [legacy.session(dir), sessionPath(dir, id)],
    [legacy.pick(dir), pickPath(dir, id)],
    [legacy.meta(dir), metaPath(dir, id)],
  ] as const) {
    try {
      if (isRegularFile(from)) fs.renameSync(from, to);
    } catch {
      // Losing a sidecar only loses a choice: the conversation starts a fresh session or falls back to the default model.
    }
  }
  return id;
}

export function migrate(space: string): string | null {
  return migrateIn(spaceDir(space));
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
 * The CLI session conversation `id` resumes. `tag` is null for built-in
 * Claude Code (saved as a plain UUID), else the CLI's or instance's tag (saved
 * as `tag:uuid`); one CLI never reads another's session. The file is
 * user-editable and may sync, so anything but a UUID is ignored.
 */
export function readSessionIn(dir: string, id: string, tag: string | null = null): string | null {
  const raw = readSmall(sessionPath(dir, id));
  if (raw === undefined) return null;
  const saved = raw.trim();
  let sid = saved;
  if (tag !== null) {
    if (!saved.startsWith(`${tag}:`)) return null;
    sid = saved.slice(tag.length + 1);
  }
  return isUuid(sid) ? sid : null;
}

/** Saves (or with null clears) conversation `id`'s CLI session. */
export function writeSessionIn(dir: string, id: string, session: string | null, tag: string | null = null): void {
  const p = sessionPath(dir, id);
  if (session === null) {
    removeIfThere(p);
    return;
  }
  if (!isUuid(session)) throw new Error("refusing to save a malformed session id");
  replaceFresh(p, `${tag === null ? session : `${tag}:${session}`}\n`);
}

export function readSession(space: string, id: string, tag: string | null = null): string | null {
  return readSessionIn(spaceDir(space), id, tag);
}

export function writeSession(space: string, id: string, session: string | null, tag: string | null = null): void {
  writeSessionIn(spaceDir(space), id, session, tag);
}

/** Forgets every conversation's CLI session in the space (its working folder changed, so none of them can resume). */
export function clearSessions(space: string): void {
  const dir = spaceDir(space);
  migrateIn(dir);
  let names: string[];
  try {
    names = fs.readdirSync(threadsDir(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(".session") && isValidThreadId(name.slice(0, -8))) removeIfThere(path.join(threadsDir(dir), name));
  }
}

function dropSession(dir: string, p: string): void {
  const raw = readSmall(p);
  if (raw?.trim()) {
    try {
      sessionDropped(dir, raw.trim());
    } catch {
      // Only remembered.
    }
  }
  removeIfThere(p);
}

// ---- Model choice ---------------------------------------------------------------

/** The model choice saved for conversation `id`, as raw JSON (validated by `pick.ts`). */
export function readPickRawIn(dir: string, id: string): unknown {
  const raw = readSmall(pickPath(dir, id));
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Saves (or with null clears) conversation `id`'s model choice. */
export function writePickRawIn(dir: string, id: string, value: unknown): void {
  const p = pickPath(dir, id);
  if (value === null || value === undefined) {
    removeIfThere(p);
    return;
  }
  replaceFresh(p, `${JSON.stringify(value)}\n`);
}

function removeSidecars(dir: string, id: string): void {
  removeIfThere(pickPath(dir, id));
  removeIfThere(metaPath(dir, id));
}

// ---- Title, pin and writes -----------------------------------------------------

const TITLE_MAX = 120;

function metaOf(dir: string, id: string): string {
  if (!isValidThreadId(id)) throw notAnId();
  if (!isRegularFile(threadPath(dir, id))) throw gone();
  return metaPath(dir, id);
}

const positive = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);

function readMetaAt(p: string): ThreadMeta {
  const raw = readSmall(p);
  if (raw === undefined) return {};
  try {
    const v = JSON.parse(raw) as { title?: unknown; pinned?: unknown; allowWrites?: unknown } | null;
    if (!v || typeof v !== "object") return {};
    const out: ThreadMeta = {};
    if (typeof v.title === "string" && v.title.trim()) out.title = cleanTitle(v.title);
    const pinned = positive(v.pinned);
    if (pinned) out.pinned = pinned;
    const writes = positive(v.allowWrites);
    if (writes) out.allowWrites = writes;
    return out;
  } catch {
    return {};
  }
}

/** One line, no runs of spaces, at most 120 characters. */
export function cleanTitle(title: string): string {
  return [...title.split(/\p{White_Space}+/u).filter(Boolean).join(" ")].slice(0, TITLE_MAX).join("");
}

/** The title, pin and write permission set on conversation `id` ({} for one not saved yet). */
export function readMetaIn(dir: string, id: string): ThreadMeta {
  if (!isValidThreadId(id)) throw notAnId();
  return readMetaAt(metaPath(dir, id));
}

/** Merges `change` into a conversation's meta; an empty title or a null clears that part. */
export function updateMetaIn(dir: string, id: string, change: { title?: string | null; pinned?: number | null; allowWrites?: number | null }): ThreadMeta {
  const p = metaOf(dir, id);
  const next = readMetaAt(p);
  if (change.title !== undefined) {
    const t = change.title === null ? "" : cleanTitle(change.title);
    if (t) next.title = t;
    else delete next.title;
  }
  for (const key of ["pinned", "allowWrites"] as const) {
    const v = change[key];
    if (v === undefined) continue;
    if (v === null) delete next[key];
    else next[key] = Math.floor(v);
  }
  if (next.title === undefined && next.pinned === undefined && next.allowWrites === undefined) {
    removeIfThere(p);
    return next;
  }
  replaceFresh(p, `${JSON.stringify(next)}\n`);
  return next;
}

// ---- Messages ------------------------------------------------------------------

function isMessage(m: unknown): boolean {
  const o = m as { role?: unknown; content?: unknown } | null;
  return !!o && typeof o === "object" && (o.role === "user" || o.role === "assistant") && Array.isArray(o.content);
}

function readMessages(p: string): Message[] {
  const text = readThreadText(p);
  if (text === null) throw gone();
  const v = JSON.parse(text) as unknown;
  if (!Array.isArray(v) || !v.every(isMessage)) throw new StoreError("other", "not a list of messages");
  return v as Message[];
}

/** Conversation `id`'s messages; one not saved yet (a new chat) is empty. */
export function loadIn(dir: string, id: string): Message[] {
  if (!isValidThreadId(id)) throw notAnId();
  return loadFile(threadPath(dir, id));
}

export function saveIn(dir: string, id: string, msgs: Message[]): void {
  if (!isValidThreadId(id)) throw notAnId();
  saveThreadIn(dir, id, msgs);
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

function summary(p: string, id: string, meta: ThreadMeta): ThreadSummary {
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
  const out: ThreadSummary = { id, title: meta.title ?? title, updated: mtimeMs(p), messages };
  if (meta.title) out.renamed = true;
  if (meta.pinned) out.pinned = meta.pinned;
  if (meta.allowWrites) out.allowWrites = meta.allowWrites;
  return out;
}

/** The ids of the space's saved conversations, in no particular order. */
function savedIds(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(threadsDir(dir));
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((id) => isValidThreadId(id) && isRegularFile(threadPath(dir, id)));
}

/** The space's conversations, most recently changed first. */
export function listThreadsIn(dir: string): ThreadSummary[] {
  migrateIn(dir);
  const out = savedIds(dir).map((id) => summary(threadPath(dir, id), id, readMetaAt(metaPath(dir, id))));
  out.sort((a, b) => b.updated - a.updated || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return out;
}

export function listThreads(space: string): ThreadSummary[] {
  return listThreadsIn(spaceDir(space));
}

/** Deletes one conversation with its CLI session and sidecars. Attached files stay. */
export function deleteThreadIn(dir: string, id: string): void {
  if (!isValidThreadId(id)) throw notAnId();
  migrateIn(dir);
  const chosen = threadPath(dir, id);
  if (!isRegularFile(chosen)) throw gone();
  fs.rmSync(chosen);
  dropSession(dir, sessionPath(dir, id));
  removeSidecars(dir, id);
}

export function deleteThread(space: string, id: string): void {
  deleteThreadIn(spaceDir(space), id);
}

/** The saved messages of conversation `id`; one that isn't saved is `notFound`. */
export function loadConversationIn(dir: string, id: string): Message[] {
  if (!isValidThreadId(id)) throw notAnId();
  migrateIn(dir);
  const p = threadPath(dir, id);
  if (!isRegularFile(p)) throw gone();
  return readMessages(p);
}

export function loadConversation(space: string, id: string): Message[] {
  return loadConversationIn(spaceDir(space), id);
}

/** Adds a whole conversation (the CLI import); `updated` sets its time in the list. */
export function addArchivedIn(dir: string, msgs: Message[], session?: string | null, updated?: number | null): string {
  const id = freeId(dir);
  const p = threadPath(dir, id);
  const tmp = `${p}.tmp`;
  writeFresh(tmp, prettyJson(msgs));
  if (typeof updated === "number") {
    try {
      fs.utimesSync(tmp, new Date(), new Date(updated));
    } catch {
      // Only where it sorts.
    }
  }
  try {
    if (session) writeFresh(sessionPath(dir, id), `${session}\n`);
    fs.renameSync(tmp, p);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(sessionPath(dir, id), { force: true });
    throw e;
  }
  return id;
}

export function addArchived(space: string, msgs: Message[], session?: string | null, updated?: number | null): string {
  return addArchivedIn(spaceDir(space), msgs, session, updated);
}

/**
 * Edit or regenerate from user message `index` of conversation `id`: the whole
 * conversation is kept as a separate copy (which takes the CLI session, since
 * that session holds the turns being cut), then `msgs` is cut before `index`.
 * Refusals in the dropped part carry over as hidden `deniedEarlier` records,
 * so a deny still holds. Mutates and returns `msgs`; the caller adds the new
 * message and saves.
 */
export function cutAtIn(dir: string, id: string, msgs: Message[], index: number): Message[] {
  if (!isUserBoundary(msgs, index)) throw new StoreError("other", STALE_EDIT);
  let copy: string;
  try {
    copy = freeId(dir);
    saveThreadIn(dir, copy, msgs);
  } catch (e) {
    throw new StoreError("other", `The earlier version of this conversation couldn’t be kept, so nothing was changed: ${(e as Error).message}`);
  }
  try {
    if (isValidThreadId(id) && isRegularFile(sessionPath(dir, id))) fs.renameSync(sessionPath(dir, id), sessionPath(dir, copy));
  } catch {
    // best effort: the conversation then resumes its old session, given the cut conversation as text when that fails
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

export function cutAt(space: string, id: string, msgs: Message[], index: number): Message[] {
  return cutAtIn(spaceDir(space), id, msgs, index);
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
  for (const other of savedIds(dir)) {
    if (other === id) continue;
    try {
      const raw = readThreadText(threadPath(dir, other));
      if (raw !== null) others.push(raw);
    } catch {
      // Unreadable: it can't name anything.
    }
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

