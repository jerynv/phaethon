import { describe, expect, it } from "vitest";
import { agenda, counts, relDay, shortDay, timeline } from "./days";
import type { Session } from "./schedule";

describe("relDay", () => {
  it("names nearby days", () => {
    expect(relDay("2026-11-11", "2026-11-11")).toBe("Today");
    expect(relDay("2026-11-12", "2026-11-11")).toBe("Tomorrow");
    expect(relDay("2026-11-10", "2026-11-11")).toBe("Yesterday");
    expect(relDay("2026-11-15", "2026-11-11")).toBe("In 4 days");
    expect(relDay("2026-12-02", "2026-11-11")).toBe("In 3 weeks");
  });
  it("crosses a month", () => {
    expect(relDay("2026-12-01", "2026-11-30")).toBe("Tomorrow");
  });
});

describe("shortDay", () => {
  it("reads weekday, date and month", () => {
    expect(shortDay("2026-10-15")).toBe("Thu 15 Oct");
  });
});

describe("agenda", () => {
  const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it("groups by day, exams first, past left out", () => {
    const g = agenda(
      [
        { title: "Problem set 2", course: "C", due: Date.parse("2026-11-12T23:59:00Z"), link: "a" },
        { title: "Problem set 1", course: "C", due: Date.parse("2026-11-12T09:00:00Z"), link: "b" },
        { title: "Old", course: "C", due: Date.parse("2026-11-01T09:00:00Z"), link: "c" },
      ],
      [{ id: "e", title: "Test 1", date: "2026-11-12" }],
      "2026-11-11",
      dayOf,
    );
    expect(g.map((d) => d.day)).toEqual(["2026-11-12"]);
    expect(g[0]!.items.map((i) => i.title)).toEqual(["Test 1", "Problem set 1", "Problem set 2"]);
  });
});

describe("timeline", () => {
  const due = agenda(
    [
      { title: "Set 4", course: "Algebra", due: Date.UTC(2026, 10, 12, 23), link: "a.md" },
      { title: "Essay", course: "Writing", due: Date.UTC(2026, 10, 12, 9), link: "b.md" },
    ],
    [{ id: "x", title: "Midterm", course: "Algebra", date: "2026-11-13" }],
    "2026-11-11",
    (ms) => new Date(ms).toISOString().slice(0, 10),
  );
  const s = (id: string, day: string, course?: string): Session => ({ id, day, kind: "review", title: `Review ${id}`, course, target: "2026-11-13", decks: [] });
  const sessions = [
    { day: "2026-11-11", sessions: [s("r1", "2026-11-11", "Algebra")] },
    { day: "2026-11-12", sessions: [s("r2", "2026-11-12", "Algebra")] },
  ];

  it("merges by day: exams, then deadlines by time, then sessions", () => {
    const t = timeline(due, sessions);
    expect(t.map((g) => g.day)).toEqual(["2026-11-11", "2026-11-12", "2026-11-13"]);
    expect(t[1]!.entries.map((e) => e.title)).toEqual(["Essay", "Set 4", "Review r2"]);
    expect(t[2]!.entries.map((e) => e.kind)).toEqual(["exam"]);
  });

  it("keeps one kind or one course and drops days left empty", () => {
    expect(timeline(due, sessions, { show: "session", course: null }).map((g) => g.day)).toEqual(["2026-11-11", "2026-11-12"]);
    const writing = timeline(due, sessions, { show: "all", course: "Writing" });
    expect(writing.flatMap((g) => g.entries.map((e) => e.title))).toEqual(["Essay"]);
  });

  it("counts kinds and courses", () => {
    const c = counts(timeline(due, sessions));
    expect(c).toMatchObject({ all: 5, due: 2, exam: 1, session: 2 });
    expect(c.courses.get("Algebra")).toBe(4);
  });
});
