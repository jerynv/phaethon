/**
 * The make-a-quiz flow's pure parts: what the dialog starts with (empty, or
 * prefilled from a chat plan), the stages a run goes through as the core
 * streams its steps, suggestions for an exam whose scope isn't known, and
 * what to tell the person when a run fails. Pure (make-flow.test.ts).
 */
import type { StudyPlan } from "@/features/chat/lib/study-chat";
import type { ExamOption } from "./exam-options";
import type { QuestionKind, ScopeView } from "./types";
import { examKey, type MakeProgress } from "./words";

export type MakeKind = "quiz" | "deck";
export type Difficulty = "easier" | "exam" | "harder";

/** Everything the dialog asks, as the person left it. */
export type MakeDraft = {
  kind: MakeKind;
  /** "courses/<folder>" */
  course: string | null;
  /** Specific files or parts instead of the whole course; empty means the whole course. */
  files: string[];
  /** Test or topics. */
  target: "exam" | "topics";
  /** The test's title as the course names it, or a name the person typed. */
  exam: string;
  /** Topics in plain words ("induction proofs"). */
  focus: string;
  /** What the person says the test covers, when they edit or fill it in. */
  covers: string;
  count: number;
  kinds: QuestionKind[];
  difficulty: Difficulty;
  title: string;
  /** From a chat block: the block's origin (so its card knows it was made) and what was asked. */
  chat?: { origin: string; context: string };
};

export const DEFAULT_KINDS: QuestionKind[] = ["choice", "multi", "truefalse", "short"];
export const SIZES: Record<MakeKind, number[]> = { quiz: [5, 10, 15, 25], deck: [10, 20, 30, 50] };
export const MAX_COUNT: Record<MakeKind, number> = { quiz: 50, deck: 100 };

export function emptyDraft(kind: MakeKind, course: string | null = null): MakeDraft {
  return { kind, course, files: [], target: "exam", exam: "", focus: "", covers: "", count: kind === "quiz" ? 10 : 20, kinds: [...DEFAULT_KINDS], difficulty: "exam", title: "" };
}

/** The course a set of source paths belongs to ("courses/X/files/a.pdf" → "courses/X"), when they agree on one. */
export function courseOfPaths(paths: readonly string[], courses: readonly string[]): string | null {
  const hit = new Set<string>();
  for (const p of paths) {
    const c = courses.find((x) => p === x || p.startsWith(`${x}/`));
    if (!c) return null;
    hit.add(c);
  }
  return hit.size === 1 ? [...hit][0]! : null;
}

const KINDS_KNOWN: QuestionKind[] = ["choice", "multi", "truefalse", "short", "cloze"];

/**
 * A chat block's checked plan as the dialog's draft: its course, test or
 * topics, size and kinds. Sources that are a whole course choose that
 * course; narrower ones are kept as files.
 */
export function draftFromPlan(plan: StudyPlan, courses: readonly string[], question: string): MakeDraft {
  const paths = plan.sources.map((s) => s.path).filter((p) => p !== "courses");
  // Only a course this space has; otherwise the person picks one.
  const course = [plan.scope?.course, courseOfPaths(paths, courses)].find((c): c is string => !!c && courses.includes(c)) ?? (courses.length === 1 ? courses[0]! : null);
  const files = course ? paths.filter((p) => p !== course && p.startsWith(`${course}/`)) : [];
  const kinds = plan.kinds.filter((k): k is QuestionKind => (KINDS_KNOWN as string[]).includes(k));
  const d = emptyDraft(plan.kind, course);
  return {
    ...d,
    files,
    target: plan.exam ? "exam" : plan.focus ? "topics" : "exam",
    exam: plan.exam ?? plan.scope?.exam ?? "",
    focus: plan.focus ?? "",
    covers: plan.scope?.state === "known" && plan.scope.fromUser ? (plan.scope.words ?? "") : "",
    count: Math.min(MAX_COUNT[plan.kind], Math.max(1, plan.count)),
    kinds: kinds.length ? kinds : d.kinds,
    difficulty: plan.difficulty,
    title: plan.title ?? "",
    chat: { origin: plan.origin, context: question.trim() ? `The student asked:\n${question.trim().slice(0, 3000)}` : "" },
  };
}

/** The listed test a name means ("exam 1" is "Test 1"), or null for one the course doesn't list. */
export function matchExam(options: readonly ExamOption[], name: string): ExamOption | null {
  if (!name.trim()) return null;
  return options.find((o) => examKey(o.title) === examKey(name)) ?? null;
}

/** What the dialog knows of the chosen test's scope, and where it came from. */
export type ScopeState =
  | { kind: "none" }
  | { kind: "known"; words: string; option: ExamOption }
  | { kind: "stated"; words: string; option?: ExamOption }
  /** The course was read and doesn't say. */
  | { kind: "unknown"; option?: ExamOption }
  /** The course hasn't been read for its tests yet. */
  | { kind: "unchecked"; option?: ExamOption };

export function scopeState(draft: Pick<MakeDraft, "target" | "exam">, options: readonly ExamOption[], view: ScopeView | null, words: (o: ExamOption) => string): ScopeState {
  if (draft.target !== "exam" || !draft.exam.trim()) return { kind: "none" };
  const option = matchExam(options, draft.exam) ?? undefined;
  if (option?.state === "known" && option.scope) return { kind: "known", words: words(option), option };
  if (option?.state === "stated" && option.stated) return { kind: "stated", words: option.stated, option };
  const mapped = !!view?.map && view.state === "fresh";
  return mapped ? { kind: "unknown", option } : { kind: "unchecked", option };
}

/**
 * Suggestions for a test whose scope isn't known: the course's topics in the
 * order taught (never reference topics), then "through" each homework the
 * map names, so a scope can be said in a tap or two.
 */
export function scopeSuggestions(view: ScopeView | null, max = 10): { topics: string[]; through: string[] } {
  const topics = (view?.map?.topics ?? []).filter((t) => !t.reference).map((t) => t.title);
  const hw = new Set<string>();
  for (const t of view?.map?.topics ?? []) for (const h of t.homework) hw.add(h.replace(/\.(pdf|md|docx)$/i, "").split("/").pop()!);
  return { topics: topics.slice(0, max), through: [...hw].slice(-3).map((h) => `Through ${h}`) };
}

/** Adds or takes away a suggestion in what the person typed, keeping the rest. */
export function toggleSuggestion(text: string, piece: string): string {
  const parts = text
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const at = parts.findIndex((p) => p.toLowerCase() === piece.toLowerCase());
  if (at >= 0) parts.splice(at, 1);
  else parts.push(piece);
  return parts.join(", ");
}

export const hasSuggestion = (text: string, piece: string) => text.split(/\s*[,;]\s*/).some((p) => p.trim().toLowerCase() === piece.toLowerCase());

// ---- A run's stages ----

export type StageId = "read" | "map" | "write" | "check";
export type StageState = "pending" | "active" | "done";
export type Stage = { id: StageId; label: string; state: StageState; detail?: string };

const ORDER: StageId[] = ["read", "map", "write", "check"];

/** Which stage a core step belongs to. Mapping a course is reading it; finding passages per topic is mapping topics. */
export function stageOf(step: string | undefined): StageId | "saved" {
  switch (step) {
    case "reading":
      return "map";
    case "making":
      return "write";
    case "checking":
      return "check";
    case "saving":
      return "saved";
    default:
      return "read";
  }
}

/** The four stages as they stand after `p` (null before the first step arrives). */
export function stages(p: MakeProgress | null, o: { quiz: boolean; course?: string; exam?: string }): Stage[] {
  const noun = o.quiz ? "questions" : "cards";
  const at = stageOf(p?.step);
  const now = at === "saved" ? ORDER.length : ORDER.indexOf(at);
  const detail = (id: StageId): string | undefined => {
    if (!p || stageOf(p.step) !== id) return undefined;
    if (id === "read" && p.step === "mapping") return p.total > 1 ? `Part ${Math.min(p.done + 1, p.total)} of ${p.total}. The first time takes a few minutes.` : "The first time takes a few minutes.";
    if (id === "write" && p.done > 0) return `Rewriting the ${noun} that didn’t pass`;
    if (id === "check") return `${p.kept ?? 0} kept · ${p.dropped ?? 0} dropped${p.total ? ` · ${Math.min(p.done, p.total)} of ${p.total} checked` : ""}`;
    return undefined;
  };
  const labels: Record<StageId, string> = {
    read: `Reading ${o.course ?? "your materials"}`,
    map: o.exam ? `Mapping topics in ${o.exam}` : "Mapping topics",
    write: `Writing ${noun}`,
    check: "Checking each against the source",
  };
  return ORDER.map((id, i) => ({ id, label: labels[id], state: i < now ? "done" : i === now ? "active" : "pending", detail: detail(id) }));
}

// ---- When a run fails ----

export type Advice = { title: string; hint: string; action: "model" | "scope" | "focus" | "retry" };

/** A failed run's message as what happened and what to do next. */
export function advice(message: string, quiz: boolean): Advice {
  const what = quiz ? "the quiz" : "the cards";
  if (/no model|api key|claude code|codex|gemini|not logged in|sign(ed)? in to|in settings|isn’t a model/i.test(message))
    return { title: "The model couldn’t be used", hint: "Pick another model below, or set this one up in Settings.", action: "model" };
  if (/won’t guess|what it covers|tell me what/i.test(message)) return { title: "Say what the test covers", hint: "Add a few words about its scope and try again.", action: "scope" };
  if (/nothing passed|couldn’t find passages|focus|nothing usable/i.test(message))
    return { title: `Couldn’t make ${what} from this`, hint: "Try other topics, more of the course, or fewer questions.", action: "focus" };
  if (/stopped answering|network|timed? ?out|rate/i.test(message)) return { title: "The model stopped answering", hint: "It’s usually brief. Try again in a moment.", action: "retry" };
  return { title: `Couldn’t make ${what}`, hint: "Try again. If it keeps failing, try a different model.", action: "retry" };
}
