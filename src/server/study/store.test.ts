import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, spacesRoot } from "../core/vault.ts";
import { DAY, MINUTE, examStart, offsetSecs } from "./schedule.ts";
import {
  ATTEMPTS,
  DECKS,
  EXAMS,
  PROGRESS,
  attemptSave,
  attempts,
  checkPath,
  deckCreate,
  deckSave,
  deckView,
  deleteItem,
  existingFronts,
  list,
  loadExams,
  loadProgress,
  overview,
  promptSection,
  quizCreate,
  rate,
  session,
  type CardInput,
} from "./store.ts";
import type { Attempt, Quiz } from "./types.ts";

const env = tempHome();
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

const T0 = 1_791_000_000_000;
const HOUR_MS = 60 * MINUTE;
let n = 0;
/** A fresh, empty space folder. */
function space(): string {
  const id = `s${++n}`;
  fs.mkdirSync(path.join(spacesRoot(), id), { recursive: true });
  return spaceDir(id);
}
const cards = (pairs: [string, string][]): CardInput[] => pairs.map(([front, back]) => ({ front, back, source: null }));
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return String(e);
  }
  throw new Error("expected an error");
};

describe("study store", () => {
  it("paths are only decks and quizzes in their folders", () => {
    expect(checkPath("study/decks/Sets.md", "deck")).toBe("study/decks/Sets.md");
    expect(checkPath("study\\decks\\Sets.md", "deck")).toBe("study/decks/Sets.md");
    for (const bad of [
      "study/decks/../x.md",
      "study/decks/a/b.md",
      "study/decks/.md",
      "study/decks/.hidden.md",
      "study/decks/x.txt",
      "/study/decks/x.md",
      "notes.md",
      "study/quizzes/x.json",
      "study/decks/",
      "study/decks/a:b.md",
    ])
      expect(() => checkPath(bad, "deck"), bad).toThrow();
    expect(checkPath("study/decks/X.MD", "deck")).toBe("study/decks/X.MD");
    expect(() => checkPath("study/quizzes/Q.json", "quiz")).not.toThrow();
    expect(() => checkPath(".phaethon/study/attempts/Q-1.json", "attempt")).not.toThrow();
    expect(() => checkPath(".phaethon/study/progress.json", "attempt")).toThrow("That isn’t a quiz attempt in this space.");
  });

  it("save, study, rate and delete a deck", () => {
    const dir = space();
    const p = deckSave(dir, null, "Sets: basics", cards([["What is ∅?", "The empty set."], ["|{1,2}| = {{2}}", ""]]));
    expect(p).toBe("study/decks/Sets- basics.md");
    expect(deckSave(dir, "", "Sets: basics", cards([["x", "y"]]))).toBe("study/decks/Sets- basics (2).md");
    let v = deckView(dir, p);
    expect(v.title).toBe("Sets: basics");
    expect(v.cards.length).toBe(2);
    expect(v.cards[1]!.kind).toBe("cloze");

    let o = overview(dir, T0);
    let d = o.decks.find((x) => x.path === p)!;
    expect([o.decks.length, d.new, d.due, o.due, o.streakDays]).toEqual([2, 2, 0, 0, 0]);

    const s = session(dir, [p], 20, T0);
    expect(s.length).toBe(2);
    let r = rate(dir, p, s[0]!.id, 1, T0);
    expect(r.again && r.due === T0 + 10 * MINUTE).toBe(true);
    r = rate(dir, p, s[1]!.id, 5, T0);
    expect(!r.again && r.due === T0 + 5 * DAY).toBe(true);
    expect(() => rate(dir, p, "nope", 3, T0)).toThrow();
    expect(err(() => rate(dir, p, s[0]!.id, 6, T0))).toBe("Rate how well you knew it from 1 to 5.");

    const later = T0 + HOUR_MS;
    o = overview(dir, later);
    d = o.decks.find((x) => x.path === p)!;
    expect([d.due, d.new, o.streakDays]).toEqual([1, 0, 1]);
    expect(d.mastery).toBe(0.5);
    const all = session(dir, null, 20, later);
    expect(all[0]!.id).toBe(s[0]!.id);
    expect(all.length).toBe(2);
    expect(session(dir, [p], 20, later).length).toBe(2);
    // Fixed: a deck chosen twice isn't studied twice.
    expect(session(dir, [p, p], 20, later).length).toBe(2);

    deckSave(dir, p, "Sets: basics", cards([["What is ∅?", "The set with no members."], ["|{1,2,3}| = {{3}}", ""]]));
    v = deckView(dir, p);
    expect(v.cards[0]!.confidence).toBe(1);
    expect(v.cards[1]!.confidence).toBeUndefined();
    expect(Object.keys(loadProgress(dir).decks[p]!).length).toBe(1);

    deleteItem(dir, p);
    expect(Object.hasOwn(loadProgress(dir).decks, p)).toBe(false);
    expect(() => deckView(dir, p)).toThrow();
    expect(() => deleteItem(dir, "notes.md")).toThrow("That isn’t a deck or quiz in this space.");
  });

  it("progress.json is written compactly with sorted keys, in the Rust shape", () => {
    const dir = space();
    const p = deckSave(dir, null, "B", cards([["b", "1"], ["a", "2"]]));
    const v = deckView(dir, p);
    rate(dir, p, v.cards[0]!.id, 4, T0);
    rate(dir, p, v.cards[1]!.id, 4, T0);
    const text = fs.readFileSync(path.join(dir, PROGRESS), "utf8");
    expect(text.startsWith('{"version":1,"decks":{"study/decks/B.md":{')).toBe(true);
    const parsed = JSON.parse(text);
    const ids = Object.keys(parsed.decks[p]);
    expect(ids).toEqual([...ids].sort());
    expect(Object.keys(parsed.decks[p][ids[0]!])).toEqual(["reps", "lapses", "ease", "interval", "due", "last", "history"]);
  });

  it("a progress file that can't be read is kept, not overwritten (fixed)", () => {
    const dir = space();
    const p = deckSave(dir, null, "Kept", cards([["a", "b"]]));
    const id = deckView(dir, p).cards[0]!.id;
    fs.mkdirSync(path.join(dir, ".phaethon/study"), { recursive: true });
    fs.writeFileSync(path.join(dir, PROGRESS), "{not json");
    expect(err(() => rate(dir, p, id, 4, T0))).toContain("Your progress couldn’t be read");
    expect(fs.readFileSync(path.join(dir, PROGRESS), "utf8")).toBe("{not json");
    // Views still work, as if nothing had been studied.
    expect(overview(dir, T0).decks[0]!.new).toBe(1);
    expect(session(dir, null, 20, T0).length).toBe(1);
    // A card state missing a field is filled in rather than losing everything.
    fs.writeFileSync(path.join(dir, PROGRESS), JSON.stringify({ version: 1, decks: { [p]: { [id]: { reps: 1, ease: 2.5, interval: 3, due: T0, last: T0, history: [4] } } }, days: [] }));
    expect(deckView(dir, p).cards[0]!.confidence).toBe(4);
    rate(dir, p, id, 5, T0 + DAY);
    expect(loadProgress(dir).decks[p]![id]!.lapses).toBe(0);
  });

  it("a card read from a page's picture says so and keeps it through edits", () => {
    const dir = space();
    fs.mkdirSync(path.join(dir, "study/decks"), { recursive: true });
    const src = "courses/C/files/notes.pdf";
    fs.writeFileSync(
      path.join(dir, "study/decks/Relations.md"),
      `---\ntitle: Relations\n---\n\nQ: What is a reflexive relation?\nA: (a,a) ∈ R for every a.\nFrom: ${src} (p. 3, read from a picture of the page)\nQuote: "R is reflexive if (a,a) e R for all a"\n\nQ: Typed\nA: card\nFrom: ${src}\nQuote: "typed words"\n`,
    );
    const p = "study/decks/Relations.md";
    let v = deckView(dir, p);
    expect([v.cards[0]!.source, v.cards[0]!.picture]).toEqual([src, 3]);
    expect([v.cards[1]!.source, v.cards[1]!.picture]).toEqual([src, undefined]);
    expect(JSON.parse(JSON.stringify(v.cards[0])).picture).toBe(3);
    expect("picture" in JSON.parse(JSON.stringify(v.cards[1]))).toBe(false);
    const edit = (source: string | null): CardInput[] => [{ front: "What is a reflexive relation?", back: "Every a relates to itself.", source }];
    deckSave(dir, p, "Relations", edit(null));
    v = deckView(dir, p);
    expect([v.cards[0]!.picture, v.cards[0]!.quote !== undefined]).toEqual([3, true]);
    expect(fs.readFileSync(path.join(dir, p), "utf8")).toContain("(p. 3, read from a picture of the page)");
    deckSave(dir, p, "Relations", edit("courses/C/files/other.pdf"));
    v = deckView(dir, p);
    expect([v.cards[0]!.picture, v.cards[0]!.quote]).toEqual([undefined, undefined]);
  });

  it("editing a card's question keeps its source and passage (fixed)", () => {
    const dir = space();
    fs.mkdirSync(path.join(dir, "study/decks"), { recursive: true });
    const p = "study/decks/Sources.md";
    fs.writeFileSync(path.join(dir, p), '---\ntitle: Sources\n---\n\nQ: Old question?\nA: An answer.\nFrom: notes.md\nQuote: "the passage it came from"\n\nQ: Other\nA: x\n');
    deckSave(dir, p, "Sources", cards([["New question?", "An answer."], ["Other", "x"]]));
    const v = deckView(dir, p);
    expect([v.cards[0]!.front, v.cards[0]!.source, v.cards[0]!.quote]).toEqual(["New question?", "notes.md", "the passage it came from"]);
    // A card moved, not edited, doesn't take another card's source.
    deckSave(dir, p, "Sources", cards([["Other", "x"], ["New question?", "An answer."]]));
    const w = deckView(dir, p);
    expect(w.cards[0]!.source).toBeUndefined();
    expect(w.cards[1]!.source).toBe("notes.md");
  });

  it("hand-written decks and bad saves", () => {
    const dir = space();
    fs.mkdirSync(path.join(dir, DECKS), { recursive: true });
    const raw = "q: uno\r\na: one\r\n\r\nQ: dos\r\nA: two\r\n";
    fs.writeFileSync(path.join(dir, DECKS, "Spanish.md"), raw);
    const o = overview(dir, T0);
    expect([o.decks[0]!.title, o.decks[0]!.cards]).toEqual(["Spanish", 2]);
    expect(err(() => deckSave(dir, "study/decks/Spanish.md", "Spanish", cards([["uno", ""]])))).toContain("no answer");
    expect(() => deckSave(dir, null, "  ", cards([["a", "b"]]))).toThrow();
    expect(() => deckSave(dir, "study/decks/Missing.md", "x", cards([["a", "b"]]))).toThrow();
    expect(fs.readFileSync(path.join(dir, DECKS, "Spanish.md"), "utf8")).toBe(raw);
    expect(list(dir, "deck")).toEqual(["Spanish.md"]);
  });

  it("linked folders and files are never used", () => {
    const dir = space();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-outside-"));
    fs.writeFileSync(path.join(outside, "Evil.md"), "Q: a\nA: b\n");
    fs.mkdirSync(path.join(dir, "study"), { recursive: true });
    fs.symlinkSync(outside, path.join(dir, DECKS));
    expect(overview(dir, T0).decks).toEqual([]);
    expect(() => deckView(dir, "study/decks/Evil.md")).toThrow();
    expect(() => deckSave(dir, null, "New", cards([["a", "b"]]))).toThrow();
    expect(fs.existsSync(path.join(outside, "New.md"))).toBe(false);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("exams cap intervals and reach the prompt", () => {
    const dir = space();
    expect(promptSection(dir, false, T0)).toBeNull();
    expect(promptSection(dir, true, T0)).not.toBeNull();
    fs.mkdirSync(path.join(dir, "study"), { recursive: true });
    const p = deckSave(dir, null, "Logic", cards([["p → q is false when?", "p true, q false"]]));
    const file = path.join(dir, p);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("title: Logic\n", "title: Logic\ncourse: CSCI-C 241 Fall 2026 (All Sections)\n"));
    const examDay = "2026-10-15";
    fs.writeFileSync(path.join(dir, EXAMS), JSON.stringify([{ course: "CSCI-C 241", title: "Test 1", date: examDay }]));
    const now = examStart("2026-10-12", offsetSecs(T0))! + 10 * HOUR_MS;
    const id = deckView(dir, p).cards[0]!.id;
    const r = rate(dir, p, id, 5, now);
    const exam = examStart(examDay, offsetSecs(now))!;
    expect(r.due).toBeLessThan(exam);
    const prompt = promptSection(dir, false, now)!;
    expect(prompt).toContain("study/decks/<Title>.md");
    expect(prompt).toContain("Q: <question>");
    expect(prompt).toContain("Test 1 (CSCI-C 241) on 2026-10-15");
    expect(promptSection(dir, false, exam + DAY)!).not.toContain("Upcoming");
  });

  it("exams.json in either form keeps its good entries (fixed)", () => {
    const dir = space();
    fs.mkdirSync(path.join(dir, "study"), { recursive: true });
    fs.writeFileSync(path.join(dir, EXAMS), JSON.stringify({ exams: [{ title: "A", date: "2026-10-15" }, { title: 3 }, { course: null, date: "2026-11-01" }] }));
    expect(loadExams(dir)).toEqual([
      { title: "A", date: "2026-10-15" },
      { title: "", date: "2026-11-01" },
    ]);
    fs.writeFileSync(path.join(dir, EXAMS), JSON.stringify([{ date: 5 }, { course: "X", title: "B", date: "2026-10-15" }]));
    expect(loadExams(dir)).toEqual([{ course: "X", title: "B", date: "2026-10-15" }]);
  });

  it("quizzes, attempts and deleting a quiz removes only its listed attempts (fixed)", () => {
    const dir = space();
    const quiz: Quiz = { title: "Practice", sources: [], created: T0, questions: [{ id: "", kind: "truefalse", prompt: "p?", answer: true, explanation: "" }] };
    const qp = quizCreate(dir, quiz);
    expect(qp).toBe("study/quizzes/Practice.json");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, qp), "utf8"));
    expect(saved.questions[0]).toEqual({ id: "q1", kind: "truefalse", prompt: "p?", choices: ["true", "false"], answer: "true", explanation: "" });
    const a: Attempt = { path: "", quiz: qp, taken: 42, score: 1, results: [] };
    attemptSave(dir, a);
    expect(a.path).toBe(`${ATTEMPTS}/Practice-42.json`);
    const b: Attempt = { path: "", quiz: qp, taken: 42, score: 0.5, results: [] };
    attemptSave(dir, b);
    expect(b.path).toBe(`${ATTEMPTS}/Practice-42 (2).json`);
    expect(attempts(dir).length).toBe(2);
    const o = overview(dir, T0);
    expect(o.quizzes[0]).toMatchObject({ path: qp, title: "Practice", questions: 1, lastTaken: 42 });
    // A tampered attempt naming another file is never followed.
    const victim = path.join(dir, "notes.md");
    fs.writeFileSync(victim, "mine");
    fs.writeFileSync(path.join(dir, ATTEMPTS, "Evil-1.json"), JSON.stringify({ path: "notes.md", quiz: qp, taken: 1, score: 0, results: [] }));
    const other = quizCreate(dir, { ...quiz, title: "Other" });
    const c: Attempt = { path: "", quiz: other, taken: 7, score: 0, results: [] };
    attemptSave(dir, c);
    deleteItem(dir, qp);
    expect(fs.readFileSync(victim, "utf8")).toBe("mine");
    expect(attempts(dir).map((x) => x.quiz)).toEqual([other]);
    expect(fs.existsSync(path.join(dir, qp))).toBe(false);
  });

  it("generated decks get free names and existing fronts are found by course", () => {
    const dir = space();
    const d1 = deckCreate(dir, { title: "Logic", course: "CSCI-C 241 Fall 2026", sources: [], extra: [], preamble: "", notes: [{ front: "A?", back: "a" }] });
    const d2 = deckCreate(dir, { title: "logic", sources: [], extra: [], preamble: "", notes: [{ front: "B?", back: "b" }] });
    expect([d1, d2]).toEqual(["study/decks/Logic.md", "study/decks/logic (2).md"]);
    expect(existingFronts(dir, "CSCI-C 241")).toEqual(["A?"]);
    expect(existingFronts(dir, null)).toEqual(["B?"]);
    expect(() => deckCreate(dir, { title: "", sources: [], extra: [], preamble: "", notes: [] })).toThrow("The deck needs a title.");
  });
});
