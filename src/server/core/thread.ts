import fs from "node:fs";
import path from "node:path";
import { isNotFound, writeJsonAtomic } from "./fsx.ts";
import { spaceDir } from "./vault.ts";

/**
 * The current conversation of a space, `<space>/.phaethon/thread.json`: an
 * append-only list of messages in Anthropic's Messages shape, plus
 * Phaethon-only blocks (`phaethon_record`, `phaethon_attachment`,
 * `phaethon_continue`) that are stripped before any provider sees them.
 * Assistant blocks are kept exactly as returned (thinking signatures
 * included) and sent back unchanged.
 *
 * This module holds the shapes and the read/write basics every backend
 * needs; conversation listing, archive, edit and search live in
 * `src/server/threads/`.
 */

export type Role = "user" | "assistant";
export type Block = { type: string; [key: string]: unknown };
export type Message = { role: Role; content: Block[]; at?: number; [key: string]: unknown };

export const RECORD_TYPE = "phaethon_record";
export const ATTACHMENT_TYPE = "phaethon_attachment";
export const LEGACY_ATTACHMENT_TYPE = "steward_attachment";
export const CONTINUE_TYPE = "phaethon_continue";

export type ToolCategory = "read" | "list" | "search" | "command" | "write" | "other";
export type ToolStatus = "success" | "failed" | "cancelled" | "incomplete";

/** What the UI shows in a conversation besides text. Saved as `{type:"phaethon_record", kind, ...}`. */
export type Record_ =
  | { kind: "tool"; id: string; category: ToolCategory; label: string; status: ToolStatus; target?: string; detail?: string }
  | { kind: "approval"; path: string; action: "create" | "replace"; allowed: boolean }
  | { kind: "access"; space: string; path: string; answer: "once" | "always" | "deny" }
  | { kind: "read"; space: string; path: string; tool: "read" | "list" | "search"; query?: string }
  | { kind: "stopped" }
  | { kind: "deniedEarlier"; space: string; path: string }
  | { kind: "imported"; from: string; session: string; title?: string }
  // New in the TypeScript core: lesson tools (see src/server/agent).
  | { kind: "lessonPlan"; id: string; goal: string; map: string; nodes: { id: string; label: string }[] }
  | { kind: "check"; id: string; question: string; answered?: boolean; correct?: boolean; confidence?: number }
  | { kind: "progress"; text: string };

export const RECORD_KINDS = new Set(["tool", "approval", "access", "read", "stopped", "deniedEarlier", "imported", "lessonPlan", "check", "progress"]);
/** Records kept on disk but never shown. */
export const HIDDEN_RECORDS = new Set(["deniedEarlier", "imported"]);

export function threadFile(space: string): string {
  return path.join(spaceDir(space), ".phaethon", "thread.json");
}

function check(value: unknown): Message[] {
  if (!Array.isArray(value) || !value.every((m) => m && (m.role === "user" || m.role === "assistant") && Array.isArray(m.content))) {
    throw new Error("thread.json is not a list of messages");
  }
  return value as Message[];
}

/** Parses a conversation file's text; never silently replaces a damaged file. */
export function parseThread(text: string): Message[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`thread.json is not valid JSON: ${(e as Error).message}`);
  }
  return check(value);
}

export function loadFile(file: string): Message[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isNotFound(e)) return [];
    throw e;
  }
  return parseThread(text);
}

export function load(space: string): Message[] {
  return loadFile(threadFile(space));
}

export function save(space: string, messages: Message[]): void {
  writeJsonAtomic(threadFile(space), messages);
}

export function stamped(message: Message): Message {
  return { ...message, at: Date.now() };
}

export function userMessage(text: string, attachments: Block[] = []): Message {
  const content: Block[] = [...attachments];
  if (text.trim() || attachments.length === 0) content.push({ type: "text", text });
  return { role: "user", content };
}

export function recordBlock(record: Record_): Block {
  return { ...record, type: RECORD_TYPE };
}

/** A block back to a record; unknown kinds and bad shapes are ignored. */
export function recordFromBlock(block: Block): Record_ | undefined {
  if (block.type !== RECORD_TYPE) return undefined;
  const { type: _type, ...rest } = block;
  if (typeof rest.kind !== "string" || !RECORD_KINDS.has(rest.kind)) return undefined;
  return rest as unknown as Record_;
}

export function records(messages: Message[]): Record_[] {
  const out: Record_[] = [];
  for (const m of messages) for (const b of m.content) {
    const r = recordFromBlock(b);
    if (r) out.push(r);
  }
  return out;
}

/** What a provider sees: records dropped, empty messages dropped, only role and content. */
export function forProvider(messages: Message[]): { role: Role; content: Block[] }[] {
  const out: { role: Role; content: Block[] }[] = [];
  for (const m of messages) {
    const content = m.content.filter((b) => b.type !== RECORD_TYPE);
    if (content.length) out.push({ role: m.role, content });
  }
  return out;
}

/** The conversation's identity: its first message's timestamp. */
export function threadKey(messages: Message[]): string | undefined {
  const at = messages[0]?.at;
  return typeof at === "number" ? String(at) : undefined;
}

/** Whitespace collapsed; over 60 characters becomes the first 59, trimmed, plus "…". */
export function shortTitle(text: string): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  const chars = [...collapsed];
  if (chars.length <= 60) return collapsed;
  return chars.slice(0, 59).join("").trimEnd() + "…";
}

// ---------------------------------------------------------------------------
// Lesson questions (agent worker). A `check` or `explain_back` tool call ends
// the turn; until the student answers, the call has no tool_result. These
// helpers find that open question so `thread_load` can show it again after a
// reload (`UiMessage.pending`). The answer key and explanation never leave
// the core.

export const QUESTION_TOOLS = new Set(["check", "explain_back"]);

export type PendingQuestion =
  | { kind: "check"; question: { id: string; role: "predict" | "check"; question: string; options: { value: string; label: string }[]; multiSelect: boolean } }
  | { kind: "explainBack"; question: { id: string; question: string } };

/**
 * The tool_use block of the question the conversation is waiting on, if any:
 * a question call in the last assistant message that no later tool result
 * answers, with nothing after that message but tool results (no new user
 * input). When a reply asked more than one, the loop refused the extra ones
 * with an error result, so the one left without a result is the open one.
 */
export function openQuestionCall(messages: Message[]): { index: number; block: Block } | undefined {
  let a = messages.length - 1;
  while (a >= 0 && messages[a].role === "user") a--;
  if (a < 0) return undefined;
  const calls = messages[a].content.filter((b) => b.type === "tool_use" && QUESTION_TOOLS.has(String(b.name)));
  if (!calls.length) return undefined;
  const answered = new Set<unknown>();
  for (const m of messages.slice(a + 1)) {
    if (!m.content.every((b) => b.type === "tool_result")) return undefined;
    for (const b of m.content) answered.add(b.tool_use_id);
  }
  const open = calls.filter((b) => !answered.has(b.id));
  return open.length ? { index: a, block: open[open.length - 1] } : undefined;
}

/** The question as the student sees it (no answer key). */
export function questionView(block: Block): PendingQuestion | undefined {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const id = String(block.id ?? "");
  const question = typeof input.question === "string" ? input.question : "";
  if (block.name === "explain_back") return { kind: "explainBack", question: { id, question } };
  if (block.name !== "check") return undefined;
  // The saved call is what the model sent; weaker models send arrays and booleans as JSON strings.
  const loose = (v: unknown) => {
    if (typeof v !== "string") return v;
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };
  const rawOptions = loose(input.options);
  const options = Array.isArray(rawOptions)
    ? rawOptions
        .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
        .map((o) => ({ value: String(o.value ?? o.label ?? ""), label: String(o.label ?? o.value ?? "") }))
    : [];
  return {
    kind: "check",
    question: { id, role: loose(input.role) === "predict" ? "predict" : "check", question, options, multiSelect: loose(input.multiSelect) === true },
  };
}

export function pendingQuestion(messages: Message[]): PendingQuestion | undefined {
  const open = openQuestionCall(messages);
  return open ? questionView(open.block) : undefined;
}

/** Marks the last shown assistant message with the open question. `ui` is `toUi(messages)`. */
export function attachPending<T extends { role: Role; pending?: unknown }>(ui: T[], messages: Message[]): T[] {
  const pending = pendingQuestion(messages);
  if (!pending) return ui;
  for (let i = ui.length - 1; i >= 0; i--) {
    if (ui[i].role === "assistant") {
      ui[i].pending = pending;
      break;
    }
    if (ui[i].role === "user") break;
  }
  return ui;
}

/**
 * The texts a message shows, in order: its `text` blocks and what the model
 * delivered with `send_to_user` (a tool call whose input is prose for the
 * user). `toUi` uses this so a reload shows what was streamed.
 */
export function shownTexts(message: Message): string[] {
  const out: string[] = [];
  for (const b of message.content) {
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) out.push(b.text);
    else if (message.role === "assistant" && b.type === "tool_use" && b.name === "send_to_user") {
      const text = (b.input as { message?: unknown } | undefined)?.message;
      if (typeof text === "string" && text.trim()) out.push(text);
    }
  }
  return out;
}
