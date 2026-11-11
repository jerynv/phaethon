import { describe, expect, it } from "vitest";
import { agenda, relDay, shortDay } from "./days";

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
        { title: "HW 2", course: "C", due: Date.parse("2026-11-12T23:59:00Z"), link: "a" },
        { title: "HW 1", course: "C", due: Date.parse("2026-11-12T09:00:00Z"), link: "b" },
        { title: "Old", course: "C", due: Date.parse("2026-11-01T09:00:00Z"), link: "c" },
      ],
      [{ id: "e", title: "Test 1", date: "2026-11-12" }],
      "2026-11-11",
      dayOf,
    );
    expect(g.map((d) => d.day)).toEqual(["2026-11-12"]);
    expect(g[0]!.items.map((i) => i.title)).toEqual(["Test 1", "HW 1", "HW 2"]);
  });
});
