// STUB: owned by storage worker. Minimal stand-in so the CLI worker's code and
// tests run before the storage branch is merged; the integrator keeps the
// storage worker's real file (loop.md §7.4–7.6).
import fs from "node:fs";
import path from "node:path";
import type { UiMessage, UiRecord } from "../../shared/agent.ts";
import { prettyJson } from "../core/fsx.ts";
import { ATTACHMENT_TYPE, HIDDEN_RECORDS, LEGACY_ATTACHMENT_TYPE, recordFromBlock, type Message } from "../core/thread.ts";
import { spaceDir } from "../core/vault.ts";

export const STALE_EDIT = "That message can’t be changed: the conversation has changed since it was shown. Reload the conversation and try again.";

function threadsDir(space: string): string {
  return path.join(spaceDir(space), ".phaethon", "threads");
}

function freeId(space: string): string {
  const dir = threadsDir(space);
  fs.mkdirSync(dir, { recursive: true });
  const base = Date.now();
  for (let n = 0; n < 1000; n++) {
    const id = n === 0 ? String(base) : `${base}-${n}`;
    if (!fs.existsSync(path.join(dir, `${id}.json`)) && !fs.existsSync(path.join(dir, `${id}.session`))) return id;
  }
  throw new Error("no free name in the conversation archive");
}

/** Writes `msgs` as a new archived conversation, dated `updated` (ms), resuming `session`. Returns its id. */
export function addArchived(space: string, msgs: Message[], session?: string | null, updated?: number | null): string {
  const id = freeId(space);
  const dir = threadsDir(space);
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, prettyJson(msgs));
  if (typeof updated === "number") fs.utimesSync(tmp, new Date(updated), new Date(updated));
  if (session) fs.writeFileSync(path.join(dir, `${id}.session`), `${session}\n`);
  fs.renameSync(tmp, file);
  return id;
}

function isUserBoundary(msgs: Message[], i: number): boolean {
  const m = msgs[i];
  return !!m && m.role === "user" && m.content.length > 0 && !m.content.some((b) => b.type === "tool_result");
}

/** Edit/regenerate: keeps a full copy in the archive, then returns the messages before `index`. */
export function cutAt(space: string, msgs: Message[], index: number): Message[] {
  if (!isUserBoundary(msgs, index)) throw new Error(STALE_EDIT);
  let id: string;
  try {
    id = addArchived(space, msgs);
  } catch (e) {
    throw new Error(`The earlier version of this conversation couldn’t be kept, so nothing was changed: ${(e as Error).message}`);
  }
  const session = path.join(spaceDir(space), ".phaethon", "session");
  try {
    fs.renameSync(session, path.join(threadsDir(space), `${id}.session`));
  } catch {
    // no session to keep
  }
  msgs.length = index;
  return msgs;
}

export function toUi(msgs: Message[]): UiMessage[] {
  const out: UiMessage[] = [];
  let replyStart: number | undefined;
  msgs.forEach((m, index) => {
    const texts = m.content.filter((b) => b.type === "text" && typeof b.text === "string" && b.text.trim()).map((b) => b.text as string);
    const files = m.content
      .filter((b) => b.type === ATTACHMENT_TYPE || b.type === LEGACY_ATTACHMENT_TYPE)
      .map((b) => ({ name: String(b.name ?? ""), path: String(b.path ?? ""), mediaType: String(b.media_type ?? "") }));
    const records: UiRecord[] = [];
    for (const b of m.content) {
      const r = recordFromBlock(b);
      if (r && !HIDDEN_RECORDS.has(r.kind)) records.push(r as UiRecord);
    }
    if (m.role === "user") {
      if (texts.length || files.length) {
        replyStart = undefined;
        const ui: UiMessage = { role: "user", text: texts.join("\n\n"), attachments: files, index, records: [] };
        if (typeof m.at === "number") ui.at = m.at;
        out.push(ui);
      }
      return;
    }
    if (!texts.length && !records.length) return;
    replyStart ??= index;
    const last = out.at(-1);
    const text = texts.join("\n\n");
    if (last && last.role === "assistant") {
      last.text = [last.text, text].filter(Boolean).join("\n\n");
      last.records.push(...records);
      if (typeof m.at === "number") last.at = m.at;
    } else {
      const ui: UiMessage = { role: "assistant", text, attachments: [], index: replyStart, records };
      if (typeof m.at === "number") ui.at = m.at;
      out.push(ui);
    }
  });
  return out;
}
