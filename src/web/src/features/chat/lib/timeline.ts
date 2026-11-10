/**
 * The conversation as the timeline shows it, built from `thread_load`'s
 * UiMessages and updated by each AgentEvent of a running turn. Pure, so the
 * event handling is unit-tested.
 */
import type {
  AccessAnswer,
  AgentEvent,
  CheckQuestion,
  ErrorCode,
  ExplainBackQuestion,
  ToolStatus,
  UiMessage,
  UiRecord,
} from "#shared/agent.ts";

export type Attachment = { name: string; mediaType: string; path?: string; previewUrl?: string; size?: number };

export type ToolRecord = Extract<UiRecord, { kind: "tool" }>;

export type Part =
  | { type: "text"; text: string }
  | { type: "record"; record: UiRecord }
  | { type: "progress"; text: string }
  | { type: "thinking"; text: string };

export type PendingApproval = Omit<Extract<AgentEvent, { kind: "approval" }>, "kind">;
export type PendingAccess = Omit<Extract<AgentEvent, { kind: "accessRequest" }>, "kind">;
export type PendingQuestion = { kind: "check"; question: CheckQuestion } | { kind: "explainBack"; question: ExplainBackQuestion };

export type UserMessage = {
  role: "user";
  key: string;
  index?: number;
  at?: number;
  text: string;
  attachments: Attachment[];
};

export type ReplyStatus = "streaming" | "done" | "stopped" | "failed";

export type AssistantMessage = {
  role: "assistant";
  key: string;
  index?: number;
  at?: number;
  parts: Part[];
  status: ReplyStatus;
  error?: { code: ErrorCode | "ipc"; message: string; retryAfterSecs?: number };
  /** The latest `tool` status line ("Reading file notes.md"). */
  toolStatus?: string;
  approval?: PendingApproval;
  access?: PendingAccess;
  question?: PendingQuestion;
  /** A continued reply: how many characters of text it had before. */
  continuedAfter?: number;
  /** The next text starts a new paragraph (a continued reply). */
  joinNext?: boolean;
  /** Streamed in this window (only these are announced when they finish). */
  live?: boolean;
};

export type Message = UserMessage | AssistantMessage;

let seq = 0;
export const newKey = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The saved conversation as timeline messages. Tool work first, then the words, then receipts. */
export function fromUi(saved: UiMessage[]): Message[] {
  return saved.map((m, i): Message => {
    if (m.role === "user") {
      return {
        role: "user",
        key: `s${m.index}-${i}`,
        index: m.index,
        at: m.at,
        text: m.text,
        attachments: m.attachments.map((a) => ({ name: a.name, path: a.path, mediaType: a.mediaType })),
      };
    }
    const tools = m.records.filter((r) => r.kind === "tool");
    const others = m.records.filter((r) => r.kind !== "tool");
    const parts: Part[] = [
      ...tools.map((record): Part => ({ type: "record", record })),
      ...(m.text ? [{ type: "text", text: m.text } as Part] : []),
      ...others.map((record): Part => ({ type: "record", record })),
    ];
    return {
      role: "assistant",
      key: `s${m.index}-${i}`,
      index: m.index,
      at: m.at,
      parts,
      status: m.records.some((r) => r.kind === "stopped") ? "stopped" : "done",
      question: m.pending,
    };
  });
}

/** A reply about to stream. */
export function startReply(): AssistantMessage {
  return { role: "assistant", key: newKey("a"), parts: [], status: "streaming", live: true };
}

const isWaitingLine = (label: string | undefined) => !!label?.startsWith("Waiting for you");

function settleTools(parts: Part[], status: ToolStatus): Part[] {
  return parts.map((p) =>
    p.type === "record" && p.record.kind === "tool" && p.record.status === "running" ? { ...p, record: { ...p.record, status } } : p,
  );
}

function putRecord(parts: Part[], record: UiRecord): Part[] {
  if (record.kind === "tool" || record.kind === "check" || record.kind === "lessonPlan") {
    const at = parts.findIndex((p) => p.type === "record" && p.record.kind === record.kind && "id" in p.record && p.record.id === record.id);
    if (at >= 0) return parts.map((p, i) => (i === at ? { type: "record", record } : p));
  }
  if (record.kind === "stopped" && parts.some((p) => p.type === "record" && p.record.kind === "stopped")) return parts;
  return [...parts, { type: "record", record }];
}

/** One event of a running turn applied to its reply. */
export function applyEvent(m: AssistantMessage, e: AgentEvent, now: number = Date.now()): AssistantMessage {
  switch (e.kind) {
    case "text": {
      const parts = m.parts;
      const last = parts[parts.length - 1];
      const prevText = [...parts].reverse().find((p) => p.type === "text");
      const joint = m.joinNext && prevText && prevText.text !== "" ? "\n\n" : "";
      const next: Part[] =
        last?.type === "text"
          ? [...parts.slice(0, -1), { type: "text", text: last.text + joint + e.delta }]
          : [...parts, { type: "text", text: joint ? e.delta.replace(/^\s+/, "") : e.delta }];
      return { ...m, parts: next, toolStatus: undefined, joinNext: false };
    }
    case "tool":
      return { ...m, toolStatus: e.label };
    case "toolStart":
      return {
        ...m,
        parts: putRecord(m.parts, { kind: "tool", id: e.id, category: e.category, label: e.label, target: e.target, status: "running" }),
      };
    case "toolEnd": {
      const prior = m.parts.find((p) => p.type === "record" && p.record.kind === "tool" && p.record.id === e.id);
      if (!prior || prior.type !== "record" || prior.record.kind !== "tool") return m;
      const toolStatus = isWaitingLine(m.toolStatus) ? m.toolStatus : undefined;
      return { ...m, toolStatus, parts: putRecord(m.parts, { ...prior.record, status: e.status, detail: e.detail }) };
    }
    case "record":
      return { ...m, parts: putRecord(m.parts, e.record) };
    case "progress":
      return { ...m, parts: [...m.parts, { type: "progress", text: e.text }], toolStatus: undefined };
    case "thinking": {
      const last = m.parts[m.parts.length - 1];
      const parts: Part[] =
        last?.type === "thinking"
          ? [...m.parts.slice(0, -1), { type: "thinking", text: last.text + e.delta }]
          : [...m.parts, { type: "thinking", text: e.delta }];
      return { ...m, parts };
    }
    case "approval": {
      const { kind: _k, ...approval } = e;
      return { ...m, approval };
    }
    case "approvalDone":
      return m.approval?.id === e.id ? { ...m, approval: undefined, toolStatus: isWaitingLine(m.toolStatus) ? undefined : m.toolStatus } : m;
    case "accessRequest": {
      const { kind: _k, ...access } = e;
      return { ...m, access };
    }
    case "accessRequestDone":
      return m.access?.id === e.id ? { ...m, access: undefined, toolStatus: isWaitingLine(m.toolStatus) ? undefined : m.toolStatus } : m;
    case "check":
      return { ...m, question: { kind: "check", question: e.question } };
    case "explainBack":
      return { ...m, question: { kind: "explainBack", question: e.question } };
    case "error":
      return {
        ...m,
        parts: settleTools(m.parts, "failed"),
        status: "failed",
        error: { code: e.code, message: e.message, retryAfterSecs: e.retryAfterSecs },
        toolStatus: undefined,
        approval: undefined,
        access: undefined,
      };
    case "cancelled":
      return { ...m, parts: settleTools(m.parts, "cancelled"), status: "stopped", toolStatus: undefined, approval: undefined, access: undefined };
    case "end":
      return {
        ...m,
        parts: settleTools(m.parts, "incomplete"),
        status: m.status === "streaming" ? "done" : m.status,
        toolStatus: undefined,
        approval: undefined,
        access: undefined,
        at: now,
      };
  }
}

/** The reply's words so far. */
export function replyText(m: AssistantMessage): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
    .trim();
}

export const isStopped = (m: AssistantMessage) =>
  m.status === "stopped" || m.parts.some((p) => p.type === "record" && p.record.kind === "stopped");

/** A stopped reply made ready to carry on: its stop marker goes, new words join after a paragraph break. */
export function continueReply(m: AssistantMessage): AssistantMessage {
  const kept = m.parts.filter((p) => !(p.type === "record" && p.record.kind === "stopped"));
  let lastText = -1;
  kept.forEach((p, i) => p.type === "text" && (lastText = i));
  const parts = kept.map((p, i): Part => (i === lastText && p.type === "text" ? { type: "text", text: p.text.trimEnd() } : p));
  return {
    ...m,
    parts,
    status: "streaming",
    error: undefined,
    live: true,
    joinNext: true,
    continuedAfter: replyText(m).length,
  };
}

/**
 * After a turn, the conversation as saved: the live messages keep their
 * look and get the saved positions (what edit and regenerate need). When the
 * lists don't line up, the saved one replaces them, unless it is shorter or
 * `keepLive` (a failed turn that may not have been saved): then the live
 * messages stay, with positions wherever the two agree from the start.
 */
export function mergeSaved(live: Message[], saved: UiMessage[], keepLive = false): Message[] {
  const fresh = fromUi(saved);
  const aligned = fresh.length === live.length && fresh.every((m, i) => m.role === live[i].role);
  // A save that has fewer messages than shown (not written yet, or a failed
  // turn) never wipes what is on screen.
  if (!aligned && !keepLive && fresh.length >= live.length) return fresh;
  let agree = true;
  return live.map((m, i) => {
    const s = fresh[i];
    if (!agree || !s || s.role !== m.role) {
      agree = false;
      return m;
    }
    if (m.role === "user" && s.role === "user") {
      if (!aligned && s.text !== m.text) {
        agree = false;
        return m;
      }
      return { ...m, index: s.index, at: m.at ?? s.at, attachments: s.attachments.map((a, j) => ({ ...a, previewUrl: m.attachments[j]?.previewUrl })) };
    }
    if (m.role === "assistant" && s.role === "assistant") {
      return { ...m, index: s.index, at: m.at ?? s.at, question: m.question ?? s.question };
    }
    return m;
  });
}

/** What the timeline draws for a reply, in order: consecutive tool records gathered into one work group. */
export type Segment =
  | { type: "text"; key: string; text: string }
  | { type: "work"; key: string; tools: ToolRecord[] }
  | { type: "progress"; key: string; text: string }
  | { type: "thinking"; key: string; text: string }
  | { type: "record"; key: string; record: Exclude<UiRecord, { kind: "tool" }> };

export function segments(parts: Part[]): Segment[] {
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    const key = `${p.type}-${i}`;
    if (p.type === "record" && p.record.kind === "tool") {
      const last = out[out.length - 1];
      if (last?.type === "work") last.tools.push(p.record);
      else out.push({ type: "work", key, tools: [p.record] });
      return;
    }
    if (p.type === "record") out.push({ type: "record", key, record: p.record as Exclude<UiRecord, { kind: "tool" }> });
    else if (p.type === "text") {
      if (p.text.trim() !== "") out.push({ type: "text", key, text: p.text });
    } else out.push({ type: p.type, key, text: p.text });
  });
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Read 3 files, searched twice" for a finished work group. */
export function workSummary(tools: ToolRecord[]): string {
  const count = (c: string) => tools.filter((t) => t.category === c).length;
  const bits: string[] = [];
  const read = count("read");
  const list = count("list");
  const search = count("search");
  const write = count("write");
  const command = count("command");
  const other = count("other");
  if (read) bits.push(`read ${plural(read, "file", "files")}`);
  if (list) bits.push(`listed ${plural(list, "folder", "folders")}`);
  if (search) bits.push(search === 1 ? "searched once" : search === 2 ? "searched twice" : `searched ${search} times`);
  if (write) bits.push(`changed ${plural(write, "file", "files")}`);
  if (command) bits.push(`ran ${plural(command, "command", "commands")}`);
  if (other) bits.push(plural(other, "other step", "other steps"));
  const failed = tools.filter((t) => t.status === "failed").length;
  if (failed) bits.push(`${failed} failed`);
  const s = bits.join(", ");
  return s ? s[0].toUpperCase() + s.slice(1) : "Worked";
}

export const accessVerb: Record<AccessAnswer, string> = { once: "Allowed once", always: "Always allowed", deny: "Not allowed" };

/** A record in words, as the live region says it. */
export function recordText(r: UiRecord, spaceName: (id: string) => string = (id) => id): string {
  const where = (space: string, path: string) => {
    const clean = path.replace(/\/+$/, "");
    return clean ? `${spaceName(space)} / ${clean}` : `all of ${spaceName(space)}`;
  };
  switch (r.kind) {
    case "tool":
      return `${r.label}: ${r.status}${r.detail ? `, ${r.detail}` : ""}`;
    case "approval":
      return `${r.allowed ? "Allowed" : "Not allowed"}: ${r.action} ${r.path}`;
    case "access":
      return `${accessVerb[r.answer]}: ${where(r.space, r.path)}`;
    case "read":
      return r.tool === "search"
        ? `Searched ${where(r.space, r.path)}${r.query ? ` for “${r.query}”` : ""}`
        : `${r.tool === "list" ? "Listed" : "Read"} ${where(r.space, r.path)}`;
    case "stopped":
      return "Reply stopped";
    case "lessonPlan":
      return `Lesson plan: ${r.goal}`;
    case "check":
      return `Question: ${r.question}`;
    case "progress":
      return r.text;
  }
}

/** True while the turn waits on the person: a write, an access request or a question. */
export function needsYou(m: Message | undefined): boolean {
  return !!m && m.role === "assistant" && !!(m.approval || m.access || m.question);
}
