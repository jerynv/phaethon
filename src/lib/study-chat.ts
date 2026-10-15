/**
 * A quiz or flashcards offered in a chat reply: the reply ends with a
 * ```phaethon-study block (src-tauri/src/study/chat.rs teaches it and checks
 * it). Here: reading the block while it streams, and saying the checked plan
 * in plain words. Pure, so it is unit-tested (scripts/unit/study-chat.test.ts).
 */

export const STUDY_FENCE = "phaethon-study";

/** Mirrors `Plan` in chat.rs. */
export type StudyPlan = {
  origin: string;
  kind: "quiz" | "deck";
  title?: string;
  focus?: string;
  count: number;
  kinds: string[];
  difficulty: "easier" | "exam" | "harder";
  sources: { path: string; name: string }[];
  /** Sources named that aren't in this space. */
  unknown: string[];
  notes: string[];
  /** What was already made from it. */
  made?: string;
  running: boolean;
  /** The exam it is for, as the block names it. */
  exam?: string;
  /** What is known so far about that exam's scope (from the kept map; nothing is built for the plan). */
  scope?: PlanScope;
  /** Said when the material leans on pages the space's model can't look at (handwriting, diagrams). */
  material?: { kind: "cantSee" | "unknown" | "notShown"; text: string };
};

/** Mirrors `PlanScope` in chat.rs. */
export type PlanScope = {
  exam: string;
  /** "known" (found or said), "unknown" (looked, not found), "unmapped" (not looked yet). */
  state: "known" | "unknown" | "unmapped";
  /** "through HW 6; not graphs or combinatorics" */
  words?: string;
  fromUser: boolean;
  evidence: { source: string; quote: string; at?: string }[];
  /** "courses/<folder>" */
  course: string;
  courseName: string;
};

/** Largest block read (as the core). */
const BLOCK_MAX = 8 * 1024;

export type BlockState =
  | { state: "writing" }
  | { state: "invalid"; why: string }
  | { state: "ok"; block: string; kind: "quiz" | "deck" };

/**
 * The block as far as it has arrived. While the reply is still coming, a
 * block that doesn't read yet is "writing"; once it's done, "invalid".
 * Only the shape is checked here; chat.rs checks everything else.
 */
export function readBlock(code: string, complete: boolean): BlockState {
  const text = code.trim();
  if (text.length > BLOCK_MAX) return { state: "invalid", why: "The plan is too long to read." };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return complete ? { state: "invalid", why: "The plan isn’t written in a form Phaethon can read." } : { state: "writing" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return complete ? { state: "invalid", why: "The plan isn’t written in a form Phaethon can read." } : { state: "writing" };
  }
  const kind = String((v as { kind?: unknown }).kind ?? "").trim().toLowerCase();
  const k = kind === "quiz" ? "quiz" : ["deck", "flashcards", "cards"].includes(kind) ? "deck" : null;
  if (!k) return { state: "invalid", why: "The plan doesn’t say whether it’s a quiz or flashcards." };
  // Still streaming: the JSON may parse before the reply settles; wait for the end.
  if (!complete) return { state: "writing" };
  return { state: "ok", block: text, kind: k };
}

const KIND_WORDS: Record<string, string> = {
  choice: "multiple choice",
  multi: "choose all that apply",
  truefalse: "true or false",
  short: "short answer",
  cloze: "fill in the blank",
};
const DIFFICULTY_WORDS: Record<string, string> = { easier: "easier, recall", exam: "exam level", harder: "harder, several steps" };

/** "a, b and c" */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const kindWords = (kinds: string[]) => listWords(kinds.map((k) => KIND_WORDS[k] ?? k));

/** The plan in one sentence: what, how many, which kinds, from where. */
export function planSentence(p: StudyPlan): string {
  const n = p.kind === "quiz" ? `${p.count} ${p.count === 1 ? "question" : "questions"}` : `${p.count} ${p.count === 1 ? "card" : "cards"}`;
  const what = p.kind === "quiz" ? `A quiz of ${n}` : `A deck of ${n}`;
  const kinds = p.kind === "quiz" && p.kinds.length ? ` (${kindWords(p.kinds)})` : "";
  const level = p.kind === "quiz" ? `, ${DIFFICULTY_WORDS[p.difficulty] ?? p.difficulty}` : "";
  const on = p.focus ? ` on ${p.focus}` : "";
  const from = p.sources.length ? `, from ${listWords(p.sources.map((s) => s.name))}` : "";
  return `${what}${on}${kinds}${level}${from}.`;
}

/** The title shown on the card: the plan's own, else what it is. */
export const planTitle = (p: StudyPlan) => p.title ?? (p.kind === "quiz" ? "Practice quiz" : "Flashcards");

/** The button's words. */
export const makeLabel = (p: Pick<StudyPlan, "kind">) => (p.kind === "quiz" ? "Generate quiz" : "Make flashcards");
export const openLabel = (p: Pick<StudyPlan, "kind">) => (p.kind === "quiz" ? "Open quiz" : "Study these cards");

/** The text of the user message before the reply `id` in `messages`, for context. */
export function questionBefore(messages: readonly { id: string; role: string; content: readonly { type: string; text?: string }[] }[], id: string): string {
  const at = messages.findIndex((m) => m.id === id);
  for (let i = (at < 0 ? messages.length : at) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user") return m.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
  }
  return "";
}
