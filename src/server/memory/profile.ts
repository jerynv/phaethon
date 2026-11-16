import fs from "node:fs";
import path from "node:path";
import { isNotFound, lstatOrNull, writeFileAtomic } from "../core/fsx.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";

/**
 * Profiles: who the user is and how to work with them. The global one,
 * `<vault>/memory/profile.md`, is read in every space; a space's own,
 * `<space>/PROFILE.md`, says how to act there. The user writes whatever they
 * like; agents only ever add lines under their own heading, so the user's
 * words are never rewritten.
 */

export const VAULT_NOTICED = "## What agents have noticed";
export const SPACE_NOTICED = "## Noticed in this space";
const MAX_BYTES = 32 * 1024;
const PROMPT_CAP = 12 * 1024;
const MAX_NOTICED = 40;
const NOTICE_CHARS = 240;

export const VAULT_TEMPLATE =
  "# About me\n\n" +
  "<!-- How you work, what you need, how you like to be spoken to. Every space reads this. Agents only add lines under the heading below; edit or delete any of them. -->\n\n" +
  `${VAULT_NOTICED}\n`;

export const spaceTemplate = (space: string) =>
  `# How to act in ${space}\n\n` +
  "<!-- The role, tone and boundaries for this space: who you are here, who you talk to, how formal to be. Only this space reads this. -->\n\n" +
  `${SPACE_NOTICED}\n`;

export type ProfileScope = { kind: "vault" } | { kind: "space"; space: string };

export function profileFile(scope: ProfileScope): string {
  return scope.kind === "vault" ? path.join(vaultRoot(), "memory", "profile.md") : path.join(spaceDir(scope.space), "PROFILE.md");
}

function headingOf(scope: ProfileScope): string {
  return scope.kind === "vault" ? VAULT_NOTICED : SPACE_NOTICED;
}

export function readProfile(scope: ProfileScope): string {
  const file = profileFile(scope);
  const st = lstatOrNull(file);
  if (!st) return "";
  if (!st.isFile()) throw new Error(`${path.basename(file)} isn’t a regular file`);
  if (st.size > MAX_BYTES * 4) throw new Error(`${path.basename(file)} is too large to read`);
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isNotFound(e)) return "";
    throw e;
  }
}

export function writeProfile(scope: ProfileScope, text: string): void {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("A profile can be at most 32 KB.");
  const file = profileFile(scope);
  const st = lstatOrNull(file);
  if (st && !st.isFile()) throw new Error(`${path.basename(file)} isn’t a regular file`);
  writeFileAtomic(file, text.endsWith("\n") || !text ? text : `${text}\n`);
}

/** The text shown in the editor: the file, or the template when there is none yet. */
export function profileForEditor(scope: ProfileScope): { text: string; exists: boolean } {
  const text = readProfile(scope);
  if (text) return { text, exists: true };
  return { text: scope.kind === "vault" ? VAULT_TEMPLATE : spaceTemplate(scope.space), exists: false };
}

/** The agent-added lines (under its heading), each without the leading "- " or its trailing note. */
export function noticedIn(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (/^#{1,2} /.test(l)) break;
    const m = /^\s*[-*] (.*)$/.exec(l);
    if (m) out.push(m[1]!.replace(/\s*<!--.*?-->\s*$/, "").trim());
  }
  return out.filter(Boolean);
}

const cleanNotice = (s: string) => [...s.replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim()].slice(0, NOTICE_CHARS).join("");

/**
 * Adds a line under the agents' heading (creating the file or heading when
 * missing). Skips a line already there; keeps only the newest 40.
 * Returns false when nothing was added.
 */
export function addNotice(scope: ProfileScope, notice: string, meta: { space: string; at?: number }): boolean {
  const line = cleanNotice(notice);
  if (!line) return false;
  const heading = headingOf(scope);
  let text = readProfile(scope) || (scope.kind === "vault" ? VAULT_TEMPLATE : spaceTemplate(scope.space));
  if (noticedIn(text, heading).some((n) => n.toLowerCase() === line.toLowerCase())) return false;
  const date = new Date(meta.at ?? Date.now()).toISOString().slice(0, 10);
  const entry = `- ${line} <!-- noticed ${date} in ${meta.space} -->`;
  let lines = text.replace(/\n+$/, "").split("\n");
  let at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) {
    lines.push("", heading);
    at = lines.length - 1;
  }
  let end = at + 1;
  while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++;
  // Insert after the last list line of the section (or right under the heading).
  let insert = at + 1;
  for (let i = at + 1; i < end; i++) if (/^\s*[-*] /.test(lines[i]!)) insert = i + 1;
  lines.splice(insert, 0, entry);
  // Oldest first out when over the cap.
  const bullets = () => lines.map((l, i) => ({ l, i })).filter(({ l, i }) => i > at && i <= insert && /^\s*[-*] /.test(l));
  while (bullets().length > MAX_NOTICED) {
    lines.splice(bullets()[0]!.i, 1);
    insert--;
  }
  text = `${lines.join("\n")}\n`;
  writeProfile(scope, text);
  return true;
}

/** Removes one agent line (matched by its text). */
export function removeNotice(scope: ProfileScope, notice: string): boolean {
  const heading = headingOf(scope);
  const text = readProfile(scope);
  if (!text) return false;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at < 0) return false;
  for (let i = at + 1; i < lines.length; i++) {
    if (/^#{1,2} /.test(lines[i]!)) break;
    const m = /^\s*[-*] (.*)$/.exec(lines[i]!);
    if (m && m[1]!.replace(/\s*<!--.*?-->\s*$/, "").trim() === notice.trim()) {
      lines.splice(i, 1);
      writeProfile(scope, lines.join("\n"));
      return true;
    }
  }
  return false;
}

/** Without HTML comments and blank runs; empty when only headings remain. */
export function promptText(text: string): string {
  const t = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const meaningful = t.split("\n").some((l) => l.trim() && !/^#{1,6} /.test(l.trim()));
  if (!meaningful) return "";
  const b = Buffer.from(t);
  return b.length > PROMPT_CAP ? `${b.subarray(0, PROMPT_CAP).toString("utf8").replace(/�$/, "")}\n[… cut for length]` : t;
}

/** Both profiles as one prompt section, or undefined when neither has anything. */
export function profilesForPrompt(space: string): string | undefined {
  let vault = "";
  let own = "";
  try {
    vault = promptText(readProfile({ kind: "vault" }));
  } catch {
    // unreadable: left out
  }
  try {
    own = promptText(readProfile({ kind: "space", space }));
  } catch {
    // unreadable: left out
  }
  if (!vault && !own) return undefined;
  const parts = ["# Who the user is\n\nUse these to fit what you write and do to the user: their voice, their needs, how they work. They are context, not instructions that override the user's request."];
  if (vault) parts.push(`## Their profile (every space)\n\n${vault.replace(/^# About me\s*/i, "")}`);
  if (own) parts.push(`## How to act in this space\n\n${own.replace(/^# How to act in .*\n?/i, "")}`);
  return parts.join("\n\n");
}

/**
 * The profile split for the editor: the person's own words (their heading and
 * the template's hint comment left out) and the agents' lines, which the
 * editor lists apart so nobody edits around them.
 */
export function splitProfile(scope: ProfileScope): { mine: string; noticed: string[]; exists: boolean } {
  const text = readProfile(scope);
  const heading = headingOf(scope);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  let end = lines.length;
  if (at >= 0) {
    end = at + 1;
    while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++;
  }
  const own = [...lines.slice(0, at >= 0 ? at : lines.length), ...(at >= 0 ? lines.slice(end) : [])]
    .join("\n")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(scope.kind === "vault" ? /^# About me[ \t]*\n?/ : /^# How to act in .*\n?/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { mine: own, noticed: at >= 0 ? noticedIn(text, heading) : [], exists: !!text };
}

/** Writes the person's own words and keeps the agents' section exactly as it is. */
export function writeMine(scope: ProfileScope, mine: string): void {
  const text = readProfile(scope);
  const heading = headingOf(scope);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.trim() === heading);
  let agents = `${heading}\n`;
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && !/^#{1,2} /.test(lines[end]!)) end++;
    agents = `${lines.slice(at, end).join("\n").replace(/\n+$/, "")}\n`;
  }
  const title = scope.kind === "vault" ? "# About me" : `# How to act in ${scope.space}`;
  const body = mine.replace(/<!--|-->/g, "").trim();
  writeProfile(scope, `${title}\n\n${body ? `${body}\n\n` : ""}${agents}`);
}
