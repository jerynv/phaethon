import { describe, expect, it } from "vitest";
import { calcItems, itemKey, itemWeights, keyedItems, weightText } from "./table";
import type { GradeItem } from "./types";

const item = (title: string, group: string, possible: number, extra: Partial<GradeItem> = {}): GradeItem => ({
  title,
  group,
  possible,
  submitted: false,
  graded: false,
  late: false,
  missing: false,
  excused: false,
  comments: [],
  ...extra,
});

describe("keyedItems", () => {
  it("keys repeated titles by occurrence", () => {
    const k = keyedItems([item("Quiz", "Q", 10), item("Quiz", "Q", 10), item("HW", "H", 5)]).map((x) => x.key);
    expect(k).toEqual([itemKey("Quiz", 0), itemKey("Quiz", 1), itemKey("HW", 0)]);
  });
  it("turns due dates into ms", () => {
    expect(calcItems({ items: [item("A", "G", 1, { due: "2026-01-01T00:00:00Z" })] })[0]!.due).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });
});

describe("itemWeights", () => {
  it("splits a group's weight by points", () => {
    const w = itemWeights({
      groups: [
        { name: "HW", weight: 40 },
        { name: "Exams", weight: 60 },
      ],
      items: [item("HW 1", "HW", 10), item("HW 2", "HW", 30), item("Final", "Exams", 100), item("Lab", "HW", 10, { excused: true })],
    });
    expect(w.get(itemKey("HW 1", 0))).toBeCloseTo(10);
    expect(w.get(itemKey("HW 2", 0))).toBeCloseTo(30);
    expect(w.get(itemKey("Final", 0))).toBeCloseTo(60);
    expect(w.get(itemKey("Lab", 0))).toBeNull();
  });
  it("rescales weights over groups that have items", () => {
    const w = itemWeights({ groups: [{ name: "HW", weight: 25 }, { name: "Empty", weight: 75 }], items: [item("HW 1", "HW", 10)] });
    expect(w.get(itemKey("HW 1", 0))).toBeCloseTo(100);
  });
  it("uses points when there are no weights", () => {
    const w = itemWeights({ groups: [], items: [item("A", "G", 30), item("B", "G", 10), item("C", "G", 0)] });
    expect(w.get(itemKey("A", 0))).toBeCloseTo(75);
    expect(w.get(itemKey("C", 0))).toBeNull();
  });
});

describe("weightText", () => {
  it("rounds to one place", () => {
    expect(weightText(12.345)).toBe("12.3%");
    expect(weightText(30)).toBe("30%");
    expect(weightText(0.04)).toBe("<0.1%");
    expect(weightText(null)).toBe("–");
  });
});
