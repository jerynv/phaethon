/**
 * What a turn streams to the renderer over `agent_send`'s `onEvent` Channel.
 * Every backend (Phaethon's own loop and the CLIs) speaks this. The first
 * twelve kinds are exactly the old Tauri `AgentEvent` JSON; the rest are new
 * in the TypeScript core.
 */

export type ToolCategory = "read" | "list" | "search" | "command" | "write" | "other";
export type ToolStatus = "success" | "failed" | "cancelled" | "incomplete";
export type AccessAnswer = "once" | "always" | "deny";

export type ErrorCode =
  | "missingCli"
  | "notLoggedIn"
  | "busy"
  | "invalidSpace"
  | "cli"
  | "noApiKey"
  | "apiKey"
  | "provider"
  | "billing"
  | "rateLimit"
  | "unavailable"
  | "badRequest"
  | "network"
  | "declined"
  | "storage"
  | "attachment";

/** A conversation record as the UI sees it (the saved block without `type`). */
export type UiRecord =
  | { kind: "tool"; id: string; category: ToolCategory; label: string; status: ToolStatus | "running"; target?: string; detail?: string }
  | { kind: "approval"; path: string; action: "create" | "replace"; allowed: boolean }
  | { kind: "access"; space: string; path: string; answer: AccessAnswer }
  | { kind: "read"; space: string; path: string; tool: "read" | "list" | "search"; query?: string }
  | { kind: "stopped" }
  | { kind: "lessonPlan"; id: string; goal: string; map: string; nodes: { id: string; label: string }[] }
  | { kind: "check"; id: string; question: string; answered?: boolean; correct?: boolean; confidence?: number }
  /** A progress note the model wrote between tool calls (saved so a reload shows what was streamed). */
  | { kind: "progress"; text: string };

/** A graded question the model asked with the `check` tool; the turn ends until it's answered. */
export type CheckQuestion = {
  id: string;
  /** "predict" asks before teaching (no wrong answer), "check" tests what was just taught. */
  role: "predict" | "check";
  question: string;
  options: { value: string; label: string }[];
  multiSelect: boolean;
};

/** A free-recall prompt from the `explain_back` tool. */
export type ExplainBackQuestion = { id: string; question: string };

/** The student's answer, sent with `lesson_answer`. */
export type LessonAnswer = {
  /** Chosen option values (check) — empty with `dontKnow`. */
  answers?: string[];
  /** Free text (explain_back). */
  text?: string;
  dontKnow?: boolean;
  /** 0–100, how sure they were. */
  confidence?: number;
  /** Their own reasoning, in their words. */
  thinking?: string;
};

export type AgentEvent =
  | { kind: "text"; delta: string }
  | { kind: "tool"; label: string }
  | { kind: "toolStart"; id: string; category: ToolCategory; label: string; target?: string }
  | { kind: "toolEnd"; id: string; status: ToolStatus; detail?: string }
  | { kind: "error"; code: ErrorCode; message: string; retryAfterSecs?: number }
  | { kind: "approval"; id: string; summary: string; detail: string; action: "create" | "replace"; path: string; space: string; before: string | null; truncated: boolean }
  | { kind: "record"; record: UiRecord }
  | { kind: "approvalDone"; id: string; allowed: boolean }
  | { kind: "accessRequest"; id: string; space: string; path: string; reason: string }
  | { kind: "accessRequestDone"; id: string; answer: AccessAnswer }
  | { kind: "cancelled" }
  | { kind: "end"; sessionId: string | null }
  // New: progress the model narrates between tool calls (Claude "update" thinking blocks, send_to_user).
  | { kind: "progress"; text: string }
  // New: the model's visible reasoning summary, when the provider returns one.
  | { kind: "thinking"; delta: string }
  // New: lesson tools. The turn ends after a question; the answer arrives through `lesson_answer`.
  | { kind: "check"; question: CheckQuestion }
  | { kind: "explainBack"; question: ExplainBackQuestion };

/** A message as `thread_load` returns it. */
export type UiMessage = {
  role: "user" | "assistant";
  text: string;
  attachments: { name: string; path: string; mediaType: string }[];
  index: number;
  records: UiRecord[];
  at?: number;
  /** New: an unanswered question this message ends with (lesson tools). */
  pending?: { kind: "check"; question: CheckQuestion } | { kind: "explainBack"; question: ExplainBackQuestion };
};
