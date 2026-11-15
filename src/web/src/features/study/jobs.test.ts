import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StudyEvent } from "./lib/types";

const api = vi.hoisted(() => ({
  studyMakeQuiz: vi.fn(),
  studyMakeDeck: vi.fn(),
  studyMakeCancel: vi.fn(async () => true),
  studyScopeState: vi.fn(async () => undefined),
}));
const toast = vi.hoisted(() => ({ show: vi.fn(), error: vi.fn() }));
vi.mock("./api", () => api);
vi.mock("@/components/toast", () => ({ toast }));
vi.mock("@/app/store", () => ({ useNav: { getState: () => ({ activeSpace: "school", selectSpace: vi.fn(), setView: vi.fn() }) } }));

import { emptyDraft } from "./lib/make-flow";
import { jobForOrigin, runningIn, useMakeJobs } from "./jobs";

type Emit = (e: StudyEvent) => void;
let emit: Emit = () => {};
let finish: (v: { kind: "done" }) => void = () => {};

beforeEach(() => {
  useMakeJobs.setState({ jobs: {}, finished: 0 });
  toast.show.mockClear();
  toast.error.mockClear();
  api.studyMakeQuiz.mockImplementation(
    (_s: string, _i: string[], _o: unknown, onEvent: Emit) =>
      new Promise((r) => {
        emit = onEvent;
        finish = r as typeof finish;
      }),
  );
});

const input = (origin?: string) => ({
  space: "school",
  draft: { ...emptyDraft("quiz", "courses/Alg"), exam: "Test 1", chat: origin ? { origin, context: "" } : undefined },
  examTitle: "Test 1",
  knownWords: "",
  pick: null,
  courseName: "Alg",
});

describe("make jobs", () => {
  it("joins a run already making the same thing instead of starting another", () => {
    const a = useMakeJobs.getState().start(input("blk1"));
    expect(useMakeJobs.getState().start(input("blk1"))).toBe(a);
    expect(useMakeJobs.getState().start(input())).not.toBe(a);
    expect(useMakeJobs.getState().start(input())).toBe(useMakeJobs.getState().start(input()));
    expect(runningIn(useMakeJobs.getState().jobs, "school")).toHaveLength(2);
    expect(jobForOrigin(useMakeJobs.getState().jobs, "school", "blk1")?.id).toBe(a);
    expect(api.studyMakeQuiz).toHaveBeenCalledTimes(2);
  });

  it("follows the run's events and, with nobody watching, says when it is ready", async () => {
    const id = useMakeJobs.getState().start(input("blk2"));
    await Promise.resolve();
    emit({ type: "progress", step: "making", done: 1, total: 2 });
    expect(useMakeJobs.getState().jobs[id]!.fraction).toBeGreaterThan(0);
    emit({ type: "done", path: "study/quizzes/t1.json", questions: 10 });
    finish({ kind: "done" });
    await vi.waitFor(() => expect(useMakeJobs.getState().jobs[id]!.status).toBe("done"));
    expect(useMakeJobs.getState().finished).toBe(1);
    expect(toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "Your quiz is ready" }));
  });

  it("stays quiet while a dialog shows it, and stops through the core", async () => {
    const id = useMakeJobs.getState().start(input("blk3"));
    useMakeJobs.getState().watch(id, true);
    await Promise.resolve();
    const stopping = useMakeJobs.getState().stop(id);
    expect(useMakeJobs.getState().jobs[id]!.status).toBe("stopping");
    expect(await stopping).toBe(true);
    emit({ type: "cancelled" });
    finish({ kind: "done" });
    await vi.waitFor(() => expect(useMakeJobs.getState().jobs[id]!.status).toBe("cancelled"));
    expect(toast.show).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
