// STUB: owned by storage (only what the agent worker's tests need)
import type { UiMessage, UiRecord } from "../../shared/agent.ts";
import { ATTACHMENT_TYPE, HIDDEN_RECORDS, LEGACY_ATTACHMENT_TYPE, attachPending, recordFromBlock, shownTexts, type Message } from "../core/thread.ts";
import { Refusal } from "../rpc/registry.ts";
import { save } from "../core/thread.ts";

export const STALE_EDIT = "That message can’t be changed: the conversation has changed since it was shown. Reload the conversation and try again.";

export function toUi(msgs: Message[]): UiMessage[] {
  const out: UiMessage[] = [];
  let replyStart: number | undefined;
  msgs.forEach((m, index) => {
    const texts = shownTexts(m);
    const files = m.content
      .filter((b) => b.type === ATTACHMENT_TYPE || b.type === LEGACY_ATTACHMENT_TYPE)
      .map((b) => ({ name: String(b.name ?? ""), path: String(b.path ?? ""), mediaType: String(b.media_type ?? "") }));
    const records = m.content.map(recordFromBlock).filter((r) => r && !HIDDEN_RECORDS.has(r.kind)) as UiRecord[];
    if (m.role === "user") {
      if (texts.length || files.length) {
        replyStart = undefined;
        out.push({ role: "user", text: texts.join("\n\n"), attachments: files, index, records: [], ...(m.at !== undefined ? { at: m.at } : {}) });
      }
      return;
    }
    if (!texts.length && !records.length) return;
    replyStart ??= index;
    const last = out[out.length - 1];
    if (last?.role === "assistant") {
      const text = texts.join("\n\n");
      last.text = last.text && text ? `${last.text}\n\n${text}` : last.text || text;
      last.records.push(...records);
      if (m.at !== undefined) last.at = m.at;
    } else {
      out.push({ role: "assistant", text: texts.join("\n\n"), attachments: [], index: replyStart, records, ...(m.at !== undefined ? { at: m.at } : {}) });
    }
  });
  return attachPending(out, msgs);
}

export function isUserBoundary(msgs: Message[], i: number): boolean {
  const m = msgs[i];
  return !!m && m.role === "user" && m.content.length > 0 && !m.content.some((b) => b.type === "tool_result");
}

/** Truncates at a user boundary (the real one archives a copy first and carries denials over). */
export function cutAt(space: string, msgs: Message[], index: number): Message[] {
  if (!isUserBoundary(msgs, index)) throw new Refusal(STALE_EDIT);
  const kept = msgs.slice(0, index);
  save(space, kept);
  return kept;
}
