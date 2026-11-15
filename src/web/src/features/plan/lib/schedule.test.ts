import { assert, test } from "vitest";

import { addDays, dayName, makePlan, planMarkdown, weekday, type PlanInput } from "./schedule";

// Saturday 17 October 2026.
const today = "2026-10-17";
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const base: PlanInput = {
  today,
  exams: [{ id: "t1", title: "Test 1", course: "CS 101", date: "2026-10-22" }],
  due: [],
  studyDays: [0, 1, 2, 3, 4, 5, 6],
  sessionsPerDay: 3,
  dayOf: utcDay,
};

test("days and names", () => {
  assert.equal(weekday(today), 6);
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(addDays("2026-03-08", 1), "2026-03-09", "no daylight-saving drift");
  assert.equal(dayName("2026-10-22"), "Thursday 22 October");
});

test("reviews spread before an exam, final review the day before, none on or after it", () => {
  const plan = makePlan(base);
  const sessions = plan.days.flatMap((d) => d.sessions);
  // Offsets 1, 2, 4 fit (21st, 20th, 18th); 7, 11 and 16 days before are in the past.
  assert.deepEqual(sessions.map((s) => s.day), ["2026-10-18", "2026-10-20", "2026-10-21"]);
  assert.equal(sessions.at(-1)!.kind, "final-review");
  assert.equal(sessions.at(-1)!.title, "Final review for Test 1");
  assert.ok(sessions.every((s) => s.day < "2026-10-22" && s.day >= today));
  assert.deepEqual(plan.unplaced, []);
});

test("only on the chosen days, and the same input gives the same plan", () => {
  const input = { ...base, studyDays: [1, 3] }; // Monday, Wednesday
  const plan = makePlan(input);
  const days = plan.days.map((d) => d.day);
  assert.deepEqual(days, ["2026-10-19", "2026-10-21"]);
  assert.ok(days.every((d) => [1, 3].includes(weekday(d))));
  assert.deepEqual(makePlan(input), plan);
  assert.equal(plan.unplaced.length, 1, "the third review had no day left before the exam");
});

test("never more sessions in a day than chosen; the rest move earlier or are listed", () => {
  const due = ["A", "B", "C", "D"].map((t) => ({
    title: `HW ${t}`,
    course: "Calc",
    folder: "Calc",
    due: Date.UTC(2026, 9, 20, 23),
    link: `courses/Calc/assignments.md#hw-${t}`,
  }));
  const plan = makePlan({ ...base, exams: [], due, sessionsPerDay: 2 });
  for (const d of plan.days) assert.ok(d.sessions.length <= 2, d.day);
  // Wanted the 12th; 2 fit there, 2 move to the 11th.
  assert.deepEqual(plan.days.map((d) => [d.day, d.sessions.length]), [["2026-10-18", 2], ["2026-10-19", 2]]);
  const tight = makePlan({ ...base, exams: [], due, sessionsPerDay: 1, today: "2026-10-19" });
  assert.equal(tight.days.length, 1);
  assert.equal(tight.unplaced.length, 3);
});

test("the sooner deadline gets the nearer days", () => {
  const plan = makePlan({
    ...base,
    sessionsPerDay: 1,
    exams: [
      { id: "late", title: "Midterm", date: "2026-10-27" },
      { id: "soon", title: "Quiz", date: "2026-10-19" },
    ],
  });
  const first = plan.days.find((d) => d.day === "2026-10-18")!;
  assert.equal(first.sessions[0].title, "Final review for Quiz");
});

test("past and far-off dates are left out; ids are stable", () => {
  const plan = makePlan({
    ...base,
    exams: [...base.exams, { id: "old", title: "Old", date: "2026-10-08" }, { id: "far", title: "Final", date: "2027-05-01" }],
  });
  assert.ok(plan.days.flatMap((d) => d.sessions).every((s) => s.id.startsWith("exam:t1:")));
  const later = makePlan({ ...base, today: "2026-10-19" });
  const ids = (p: typeof plan) => p.days.flatMap((d) => d.sessions.map((s) => s.id));
  assert.ok(ids(later).every((id) => ids(plan).includes(id)), "the same session keeps its id when planned again");
});

test("work sessions: the day before it's due, or today when due today, with the course's decks", () => {
  const plan = makePlan({
    ...base,
    exams: [],
    decks: { Calc: ["Integrals"] },
    due: [
      { title: "PS 4", course: "Calc", folder: "Calc", due: Date.UTC(2026, 9, 21, 3), link: "courses/Calc/assignments.md#ps-4" },
      { title: "Lab", course: "Calc", folder: "Calc", due: Date.UTC(2026, 9, 17, 22), link: "courses/Calc/assignments.md#lab" },
    ],
  });
  const s = plan.days.flatMap((d) => d.sessions);
  assert.deepEqual(s.map((x) => [x.day, x.title]), [["2026-10-17", "Work on Lab"], ["2026-10-20", "Work on PS 4"]]);
  assert.deepEqual(s[1].decks, ["Integrals"]);
});

test("markdown: a checklist by day with what's checked", () => {
  const plan = makePlan(base);
  const md = planMarkdown(plan, base, new Set([plan.days[0].sessions[0].id]), 25);
  assert.match(md, /^# Study plan/);
  assert.match(md, /- Thursday 22 October: Test 1 \(CS 101\)/);
  assert.match(md, /### Sunday 18 October\n\n- \[x\] Review for Test 1 \(CS 101\)/);
  assert.match(md, /- \[ \] Final review for Test 1/);
});

test("an exam today gets one final review today; a final review that doesn't fit says so", () => {
  const plan = makePlan({ ...base, exams: [{ id: "t", title: "Quiz", date: today }] });
  assert.deepEqual(plan.days.flatMap((d) => d.sessions.map((s) => [s.day, s.title])), [[today, "Final review for Quiz"]]);
  const none = makePlan({ ...base, studyDays: [1], exams: [{ id: "t", title: "Quiz", date: "2026-10-19" }] });
  assert.deepEqual(none.unplaced[0], { title: "Final review for Quiz", target: "2026-10-19" });
});
