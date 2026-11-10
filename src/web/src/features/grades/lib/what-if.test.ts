import { assert, test } from "vitest";

import { calculate, letterFor, needed, pct, trend, type CalcInput, type CalcItem } from "./what-if";

const item = (key: string, group: string, score: number | undefined, possible: number, extra: Partial<CalcItem> = {}): CalcItem => ({
  key,
  title: key,
  group,
  score,
  possible,
  graded: score != null,
  excused: false,
  ...extra,
});

const course: CalcInput = {
  groups: [
    { name: "Homework", weight: 40 },
    { name: "Exams", weight: 60 },
  ],
  items: [
    item("hw1", "Homework", 9, 10),
    item("hw2", "Homework", 8, 10),
    item("hw3", "Homework", undefined, 10),
    item("t1", "Exams", 80, 100),
    item("final", "Exams", undefined, 100),
  ],
};

test("weighted groups: the mean of the groups that count", () => {
  const r = calculate(course);
  assert.equal(r.usesWeights, true);
  assert.equal(r.groups[0].percent, 85);
  assert.equal(r.groups[1].percent, 80);
  // 0.4 * 85 + 0.6 * 80
  assert.ok(Math.abs(r.percent! - 82) < 1e-9);
});

test("a tried score counts; excused never does", () => {
  const r = calculate({ ...course, tryScores: { hw3: 100, final: 90 } });
  // Homework 27/30 = 90, Exams 170/200 = 85 -> 0.4*90 + 0.6*85 = 87
  assert.ok(Math.abs(r.percent! - 87) < 1e-9);
  const excused = calculate({ ...course, items: course.items.map((i) => (i.key === "hw2" ? { ...i, excused: true } : i)) });
  assert.equal(excused.groups[0].percent, 90);
});

test("weights are rescaled over groups with something counted", () => {
  const r = calculate({ ...course, items: course.items.filter((i) => i.group === "Homework") });
  assert.equal(r.percent, 85);
});

test("no weights: total points", () => {
  const r = calculate({ groups: [{ name: "A" }, { name: "B" }], items: [item("a", "A", 5, 10), item("b", "B", 30, 30)] });
  assert.equal(r.usesWeights, false);
  assert.equal(r.percent, 87.5);
});

test("items in an unknown group fall in Other; percent-only items count out of 100", () => {
  const r = calculate({ groups: [], items: [{ key: "x", title: "x", group: "Labs", percent: 70, graded: true, excused: false }] });
  assert.equal(r.groups[0].name, "Other");
  assert.equal(r.percent, 70);
});

test("nothing counted is null, not 0", () => {
  assert.equal(calculate({ groups: course.groups, items: [item("x", "Exams", undefined, 100)] }).percent, null);
});

test("a separate final exam blends in by its weight", () => {
  const r = calculate({ ...course, final: { weight: 25, percent: 90 } });
  // 0.75 * 82 + 0.25 * 90 = 84
  assert.ok(Math.abs(r.percent! - 84) < 1e-9);
  assert.ok(Math.abs(calculate({ ...course, final: { weight: 25, percent: null } }).percent! - 82) < 1e-9);
});

test("what's needed on the final for a B+ (87%)", () => {
  // Solving the final item in the Exams group: 0.4*85 + 0.6*((80+x)/2) >= 87 -> x >= 96.67
  const n = needed(course, { item: "final" }, 87);
  assert.deepEqual(n, { kind: "needs", percent: 96.7 });
  const check = calculate({ ...course, tryScores: { final: 96.7 } }).percent!;
  assert.ok(check >= 87 - 0.005, String(check));
  assert.ok(calculate({ ...course, tryScores: { final: 96.6 } }).percent! < 87);
  // As a separate final worth 30%: 0.7*82 + 0.3x >= 87 -> x >= 98.67
  assert.deepEqual(needed({ ...course, final: { weight: 30, percent: null } }, { final: true }, 87), { kind: "needs", percent: 98.7 });
});

test("already there, out of reach, and unknown", () => {
  assert.deepEqual(needed(course, { item: "hw3" }, 60), { kind: "already" });
  const out = needed(course, { item: "hw3" }, 95);
  assert.equal(out.kind, "out-of-reach");
  assert.ok(out.kind === "out-of-reach" && Math.abs(out.best - (0.4 * (27 / 30) * 100 + 0.6 * 80)) < 1e-9);
  assert.deepEqual(needed(course, { final: true }, 90), { kind: "unknown" });
});

test("trend: the change the latest graded item made", () => {
  const dated = { ...course, items: course.items.map((i, n) => ({ ...i, due: n * 1000 })) };
  const t = trend(dated)!;
  assert.equal(t.since, "t1");
  // Without t1 only Homework counts (85); with it 82.
  assert.ok(Math.abs(t.delta - -3) < 1e-9);
  assert.equal(trend({ ...course }), null, "no due dates, no trend");
});

test("letters and percent text", () => {
  assert.equal(letterFor(93), "A");
  assert.equal(letterFor(92.999), "A");
  assert.equal(letterFor(87.2), "B+");
  assert.equal(letterFor(12), "F");
  assert.equal(pct(87), "87%");
  assert.equal(pct(87.25), "87.3%");
});

import { FINAL, defaultOn, needText, parseTyped, timeOf, whatIf, type Tried } from "./what-if";

const tried = (patch: Partial<Tried> = {}): Tried => ({ scores: {}, finalWeight: "", finalScore: "", target: "B+", on: "final", ...patch });

test("typed scores: points when the item has points, commas as decimals, out of range rejected", () => {
  assert.equal(parseTyped(""), null);
  assert.equal(parseTyped(" 8,5 "), 8.5);
  assert.ok(Number.isNaN(parseTyped("abc")!));
  const r = whatIf(course, tried({ scores: { hw3: "10", final: "250" } }));
  assert.deepEqual(r.bad, ["final"], "250 is more than twice 100 points");
  assert.deepEqual(r.tryScores, { hw3: 100 });
  assert.equal(r.changed, true);
  assert.ok(Math.abs(r.projected! - (0.4 * 90 + 0.6 * 80)) < 1e-9);
});

test("the final's weight is strictly between 0 and 100; its score up to 200", () => {
  assert.equal(whatIf(course, tried({ finalWeight: "100" })).finalBad.weight, true);
  assert.equal(whatIf(course, tried({ finalWeight: "0" })).finalBad.weight, true);
  const r = whatIf(course, tried({ finalWeight: "25", finalScore: "90", on: FINAL }));
  assert.deepEqual(r.final, { weight: 25, percent: 90 });
  assert.deepEqual(r.need, { kind: "out-of-reach", best: 86.5 });
  assert.equal(whatIf(course, tried({ on: FINAL })).need.kind, "unknown");
  assert.equal(needText(course, tried({ on: FINAL }), whatIf(course, tried({ on: FINAL }))), "Set how much the final exam is worth first.");
});

test("what's needed, said with points, solving one item while the others keep their tried scores", () => {
  const t = tried({ on: "final", scores: { final: "50" } });
  const r = whatIf(course, t);
  assert.deepEqual(r.need, { kind: "needs", percent: 96.7 }, "the solved item's own tried score is set aside");
  assert.equal(needText(course, t, r), "You need at least 96.7% (96.7 out of 100) on final for B+ (87%).");
  assert.equal(defaultOn(course), "final");
  assert.equal(defaultOn({ groups: [], items: [] }), FINAL);
});

test("site times: seconds, milliseconds, text, nothing", () => {
  assert.equal(timeOf(null), null);
  assert.equal(timeOf(""), null);
  assert.equal(timeOf(1_700_000_000), 1_700_000_000_000);
  assert.equal(timeOf(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(timeOf("2026-10-10T00:00:00Z"), Date.UTC(2026, 9, 10));
  assert.equal(timeOf("nope"), null);
});
