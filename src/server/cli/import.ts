import fs from "node:fs";
import path from "node:path";
import { homeDir } from "../env.ts";
import { isWithin, prettyJson, writeFileAtomic } from "../core/fsx.ts";
import { load, parseThread, recordBlock, records, shortTitle, type Block, type Message } from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";
import { addArchived, toUi } from "../threads/store.ts";
import { isUuid } from "./cli.ts";
import { HISTORY_INTRO } from "./prompt.ts";
import { sessionUuid } from "./session.ts";

/**
 * Brings in Claude Code conversations had in a space before Phaethon
 * recorded CLI turns, as archived conversations that resume their own
 * session. Only regular `*.jsonl` files directly in the space's project
 * folders are read (never links, at most 64 MiB), each transcript's `cwd` is
 * checked against the space, and nothing else in Claude Code's folder is
 * ever opened, credentials included. A ledger remembers what was brought in
 * (or deleted) so nothing comes back twice.
 */

export const FROM_CLAUDE_CODE = "claude-code";
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const NEW_MESSAGE_MARK = "\n\nThe user's new message:\n\n";
const HISTORY_INTRO_START = HISTORY_INTRO.slice(0, HISTORY_INTRO.indexOf(","));
const LONG_NAME = 200;

/** The selected instance's home, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeHome(isolated: string | null): string | null {
  if (isolated) return isolated;
  if (process.env.CLAUDE_CONFIG_DIR) return process.env.CLAUDE_CONFIG_DIR;
  const home = homeDir();
  return home ? path.join(home, ".claude") : null;
}

/** Claude Code's folder name for a working directory: every character that isn't ASCII alphanumeric becomes `-`. */
export function projectDirName(cwd: string): string {
  let out = "";
  for (const ch of cwd) out += /^[A-Za-z0-9]$/.test(ch) ? ch : "-";
  return out;
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function realOr(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

export function transcripts(home: string, space: string): string[] {
  const projects = path.join(home, "projects");
  const names = [projectDirName(space)];
  const real = realOr(space);
  if (real !== null && projectDirName(real) !== names[0]) names.push(projectDirName(real));
  const dirs: string[] = [];
  for (const name of names) {
    if (name.length > LONG_NAME) {
      // Claude Code shortened the name and added a hash.
      const start = name.slice(0, LONG_NAME);
      try {
        for (const e of fs.readdirSync(projects)) if (e.startsWith(start)) dirs.push(path.join(projects, e));
      } catch {
        // no projects folder
      }
    } else dirs.push(path.join(projects, name));
  }
  const out: string[] = [];
  for (const dir of dirs) {
    if (!lstat(dir)?.isDirectory()) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e);
      const st = lstat(p);
      if (st?.isFile() && st.size <= MAX_TRANSCRIPT_BYTES && path.extname(e) === ".jsonl" && !out.includes(p)) out.push(p);
    }
  }
  return out.sort();
}

function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** RFC 3339 (or a bare date) to seconds since the epoch, as the Rust core's `parse_time` read it. */
export function parseTime(input: string): number | null {
  const s = input.trim();
  const num = (a: number, n: number): number | null => {
    const t = s.slice(a, a + n);
    return t.length === n && /^\d+$/.test(t) ? Number(t) : null;
  };
  const y = num(0, 4);
  const mo = num(5, 2);
  const d = num(8, 2);
  if (y === null || mo === null || d === null || s[4] !== "-" || s[7] !== "-" || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const days = daysFromCivil(y, mo, d);
  if (s.length === 10) return days * 86400;
  if (!["T", "t", " "].includes(s[10])) return null;
  const h = num(11, 2);
  const mi = num(14, 2);
  if (h === null || mi === null) return null;
  let at = 16;
  let sec = 0;
  if (s[16] === ":") {
    const ss = num(17, 2);
    if (ss === null) return null;
    sec = ss;
    at = 19;
    if (s[19] === ".") {
      at = 20;
      while (at < s.length && /\d/.test(s[at])) at++;
    }
  }
  let offset = 0;
  const c = s[at];
  if (c === "+" || c === "-") {
    const oh = num(at + 1, 2);
    const om = num(at + 4, 2);
    if (oh === null || om === null) return null;
    offset = (oh * 3600 + om * 60) * (c === "-" ? -1 : 1);
  } else if (c !== undefined && c !== "Z" && c !== "z") return null;
  return days * 86400 + h * 3600 + mi * 60 + sec - offset;
}

/** A transcript timestamp in milliseconds (the fraction cut to 3 digits and padded). */
export function timeMs(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const secs = parseTime(v);
  if (secs === null || secs < 0) return null;
  const dot = v.indexOf(".");
  let ms = 0;
  if (dot >= 0) {
    const digits = /^\d{0,3}/.exec(v.slice(dot + 1))![0];
    ms = digits ? Number(digits) * 10 ** (3 - digits.length) : 0;
  }
  return secs * 1000 + ms;
}

const CLI_TEXT = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<local-command-caveat>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<system-reminder>",
  "<user-prompt-submit-hook>",
  "[Request interrupted by user",
  "Caveat: The messages below were generated by the user while running local commands",
];

function isCliText(t: string): boolean {
  const s = t.trimStart();
  return CLI_TEXT.some((p) => s.startsWith(p));
}

/** Undoes Phaethon's own fresh-session prompt: only the user's new words. */
function ownWords(t: string): string {
  if (t.startsWith(HISTORY_INTRO_START)) {
    const at = t.lastIndexOf(NEW_MESSAGE_MARK);
    if (at >= 0) return t.slice(at + NEW_MESSAGE_MARK.length);
  }
  return t;
}

function contentTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text as string);
}

function startsWithPath(child: string, parent: string): boolean {
  return path.isAbsolute(child) && isWithin(child, parent);
}

function inSpace(cwd: string, space: string): boolean {
  const real = realOr(space);
  if (startsWithPath(cwd, space)) return true;
  if (real === null) return false;
  if (startsWithPath(cwd, real)) return true;
  const realCwd = realOr(cwd);
  return realCwd !== null && startsWithPath(realCwd, real);
}

export type Transcript = { session: string; title: string | null; messages: Message[]; lastAt: number | null };

/** Splits bytes on `\n`; lines that aren't UTF-8 are given as null. */
function* byteLines(buf: Buffer): Generator<string | null> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end < 0) end = buf.length;
    try {
      yield decoder.decode(buf.subarray(start, end));
    } catch {
      yield null;
    }
    start = end + 1;
  }
}

export function readTranscript(file: string, space: string): Transcript | null {
  const session = path.basename(file, path.extname(file));
  if (!isUuid(session)) return null;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  const uuids = new Set<string>();
  const summaries: [string | null, string][] = [];
  let customTitle: string | null = null;
  let cwdChecked = false;
  const messages: Message[] = [];
  let lastAt: number | null = null;
  for (const line of byteLines(buf)) {
    if (line === null) continue;
    let v: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line.trim());
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      v = parsed;
    } catch {
      continue;
    }
    if (typeof v.uuid === "string") {
      if (uuids.has(v.uuid)) continue; // the same line written twice
      uuids.add(v.uuid);
    }
    if (typeof v.sessionId === "string" && v.sessionId !== session && (v.type === "user" || v.type === "assistant")) continue;
    if (!cwdChecked && typeof v.cwd === "string") {
      // A different folder that shares the mangled name.
      if (!inSpace(v.cwd, space)) return null;
      cwdChecked = true;
    }
    const at = timeMs(v.timestamp);
    if (at !== null) lastAt = Math.max(lastAt ?? 0, at);
    if (v.type === "summary") {
      if (typeof v.summary === "string") summaries.push([typeof v.leafUuid === "string" ? v.leafUuid : null, v.summary]);
    } else if (v.type === "custom-title") {
      if (typeof v.customTitle === "string") customTitle = v.customTitle;
    } else if (v.type === "user" || v.type === "assistant") {
      const role = v.type;
      const message = (v.message ?? {}) as Record<string, unknown>;
      const skipped = ["isSidechain", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly", "isApiErrorMessage"].some((k) => v[k] === true) || message.model === "<synthetic>";
      if (skipped || (typeof message.role === "string" && message.role !== role)) continue;
      const texts = contentTexts(message.content)
        .filter((t) => !(role === "user" && isCliText(t)))
        .map((t) => (role === "user" ? ownWords(t) : t))
        .filter((t) => t.trim() !== "");
      if (!texts.length) continue;
      const blocks: Block[] = texts.map((text) => ({ type: "text", text }));
      const last = messages.at(-1);
      if (last && last.role === role) {
        last.content.push(...blocks);
        // A reply finishes with its last part.
        if (role === "assistant" && at !== null) last.at = at;
      } else {
        const m: Message = { role, content: blocks };
        if (at !== null) m.at = at;
        messages.push(m);
      }
    }
  }
  if (!messages.some((m) => m.role === "user")) return null;
  let summary: string | null = null;
  for (let i = summaries.length - 1; i >= 0; i--) {
    const [leaf, text] = summaries[i];
    if (leaf === null || uuids.has(leaf)) {
      summary = text;
      break;
    }
  }
  const title = (customTitle ?? summary)?.trim() || null;
  return { session, title, messages, lastAt };
}

/** The messages plus a hidden record of where they came from, on the first reply. */
export function toThread(t: Transcript): Message[] {
  const msgs: Message[] = t.messages.map((m) => ({ ...m, content: [...m.content] }));
  const record = recordBlock(t.title !== null ? { kind: "imported", from: FROM_CLAUDE_CODE, session: t.session, title: t.title } : { kind: "imported", from: FROM_CLAUDE_CODE, session: t.session });
  const reply = msgs.find((m) => m.role === "assistant");
  if (reply) reply.content.push(record);
  else msgs.push({ role: "assistant", content: [record] });
  return msgs;
}

// ---- The ledger: <space>/.phaethon/cli-import.json ----

type Ledger = { checked: boolean; sessions: string[] };

function ledgerFile(dir: string): string {
  return path.join(dir, ".phaethon", "cli-import.json");
}

function loadLedger(dir: string): Ledger {
  try {
    const v = JSON.parse(fs.readFileSync(ledgerFile(dir), "utf8"));
    if (!v || typeof v !== "object" || Array.isArray(v)) return { checked: false, sessions: [] };
    const checked = v.checked === undefined ? false : v.checked;
    const sessions = v.sessions === undefined ? [] : v.sessions;
    // serde rejected the whole file when a field had the wrong type.
    if (typeof checked !== "boolean" || !Array.isArray(sessions) || !sessions.every((s: unknown) => typeof s === "string")) return { checked: false, sessions: [] };
    return { checked, sessions };
  } catch {
    return { checked: false, sessions: [] };
  }
}

function saveLedger(dir: string, ledger: Ledger): void {
  writeFileAtomic(ledgerFile(dir), prettyJson(ledger));
}

/**
 * Notes that a session is known (called when a conversation is deleted), so
 * it's never brought in again. Accepts a session file's line as is: a bare
 * UUID or a tagged one (`claude-<instance>:<uuid>`).
 */
export function remember(space: string, session: string): void {
  const id = sessionUuid(session);
  if (!id) return;
  const dir = spaceDir(space);
  const ledger = loadLedger(dir);
  if (!ledger.sessions.includes(id)) {
    ledger.sessions.push(id);
    try {
      saveLedger(dir, ledger);
    } catch {
      // best effort, as before
    }
  }
}

function readRegular(p: string): string | null {
  if (!lstat(p)?.isFile()) return null;
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function importedSessions(msgs: Message[]): string[] {
  return records(msgs).flatMap((r) => (r.kind === "imported" ? [r.session] : []));
}

/**
 * Every session the space already has: the ledger's, the current and archived
 * conversations' session files (tagged lines included, so conversations a
 * named Claude Code connection recorded aren't brought in again), and the
 * sessions named by import records.
 */
export function knownSessions(space: string): Set<string> {
  const dir = spaceDir(space);
  const state = path.join(dir, ".phaethon");
  const known = new Set(loadLedger(dir).sessions);
  const current = readRegular(path.join(state, "session"));
  const currentId = current === null ? null : sessionUuid(current);
  if (currentId) known.add(currentId);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(state, "threads"));
  } catch {
    entries = [];
  }
  for (const e of entries) {
    const p = path.join(state, "threads", e);
    if (path.extname(e) === ".session") {
      const raw = readRegular(p);
      const id = raw === null ? null : sessionUuid(raw);
      if (id) known.add(id);
    } else if (path.extname(e) === ".json") {
      const raw = readRegular(p);
      if (raw === null) continue;
      try {
        for (const s of importedSessions(parseThread(raw))) known.add(s);
      } catch {
        // an unreadable archive names nothing
      }
    }
  }
  try {
    for (const s of importedSessions(load(space))) known.add(s);
  } catch {
    // unreadable current conversation
  }
  return known;
}

export function offered(space: string, home: string | null, claudeAnswers: boolean): boolean {
  return claudeAnswers || (home !== null && transcripts(home, spaceDir(space)).length > 0);
}

function firstWords(msgs: Message[]): string {
  const user = toUi(msgs).find((m) => m.role === "user");
  return user ? shortTitle(user.text) : "A conversation";
}

/** Brings in every transcript not already known, oldest first; returns their titles. */
export function importConversations(space: string, home: string): string[] {
  const dir = spaceDir(space);
  const known = knownSessions(space);
  const found = transcripts(home, dir)
    .filter((p) => !known.has(path.basename(p, ".jsonl")))
    .map((p) => readTranscript(p, dir))
    .filter((t): t is Transcript => t !== null)
    .sort((a, b) => (a.messages[0]?.at ?? 0) - (b.messages[0]?.at ?? 0));
  const titles: string[] = [];
  for (const t of found) {
    const msgs = toThread(t);
    addArchived(space, msgs, t.session, t.lastAt);
    const ledger = loadLedger(dir);
    ledger.sessions.push(t.session);
    saveLedger(dir, ledger);
    titles.push(t.title !== null ? shortTitle(t.title) : firstWords(msgs));
  }
  return titles;
}

/** At launch: looks once per space; later transcripts are left to the menu. Null when it already looked. */
export function importOnce(space: string, home: string): string[] | null {
  const dir = spaceDir(space);
  if (loadLedger(dir).checked) return null;
  const titles = importConversations(space, home);
  const ledger = loadLedger(dir);
  ledger.checked = true;
  saveLedger(dir, ledger);
  return titles;
}
