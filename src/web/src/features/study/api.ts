/** Typed calls for Study (the old Tauri commands, one to one). */
import { Channel, invoke } from "@/lib/core";

import { untilTerminal, type StreamEnd } from "../courses/lib/stream";
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

export const studySources = (space: string) => invoke<CourseSource[]>("study_sources", { space });
export const studyOverview = (space: string) => invoke<StudyOverview>("study_overview", { space });
export const studyDeck = (space: string, path: string) => invoke<DeckView>("study_deck", { space, path });
export const studyDeckSave = (space: string, path: string | null, title: string, cards: CardInput[]) =>
  invoke<string>("study_deck_save", { space, path, title, cards });
/** Cards to show: due first, then new. `paths` null = every deck; chosen decks also offer cards due later. */
export const studySession = (space: string, paths: string[] | null, limit = 40) => invoke<SessionCard[]>("study_session", { space, paths, limit });
export const studyRate = (space: string, deck: string, card: string, confidence: Confidence) =>
  invoke<{ due: number; again: boolean }>("study_rate", { space, deck, card, confidence });
export const studyQuiz = (space: string, path: string) => invoke<Quiz>("study_quiz", { space, path });
export const studyDelete = (space: string, path: string) => invoke<void>("study_delete", { space, path });
export const studyScope = (space: string, course: string) => invoke<ScopeView>("study_scope", { space, course });
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

export const studyMakeDeck = (space: string, sources: string[], options: DeckOptions, onEvent: (e: StudyEvent) => void) =>
  stream("study_make_deck", { space, sources, options }, onEvent);
export const studyMakeQuiz = (space: string, sources: string[], options: QuizOptions, onEvent: (e: StudyEvent) => void) =>
  stream("study_make_quiz", { space, sources, options }, onEvent);
export const studyQuizSubmit = (space: string, path: string, answers: Record<string, string | string[]>, onEvent: (e: StudyEvent) => void) =>
  stream("study_quiz_submit", { space, path, answers }, onEvent);
export const studyReviewMistakes = (space: string, attemptPath: string, onEvent: (e: StudyEvent) => void) =>
  stream("study_review_mistakes", { space, attemptPath }, onEvent);
