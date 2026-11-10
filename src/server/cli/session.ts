import fs from "node:fs";
import path from "node:path";
import { isUuid } from "./cli.ts";

/**
 * `<space>/.phaethon/session`: the CLI session of the space's current
 * conversation, one line. Built-in Claude Code writes a bare UUID; Codex and
 * Gemini CLI write `codex:<uuid>` / `gemini:<uuid>`; named and system
 * instances write `<cli>-<instanceId>:<uuid>`. A session another CLI or
 * instance made is never resumed: that turn starts afresh with the
 * conversation so far as text.
 */

export function sessionFile(spaceDir: string): string {
  return path.join(spaceDir, ".phaethon", "session");
}

export function readCliSession(spaceDir: string, tag: string | null): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionFile(spaceDir), "utf8");
  } catch {
    return null;
  }
  const saved = raw.trim();
  let id = saved;
  if (tag !== null) {
    if (!saved.startsWith(`${tag}:`)) return null;
    id = saved.slice(tag.length + 1);
  }
  return isUuid(id) ? id : null;
}

export function writeCliSession(spaceDir: string, tag: string | null, id: string): void {
  if (!isUuid(id)) throw new Error("refusing to save a malformed session id");
  const file = sessionFile(spaceDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${tag === null ? id : `${tag}:${id}`}\n`);
}

export function clearSession(spaceDir: string): void {
  try {
    fs.rmSync(sessionFile(spaceDir));
  } catch {
    // already gone
  }
}

/** The UUID in a session line, whatever CLI or instance tagged it (`tag:uuid` or a bare uuid). */
export function sessionUuid(line: string): string | null {
  const saved = line.trim();
  const id = saved.slice(saved.lastIndexOf(":") + 1);
  return isUuid(id) ? id : null;
}
