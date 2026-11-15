import { create } from "zustand";
import { useNav } from "@/app/store";
import { cleanMessage } from "@/components/errors";
import { toast } from "@/components/toast";
import type { ModelPick } from "@/features/chat/api";
import { studyMakeCancel, studyMakeDeck, studyMakeQuiz, studyScopeState } from "./api";
import { useStudyFlow } from "./flow-store";
import type { MakeDraft, MakeKind } from "./lib/make-flow";
import { jobFraction } from "./lib/progress";
import type { Grounding, StudyEvent, UnknownScope } from "./lib/types";
import type { MakeProgress } from "./lib/words";

/**
 * Quizzes and decks being made, kept here rather than in the dialog that
 * started them: closing the dialog never stops a run, Study and the chat
 * card that asked for it show its progress, pressing Make again for the same
 * thing joins the run instead of starting a second one, and a run nobody is
 * watching says so with a toast when it ends.
 */

export type MakeDone = { path?: string; cards?: number; questions?: number; grounding?: Grounding };
export type MakeStatus = "running" | "stopping" | "done" | "error" | "needsScope" | "cancelled";

export type MakeJob = {
  id: string;
  space: string;
  kind: MakeKind;
  title: string;
  course: string | null;
  courseName?: string;
  exam?: string;
  focus?: string;
  /** The chat block that asked for it. */
  origin?: string;
  started: number;
  ended?: number;
  progress: MakeProgress | null;
  fraction: number;
  status: MakeStatus;
  done?: MakeDone;
  failure?: string;
  needs?: UnknownScope;
  /** Dialogs showing it; with none, its end is announced with a toast. */
  watchers: number;
};

export type StartInput = {
  space: string;
  draft: MakeDraft;
  /** The test it is for, as the course names it; "" for topics. */
  examTitle: string;
  /** What the course already says the test covers, so a restatement isn't saved twice. */
  knownWords: string;
  pick: ModelPick | null;
  courseName?: string;
};

type Store = {
  jobs: Record<string, MakeJob>;
  /** Bumped when any run ends, for pages that list what was made. */
  finished: number;
  /** Starts a run, or returns the one already making the same thing. */
  start(input: StartInput): string;
  /** Asks the core to stop it; false when nothing was running. */
  stop(id: string): Promise<boolean>;
  watch(id: string, on: boolean): void;
  dismiss(id: string): void;
};

const live = (j: MakeJob) => j.status === "running" || j.status === "stopping";

function sameWork(j: MakeJob, i: StartInput): boolean {
  if (j.space !== i.space || !live(j)) return false;
  const origin = i.draft.chat?.origin;
  if (origin) return j.origin === origin;
  if (j.origin) return false;
  return j.kind === i.draft.kind && j.course === i.draft.course && (j.exam ?? "") === i.examTitle && (j.focus ?? "") === (i.draft.target === "topics" ? i.draft.focus.trim() : "");
}

function titleOf(i: StartInput): string {
  const d = i.draft;
  if (d.title.trim()) return d.title.trim();
  const what = d.kind === "quiz" ? "Quiz" : "Cards";
  if (i.examTitle) return `${what} for ${i.examTitle}`;
  if (d.target === "topics" && d.focus.trim()) return `${what} on ${d.focus.trim()}`;
  return i.courseName ? `${what} from ${i.courseName}` : what;
}

export const useMakeJobs = create<Store>((set, get) => {
  const patch = (id: string, p: Partial<MakeJob>) =>
    set((s) => {
      const j = s.jobs[id];
      return j ? { jobs: { ...s.jobs, [id]: { ...j, ...p } } } : s;
    });

  const announce = (j: MakeJob) => {
    if (j.watchers > 0) return;
    const quiz = j.kind === "quiz";
    if (j.status === "done") {
      const path = j.done?.path;
      toast.show({
        type: "success",
        title: quiz ? "Your quiz is ready" : "Your cards are ready",
        description: j.title,
        timeout: 10_000,
        action: path
          ? {
              label: "Open",
              onClick: () => {
                useStudyFlow.getState().goTo(j.space, quiz ? { kind: "quiz", path } : { kind: "review", paths: [path] });
                const nav = useNav.getState();
                if (nav.activeSpace !== j.space) nav.selectSpace(j.space);
                nav.setView("study");
              },
            }
          : undefined,
      });
    } else if (j.status === "error") toast.error(quiz ? "Couldn’t make the quiz" : "Couldn’t make the cards", j.failure);
    else if (j.status === "needsScope") toast.show({ type: "info", title: `What does ${j.needs?.exam ?? j.exam} cover?`, description: "Open Study to say it in a few words; the questions wait for that." });
  };

  const end = (id: string, p: Partial<MakeJob>) => {
    patch(id, { ...p, ended: Date.now() });
    set((s) => ({ finished: s.finished + 1 }));
    const j = get().jobs[id];
    if (j) announce(j);
  };

  const run = async (id: string, i: StartInput) => {
    const d = i.draft;
    const quiz = d.kind === "quiz";
    const target = d.course ?? "";
    const said = d.covers.trim();
    if (i.examTitle && target && said && said !== i.knownWords) {
      try {
        await studyScopeState(i.space, target, i.examTitle, said);
      } catch (e) {
        return end(id, { status: "error", failure: `Couldn’t keep what ${i.examTitle} covers: ${cleanMessage(e)}` });
      }
    }
    let asked: UnknownScope | null = null;
    let failed: string | null = null;
    let finished: MakeDone | null = null;
    let cancelled = false;
    const onEvent = (e: StudyEvent) => {
      if (e.type === "progress") {
        const j = get().jobs[id];
        patch(id, { progress: e, fraction: jobFraction(e, "make", j?.fraction ?? 0) });
      } else if (e.type === "needsScope") asked = e;
      else if (e.type === "error") failed = e.message;
      else if (e.type === "cancelled") cancelled = true;
      else if (e.type === "done") finished = e;
    };
    const base = {
      count: d.count,
      ...(d.target === "topics" && d.focus.trim() ? { focus: d.focus.trim() } : {}),
      ...(d.title.trim() ? { title: d.title.trim() } : {}),
      ...(i.examTitle ? { exam: i.examTitle } : {}),
      ...(d.chat?.context ? { context: d.chat.context } : {}),
    };
    const inputs = d.files.length ? d.files : [target];
    const opts = { model: i.pick, runId: id, origin: d.chat?.origin };
    const out = quiz ? await studyMakeQuiz(i.space, inputs, { ...base, kinds: d.kinds, difficulty: d.difficulty }, onEvent, opts) : await studyMakeDeck(i.space, inputs, base, onEvent, opts);
    if (out.kind === "rejected") failed = cleanMessage(out.error);
    if (out.kind === "timedOut" && !finished && !failed && !cancelled) failed = "Phaethon’s core stopped answering before it finished.";
    if (cancelled) return end(id, { status: "cancelled" });
    if (asked) return end(id, { status: "needsScope", needs: asked });
    if (failed) return end(id, { status: "error", failure: failed });
    end(id, { status: "done", done: finished ?? {}, fraction: 1 });
  };

  return {
    jobs: {},
    finished: 0,
    start(input) {
      const same = Object.values(get().jobs).find((j) => sameWork(j, input));
      if (same) return same.id;
      const id = crypto.randomUUID();
      const d = input.draft;
      const job: MakeJob = {
        id,
        space: input.space,
        kind: d.kind,
        title: titleOf(input),
        course: d.course,
        started: Date.now(),
        progress: null,
        fraction: 0,
        status: "running",
        watchers: 0,
      };
      if (input.courseName) job.courseName = input.courseName;
      if (input.examTitle) job.exam = input.examTitle;
      if (d.target === "topics" && d.focus.trim()) job.focus = d.focus.trim();
      if (d.chat?.origin) job.origin = d.chat.origin;
      set((s) => ({ jobs: { ...s.jobs, [id]: job } }));
      void run(id, input);
      return id;
    },
    async stop(id) {
      const j = get().jobs[id];
      if (!j || !live(j)) return false;
      patch(id, { status: "stopping" });
      const stopped = await studyMakeCancel(j.space, id).catch(() => false);
      if (!stopped) {
        // Nothing was running in the core (it had just finished or failed): let the run's own end stand.
        const now = get().jobs[id];
        if (now && now.status === "stopping") patch(id, { status: "running" });
      }
      return stopped;
    },
    watch(id, on) {
      set((s) => {
        const j = s.jobs[id];
        return j ? { jobs: { ...s.jobs, [id]: { ...j, watchers: Math.max(0, j.watchers + (on ? 1 : -1)) } } } : s;
      });
    },
    dismiss(id) {
      set((s) => {
        const { [id]: _gone, ...rest } = s.jobs;
        return { jobs: rest };
      });
    },
  };
});

/** The job a chat block started, if any (its newest). */
export function jobForOrigin(jobs: Record<string, MakeJob>, space: string, origin: string | undefined): MakeJob | undefined {
  if (!origin) return undefined;
  return Object.values(jobs)
    .filter((j) => j.space === space && j.origin === origin)
    .sort((a, b) => b.started - a.started)[0];
}

/** Runs still going in a space, oldest first. */
export function runningIn(jobs: Record<string, MakeJob>, space: string): MakeJob[] {
  return Object.values(jobs)
    .filter((j) => j.space === space && live(j))
    .sort((a, b) => a.started - b.started);
}
