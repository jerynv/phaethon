/** Typed calls for Study (the old Tauri commands, one to one). */
import { Channel, invoke } from "@/lib/core";

import { shortCourseName } from "../courses/lib/course-name";
import { untilTerminal, type StreamEnd } from "../courses/lib/stream";
import type { ModelPick } from "@/features/chat/api";
import type {
  CardInput,
  CitationCheck,
  Confidence,
  CourseSource,
  DeckOptions,
  DeckView,
  Quiz,
  QuizOptions,
  ScopeView,
  SessionCard,
  StudyEvent,
  StudyOverview,
} from "./lib/types";

/** The courses Study can draw on, named as people read them ("XX99: INTRO PLACEHOLDER STUDIES: 1234" → "Intro Placeholder Studies"). */
export const studySources = async (space: string) => (await invoke<CourseSource[]>("study_sources", { space })).map((s) => ({ ...s, name: shortCourseName(s.name) }));
export const studyOverview = (space: string) => invoke<StudyOverview>("study_overview", { space });
export const studyDeck = (space: string, path: string) => invoke<DeckView>("study_deck", { space, path });
export const studyDeckSave = (space: string, path: string | null, title: string, cards: CardInput[]) =>
  invoke<string>("study_deck_save", { space, path, title, cards });
/** Cards to show: due first, then new. `paths` null = every deck; chosen decks also offer cards due later. */
export const studySession = async (space: string, paths: string[] | null, limit = 40) => {
  const cards = await invoke<SessionCard[]>("study_session", { space, paths, limit });
  if (cards.length) void invoke("telemetry_usage", { event: "action_completed", data: { action: "study_started" } }).catch(() => {});
  return cards;
};
export const studyRate = (space: string, deck: string, card: string, confidence: Confidence) =>
  invoke<{ due: number; again: boolean }>("study_rate", { space, deck, card, confidence });
export const studyQuiz = (space: string, path: string) => invoke<Quiz>("study_quiz", { space, path });
export const studyDelete = (space: string, path: string) => invoke<void>("study_delete", { space, path });
export const studyScope = (space: string, course: string, model?: ModelPick | null) => invoke<ScopeView>("study_scope", { space, course, ...(model ? { model } : {}) });
export const studyScopeState = (space: string, course: string, exam: string, text: string) =>
  invoke<void>("study_scope_state", { space, course, exam, text });
export const studyCitationsCheck = (space: string, citations: { path: string; quote: string }[]) =>
  invoke<CitationCheck[]>("study_citations_check", { space, citations });

/** A streaming study command; resolves once its last event (done, error, cancelled) has arrived. */
function stream(cmd: string, args: Record<string, unknown>, onEvent: (e: StudyEvent) => void): Promise<StreamEnd> {
  return untilTerminal<StudyEvent>(
    (on) => invoke<void>(cmd, { ...args, onEvent: new Channel<StudyEvent>(on) }),
    onEvent,
    (e) => e.type === "done" || e.type === "error" || e.type === "cancelled",
  );
}

/**
 * How a run is asked: `model` is the pick made in the dialog (the core uses
 * the current conversation's when absent), `runId` lets `studyMakeCancel`
 * stop it, `origin` is the chat block it was made for.
 */
export type RunOptions = { model?: ModelPick | null; runId?: string; origin?: string };
const runArgs = (o: RunOptions = {}) => ({ ...(o.model ? { model: o.model } : {}), ...(o.runId ? { runId: o.runId } : {}), ...(o.origin ? { origin: o.origin } : {}) });

export const studyMakeDeck = (space: string, sources: string[], options: DeckOptions, onEvent: (e: StudyEvent) => void, run?: RunOptions) =>
  stream("study_make_deck", { space, sources, options, ...runArgs(run) }, onEvent);
export const studyMakeQuiz = (space: string, sources: string[], options: QuizOptions, onEvent: (e: StudyEvent) => void, run?: RunOptions) =>
  stream("study_make_quiz", { space, sources, options, ...runArgs(run) }, onEvent);
/** Stops the make or mapping run started with `runId`; false when none is running. */
export const studyMakeCancel = (space: string, runId: string) => invoke<boolean>("study_make_cancel", { space, runId });
export const studyQuizSubmit = (space: string, path: string, answers: Record<string, string | string[]>, onEvent: (e: StudyEvent) => void, model?: ModelPick | null) =>
  stream("study_quiz_submit", { space, path, answers, ...runArgs({ model }) }, onEvent);
export const studyReviewMistakes = (space: string, attemptPath: string, onEvent: (e: StudyEvent) => void, model?: ModelPick | null) =>
  stream("study_review_mistakes", { space, attemptPath, ...runArgs({ model }) }, onEvent);

/** Map what a course teaches and what each test covers, so a quiz for a test can be grounded. */
export const studyScopeBuild = (space: string, course: string, onEvent: (e: StudyEvent) => void, run?: RunOptions) =>
  stream("study_scope_build", { space, course, ...runArgs(run) }, onEvent);
