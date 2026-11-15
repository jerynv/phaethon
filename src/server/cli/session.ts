import { readSessionIn, writeSessionIn } from "../threads/store.ts";
import { isUuid } from "./cli.ts";

/**
 * `<space>/.phaethon/threads/<id>.session`: the CLI session conversation `id`
 * resumes, one line. Built-in Claude Code writes a bare UUID; Codex and
 * Gemini CLI write `codex:<uuid>` / `gemini:<uuid>`; named and system
 * instances write `<cli>-<instanceId>:<uuid>`. A session another CLI or
 * instance made is never resumed: that turn starts afresh with the
 * conversation so far as text.
 */

export function readCliSession(spaceDir: string, thread: string, tag: string | null): string | null {
  return readSessionIn(spaceDir, thread, tag);
}

export function writeCliSession(spaceDir: string, thread: string, tag: string | null, id: string): void {
  if (!isUuid(id)) throw new Error("refusing to save a malformed session id");
  writeSessionIn(spaceDir, thread, id, tag);
}

export function clearSession(spaceDir: string, thread: string): void {
  try {
    writeSessionIn(spaceDir, thread, null);
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
