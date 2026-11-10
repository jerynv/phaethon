import "../plan/commands.ts";
import { spaceDir } from "../core/vault.ts";
import { commands, type Channel } from "../rpc/registry.ts";
import * as chat from "./chat.ts";
import * as citations from "./citations.ts";
import { errText } from "./files.ts";
import { makeDeck, makeQuiz, review, submit, type DeckOptions, type QuizOptions } from "./generate.ts";
import * as material from "./material.ts";
import { modelForSpace, type Model } from "./model.ts";
import * as scope from "./scope.ts";
import { sightForSpace } from "./sight.ts";
import * as sources from "./sources.ts";
import * as store from "./store.ts";
import type { Answer, ExamScope, Finished, ScopeMap, Stated, StudyEvent } from "./types.ts";
import { progress } from "./types.ts";
import { visibleFor } from "./visible.ts";

/**
 * The study_* commands, with the old Tauri names, camelCase arguments, return
 * JSON and StudyEvent channel messages. Streaming commands always resolve and
 * report every outcome as exactly one final `done`, `error` or `cancelled`.
 */

type Events = Channel<StudyEvent>;

function sender(onEvent: Events | undefined): (e: StudyEvent) => void {
  return (e) => {
    try {
      onEvent?.send(e);
    } catch {
      // The window may have reloaded; the work still finishes.
    }
  };
}

/** Runs one streaming command: any throw becomes the final `error` event. */
async function stream(onEvent: Events | undefined, work: (emit: (e: StudyEvent) => void) => Promise<Finished | null>): Promise<null> {
  const emit = sender(onEvent);
  try {
    const done = await work(emit);
    if (done) emit({ type: "done", ...done });
  } catch (e) {
    emit({ type: "error", message: errText(e) });
  }
  return null;
}

function strings(v: unknown, name: string, cmd: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw `invalid args \`${name}\` for command \`${cmd}\`: expected a list of text`;
  return v as string[];
}

function text(v: unknown, name: string, cmd: string): string {
  if (typeof v !== "string") throw `invalid args \`${name}\` for command \`${cmd}\`: expected text`;
  return v;
}

/** The model for this space, made only when first needed (grading a short answer, a review). */
function lazyModel(space: string): () => Model {
  let m: Model | null = null;
  return () => (m ??= modelForSpace(space));
}

function scopeMaterial(space: string, course: string) {
  const visible = visibleFor(space);
  const seen = scope.seenCourse(visible, course);
  const kept = scope.cached(visible, seen, null);
  const map: ScopeMap | null = kept?.[0] ?? null;
  const exams: ExamScope[] = map ? map.exams.map((e) => ({ ...e })) : [];
  const stated: Stated[] = scope.stated(visible, seen);
  for (const s of stated) {
    const resolved = map !== null && map.fingerprint === s.resolvedFor && s.includes.length > 0;
    const said: ExamScope = {
      title: s.exam,
      known: resolved,
      summary: s.text,
      includes: s.includes,
      excludes: s.excludes,
      excludedWords: [],
      homework: [],
      evidence: [],
      fromUser: true,
    };
    const at = exams.findIndex((e) => scope.findExam([said], e.title) !== null);
    if (at >= 0) {
      if (resolved) {
        const e = exams[at]!;
        const merged: ExamScope = { ...said, title: e.title };
        if (e.date !== undefined) merged.date = e.date;
        exams[at] = merged;
      }
    } else exams.push(said);
  }
  return { visible, seen, kept, map, stated, view: material.view(seen, map, exams, sightForSpace(space)) };
}

commands({
  study_sources: ({ space }: { space: string }) => {
    spaceDir(space);
    return sources.courses(visibleFor(space));
  },

  study_overview: ({ space }: { space: string }) => store.overview(spaceDir(space), Date.now()),

  study_deck: ({ space, path }: { space: string; path: string }) => store.deckView(spaceDir(space), text(path, "path", "study_deck")),

  study_deck_save: ({ space, path, title, cards }: { space: string; path?: string | null; title: string; cards: store.CardInput[] }) => {
    const dir = spaceDir(space);
    if (!Array.isArray(cards) || cards.some((c) => !c || typeof c.front !== "string")) throw "invalid args `cards` for command `study_deck_save`: each card needs a front";
    return store.deckSave(dir, path ?? null, text(title, "title", "study_deck_save"), cards);
  },

  study_session: ({ space, paths, limit }: { space: string; paths?: string[] | null; limit?: number | null }) => {
    const dir = spaceDir(space);
    return store.session(dir, paths == null ? null : strings(paths, "paths", "study_session"), limit ?? store.SESSION_DEFAULT, Date.now());
  },

  study_rate: ({ space, deck, card, confidence }: { space: string; deck: string; card: string; confidence: unknown }) => {
    const dir = spaceDir(space);
    if (typeof confidence !== "number" || !Number.isInteger(confidence) || confidence < 0 || confidence > 255) {
      throw "invalid args `confidence` for command `study_rate`: expected a whole number from 0 to 255";
    }
    return store.rate(dir, text(deck, "deck", "study_rate"), text(card, "card", "study_rate"), confidence, Date.now());
  },

  study_quiz: ({ space, path }: { space: string; path: string }) => store.loadQuiz(spaceDir(space), text(path, "path", "study_quiz"))[1],

  study_delete: ({ space, path }: { space: string; path: string }) => {
    store.deleteItem(spaceDir(space), text(path, "path", "study_delete"));
    return null;
  },

  study_make_deck: ({ space, sources: inputs, options, onEvent }: { space: string; sources: string[]; options?: DeckOptions; onEvent: Events }) =>
    stream(onEvent, async (emit) => {
      const dir = spaceDir(space);
      const model = modelForSpace(space);
      const [path, cards, grounding] = await makeDeck(dir, visibleFor(space), strings(inputs, "sources", "study_make_deck"), options ?? {}, model, emit, Date.now());
      return { path, cards, grounding };
    }),

  study_make_quiz: ({ space, sources: inputs, options, onEvent }: { space: string; sources: string[]; options?: QuizOptions; onEvent: Events }) =>
    stream(onEvent, async (emit) => {
      const dir = spaceDir(space);
      const model = modelForSpace(space);
      const [path, questions, grounding] = await makeQuiz(dir, visibleFor(space), strings(inputs, "sources", "study_make_quiz"), options ?? {}, model, emit, Date.now());
      return { path, questions, grounding };
    }),

  study_quiz_submit: ({ space, path, answers, onEvent }: { space: string; path: string; answers?: Record<string, Answer>; onEvent: Events }) =>
    stream(onEvent, async (emit) => {
      const dir = spaceDir(space);
      const attempt = await submit(dir, text(path, "path", "study_quiz_submit"), answers ?? {}, lazyModel(space), emit, Date.now());
      return { attempt };
    }),

  study_review_mistakes: ({ space, attemptPath, onEvent }: { space: string; attemptPath: string; onEvent: Events }) =>
    stream(onEvent, async (emit) => {
      const dir = spaceDir(space);
      const summary = await review(dir, text(attemptPath, "attemptPath", "study_review_mistakes"), lazyModel(space), emit);
      return { summary };
    }),

  study_chat_plan: ({ space, block, question }: { space: string; block: string; question: string }) => {
    const dir = spaceDir(space);
    const visible = visibleFor(space);
    const p = chat.plan(dir, visible, text(block, "block", "study_chat_plan"), text(question, "question", "study_chat_plan"));
    const alert = chat.materialAlert(dir, visible, p, sightForSpace(space));
    if (alert) p.material = alert;
    return p;
  },

  study_chat_make: ({ space, block, question, reply, onEvent }: { space: string; block: string; question: string; reply: string; onEvent: Events }) => {
    const emit = sender(onEvent);
    return (async () => {
      let run: ReturnType<typeof chat.claimRun> = null;
      try {
        const dir = spaceDir(space);
        const visible = visibleFor(space);
        const p = chat.plan(dir, visible, block, question);
        const doneEvent = (path: string, n: number, grounding: Finished["grounding"] | null): StudyEvent => {
          const f: StudyEvent = p.kind === "quiz" ? { type: "done", path, questions: n } : { type: "done", path, cards: n };
          if (grounding) f.grounding = grounding;
          return f;
        };
        if (p.made) {
          emit(doneEvent(p.made, chat.countOf(dir, p.made), null));
          return null;
        }
        run = chat.claimRun(dir, p.origin);
        if (!run) throw "This is already being made. It opens in Study when it’s ready.";
        const signal = run.abort.signal;
        const model = modelForSpace(space, signal);
        let stopped = false;
        const quietEmit = (e: StudyEvent) => {
          if (!stopped) emit(e);
        };
        const cancelled = new Promise<"cancelled">((resolve) => {
          if (signal.aborted) resolve("cancelled");
          signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
        });
        const making = chat.make(dir, visible, p, question, reply, model, quietEmit, Date.now());
        making.catch(() => {});
        const first = await Promise.race([making, cancelled]);
        if (first === "cancelled") {
          stopped = true;
          emit({ type: "cancelled" });
          return null;
        }
        const [path, n, grounding] = first;
        emit(doneEvent(path, n, grounding));
      } catch (e) {
        emit({ type: "error", message: errText(e) });
      } finally {
        if (run) chat.releaseRun(run);
      }
      return null;
    })();
  },

  study_chat_cancel: ({ space, origin }: { space: string; origin: string }) => chat.cancel(spaceDir(space), text(origin, "origin", "study_chat_cancel")),

  study_scope: ({ space, course }: { space: string; course: string }) => {
    spaceDir(space);
    const { seen, kept, stated, view } = scopeMaterial(space, text(course, "course", "study_scope"));
    const out: Record<string, unknown> = { course: `courses/${seen.state.folder}`, name: seen.state.name, state: kept ? (kept[1] ? "fresh" : "stale") : "none" };
    if (kept) out.map = kept[0];
    out.stated = stated;
    if (view) out.material = view;
    return out;
  },

  study_scope_build: ({ space, course, onEvent }: { space: string; course: string; onEvent: Events }) =>
    stream(onEvent, async (emit) => {
      const dir = spaceDir(space);
      const visible = visibleFor(space);
      const seen = scope.seenCourse(visible, text(course, "course", "study_scope_build"));
      emit(progress("mapping", 0, 1));
      const model = modelForSpace(space);
      await scope.build(visible, seen, store.loadExams(dir), model, Date.now(), (d, t) => emit(progress("mapping", d, t)));
      return {};
    }),

  study_scope_state: ({ space, course, exam, text: said }: { space: string; course: string; exam: string; text: string }) => {
    spaceDir(space);
    const visible = visibleFor(space);
    const seen = scope.seenCourse(visible, text(course, "course", "study_scope_state"));
    scope.state(visible, seen, text(exam, "exam", "study_scope_state"), text(said, "text", "study_scope_state"), Date.now());
    return null;
  },

  study_citations_check: ({ space, citations: asked }: { space: string; citations: citations.Asked[] }) => {
    const dir = spaceDir(space);
    if (!Array.isArray(asked)) throw "invalid args `citations` for command `study_citations_check`: expected a list";
    return citations.check(dir, visibleFor(space), asked);
  },
});
