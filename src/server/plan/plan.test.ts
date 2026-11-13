import { symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir } from "../core/vault.ts";
import { parseTime } from "../study/lms.ts";
import { examStart, sameCourse } from "../study/schedule.ts";
import { ALL, fixture } from "../study/testing.ts";
import { Visible } from "../study/visible.ts";
import "./commands.ts";
import { MAX_PLAN, defaultState, examsGet, examsSet, savePlan, stateGet, stateSet, upcoming, validDate, type Exam, type PlanState } from "./plan.ts";

const env = tempHome("phaethon-plan-");
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

let n = 0;
function space(): string {
  const dir = path.join(env.home, `space-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const exam = (id: string, title: string, date: string): Exam => ({ id, title, date });

function err(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
}

describe("plan", () => {
  it("the planner's exams cap the cards' schedule", () => {
    const written = JSON.stringify([{ id: "e1", course: "CSCI-C 241 Fall 2026 (All Sections)", title: "Test 1", date: "2026-10-15" }]);
    const read = JSON.parse(written) as { course?: string; title: string; date: string }[];
    expect(read[0]!.date).toBe("2026-10-15");
    expect(sameCourse(read[0]!.course!, "CSCI-C 241 Fall 2026 (All Sections)")).toBe(true);
    expect(examStart(read[0]!.date, 0)).not.toBeNull();
  });

  it("upcoming lists every course, soonest first, from now on", () => {
    const due = (title: string, d: string, anchor: string) => ({ title, due: d, anchor });
    const extra = {
      "CSCI-C 241": { due: [due("HW 01", "2026-09-02T03:59:59Z", "hw-01"), due("HW 06", "2026-10-15T03:59:59Z", "hw-06")] },
      "Linear Algebra": { due: [due("Quiz 3", "2026-10-12T16:00:00Z", ""), due("Bad date", "next week", "x")] },
    };
    const visible = fixture("s", [["CSCI-C 241", ALL], ["Linear Algebra", ALL]], extra);
    const now = parseTime("2026-10-10T12:00:00Z")!;
    const view = upcoming(visible, now);
    expect(view.courses.map((c) => c.name)).toEqual(["CSCI-C 241", "Linear Algebra"]);
    expect(view.items.map((u) => u.title)).toEqual(["Quiz 3", "HW 06"]);
    expect(view.items[0]!.link).toBe("courses/Linear Algebra/assignments.md");
    expect(view.items[1]!.link).toBe("courses/CSCI-C 241/assignments.md#hw-06");
    expect(view.items[1]!.due).toBe(parseTime("2026-10-15T03:59:59Z")! * 1000);
    expect(upcoming(new Visible(env.home, []), now)).toEqual({ courses: [], items: [] });
    // Only what the space may see.
    let v = fixture("s", [["CSCI-C 241", ["overview"]], ["Linear Algebra", ["syllabus"]]], extra);
    let view2 = upcoming(v, now);
    expect(view2.courses).toHaveLength(2);
    expect(view2.items).toHaveLength(1);
    expect(view2.items[0]!.link).toBe("courses/CSCI-C 241/README.md");
    v = fixture("s", [["CSCI-C 241", []], ["Linear Algebra", ["syllabus"]]], extra);
    view2 = upcoming(v, now);
    expect(view2.courses).toHaveLength(1);
  });

  it("exams are checked, saved by date and read back", () => {
    const dir = space();
    expect(examsGet(dir)).toEqual([]);
    const first: Exam = { ...exam("e1", "  Test 1\n(chapters 1–4) ", "2026-10-15"), course: "CSCI-C 241 Fall 2026 (All Sections)" };
    const saved = examsSet(dir, [exam("e2", "Final", "2026-12-14"), first]);
    expect(saved[0]!.title).toBe("Test 1 (chapters 1–4)");
    expect(saved[0]!.course).toBe("CSCI-C 241 Fall 2026 (All Sections)");
    expect(saved[1]!.id).toBe("e2");
    expect(examsGet(dir)).toEqual(saved);
    const text = fs.readFileSync(path.join(dir, "study/exams.json"), "utf8");
    expect(text.endsWith("]\n")).toBe(true);
    const onDisk = JSON.parse(text);
    expect(onDisk[0].date).toBe("2026-10-15");
    expect("course" in onDisk[1]).toBe(false);
  });

  it("bad exams are refused and nothing is written", () => {
    const dir = space();
    const cases: [Exam, string][] = [
      [exam("e1", "", "2026-10-15"), "needs a name"],
      [exam("e1", "Test", "2026-02-30"), "real date"],
      [exam("e1", "Test", "15/10/2026"), "real date"],
      [exam("e1", "Test", "1999-10-15"), "real date"],
      [exam("../x", "Test", "2026-10-15"), "id"],
      [exam("e1", "x".repeat(121), "2026-10-15"), "at most"],
      [{ ...exam("e1", "Test", "2026-10-15"), course: "../work" }, "course"],
    ];
    for (const [bad, why] of cases) expect(err(() => examsSet(dir, [bad]))).toContain(why);
    expect(err(() => examsSet(dir, [exam("a", "One", "2026-10-15"), exam("a", "Two", "2026-10-16")]))).toBe("Two exams have the same id.");
    expect(validDate("2028-02-29") && !validDate("2026-02-29") && !validDate("2026-13-01")).toBe(true);
    expect(fs.existsSync(path.join(dir, "study"))).toBe(false);
    expect(err(() => examsSet(dir, Array.from({ length: 201 }, (_, i) => exam(`e${i}`, "T", "2026-10-15"))))).toBe("A space can keep up to 200 exams.");
  });

  it("a hand-edited exams file keeps its good entries", () => {
    const dir = space();
    fs.mkdirSync(path.join(dir, "study"));
    fs.writeFileSync(
      path.join(dir, "study/exams.json"),
      '[{"id":"x1","title":"Midterm","date":"2026-11-02"},{"id":"x2","title":"","date":"2026-11-03"},{"title":"no id"},7]',
    );
    expect(examsGet(dir)).toEqual([exam("x1", "Midterm", "2026-11-02")]);
    // The form the card scheduler also reads is not "damaged".
    fs.writeFileSync(path.join(dir, "study/exams.json"), '{"exams":[{"id":"x1","title":"Midterm","date":"2026-11-02"}]}');
    expect(examsGet(dir)).toEqual([exam("x1", "Midterm", "2026-11-02")]);
    fs.writeFileSync(path.join(dir, "study/exams.json"), "{ broken");
    expect(err(() => examsGet(dir))).toContain("damaged");
  });

  it.skipIf(process.platform === "win32")("links are never followed", () => {
    const dir = space();
    const outside = space();
    fs.writeFileSync(path.join(outside, "exams.json"), '[{"id":"x","title":"Secret","date":"2026-11-02"}]');
    symlink(outside, path.join(dir, "study"));
    expect(err(() => examsGet(dir))).toContain("it is a link");
    expect(() => examsSet(dir, [exam("a", "One", "2026-10-15")])).toThrow();
    expect(() => savePlan(dir, "# Plan")).toThrow();
    expect(fs.readdirSync(outside)).toHaveLength(1);
  });

  it("the plan and its state are saved", () => {
    const dir = space();
    expect(savePlan(dir, "# Study plan\n\n- [ ] Mon: review\n")).toBe("study/plan.md");
    expect(fs.readFileSync(path.join(dir, "study/plan.md"), "utf8").startsWith("# Study plan")).toBe(true);
    expect(err(() => savePlan(dir, "x".repeat(MAX_PLAN + 1)))).toBe("That plan is too long to save.");
    expect(stateGet(dir)).toEqual(defaultState());
    const s: PlanState = { studyDays: [5, 1, 1, 3], sessionsPerDay: 2, sessionMinutes: 30, done: ["a", "b", "a"] };
    const saved = stateSet(dir, s);
    expect(saved.studyDays).toEqual([1, 3, 5]);
    expect(saved.done).toEqual(["a", "b"]);
    expect(stateGet(dir)).toEqual(saved);
    for (const [bad, why] of [
      [{ ...defaultState(), studyDays: [] }, "Choose at least one day of the week to study on."],
      [{ ...defaultState(), studyDays: [7] }, "Choose at least one day of the week to study on."],
      [{ ...defaultState(), sessionsPerDay: 0 }, "Plan between 1 and 8 sessions a day."],
      [{ ...defaultState(), sessionMinutes: 5 }, "A session can be 10 to 120 minutes."],
    ] as [PlanState, string][])
      expect(err(() => stateSet(dir, bad))).toBe(why);
    expect(stateGet(dir)).toEqual(saved);
    fs.writeFileSync(path.join(dir, ".phaethon/study/plan.json"), "{ broken");
    expect(stateGet(dir)).toEqual(defaultState());
  });

  it("the commands work through the registry", async () => {
    const saved = await call<Exam[]>("plan_exams_set", { space: "school", exams: [exam("e1", "Test 1", "2026-10-15")] });
    expect(saved).toEqual([exam("e1", "Test 1", "2026-10-15")]);
    expect(await call("plan_exams_get", { space: "school" })).toEqual(saved);
    expect(fs.existsSync(path.join(spaceDir("school"), "study/exams.json"))).toBe(true);
    expect(await call("plan_save", { space: "school", markdown: "# P" })).toBe("study/plan.md");
    expect(await call("plan_state_get", { space: "school" })).toEqual(defaultState());
    expect(await call("plan_state_set", { space: "school", planState: { studyDays: [1], sessionsPerDay: 1, sessionMinutes: 10 } })).toEqual({
      studyDays: [1],
      sessionsPerDay: 1,
      sessionMinutes: 10,
      done: [],
    });
    await expect(call("plan_state_set", { space: "school", planState: { studyDays: [1] } })).rejects.toThrow("invalid args `planState`");
    await expect(call("plan_exams_get", { space: "../x" })).rejects.toThrow('"../x" is not a valid space name');
    const view = await call<{ courses: unknown[]; items: unknown[] }>("plan_upcoming", { space: "school" });
    expect(view).toEqual({ courses: [], items: [] });
  });
});
