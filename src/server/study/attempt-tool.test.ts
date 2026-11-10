import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { resolveIn } from "../core/resolve.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { STUDY_ATTEMPT_TOOL, runStudyAttempt, studyAttemptLabel } from "./attempt-tool.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

describe("study_attempt tool", () => {
  it("a completed quiz can be reviewed without exposing other state", () => {
    const s = spaceDir("school");
    const p = ".phaethon/study/attempts/Practice-42.json";
    fs.mkdirSync(path.join(s, ".phaethon/study/attempts"), { recursive: true });
    fs.writeFileSync(
      path.join(s, p),
      JSON.stringify({
        path: p,
        quiz: "study/quizzes/Practice.json",
        taken: 42,
        score: 0.0,
        results: [{ id: "q1", correct: false, given: "B", expected: "A", feedback: "A follows from the course notes." }],
      }),
    );
    fs.writeFileSync(path.join(s, ".phaethon/session"), "secret");
    expect(JSON.parse(runStudyAttempt(s, {}))).toEqual([{ path: p, quiz: "study/quizzes/Practice.json", taken: 42, score: 0 }]);
    const result = JSON.parse(runStudyAttempt(s, { path: p }));
    expect(result.results[0].given).toBe("B");
    expect(result.results[0].expected).toBe("A");
    expect(() => runStudyAttempt(s, { path: ".phaethon/session" })).toThrow();
    // read_file can't reach it (the shared path check refuses .phaethon).
    expect(() => resolveIn(s, p, true)).toThrow("Phaethon's own state");
    expect(() => runStudyAttempt(s, { path: p, other: true })).toThrow('unexpected field "other"');
    expect(() => runStudyAttempt(s, { path: 3 })).toThrow('"path" must be a string');
    expect(studyAttemptLabel({})).toBe("Finding completed quizzes");
    expect(studyAttemptLabel({ path: p })).toBe("Reading a completed quiz");
    expect(STUDY_ATTEMPT_TOOL.name).toBe("study_attempt");
  });
});
