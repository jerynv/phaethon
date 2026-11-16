import { describe, expect, it } from "vitest";
import { courseOf, shelves, shortName } from "./shelf";

const logic = { folder: "courses/Logic and Discrete Math", name: "Logic and Discrete Math", code: "MTH 214" };
const coded = { folder: "courses/BIO 110 Cells and Systems", name: "BIO 110 Cells and Systems" };

describe("shortName", () => {
  it("drops the card's own course code, however it is spaced", () => {
    expect(shortName("MTH 214 Test 1 practice", logic)).toBe("Test 1 practice");
    expect(shortName("MTH214: Sets quiz", logic)).toBe("Sets quiz");
    expect(shortName("mth-214 – induction", logic)).toBe("Induction");
    expect(shortName("MTH 214-002 Week 3 review", logic)).toBe("Week 3 review");
  });

  it("drops the course name, alone or after the code", () => {
    expect(shortName("Logic and Discrete Math — Week 3 review", logic)).toBe("Week 3 review");
    expect(shortName("MTH 214 Logic and Discrete Math: Relations", logic)).toBe("Relations");
    expect(shortName("BIO 110 Cells and Systems midterm", coded)).toBe("Midterm");
  });

  it("finds a code written in the course's name", () => {
    expect(shortName("BIO 110 Membranes", coded)).toBe("Membranes");
  });

  it("keeps another course's prefix, a partial word and a name that would be left empty", () => {
    expect(shortName("MTH 162 Series", logic)).toBe("MTH 162 Series");
    expect(shortName("Logic and Discrete Mathematics notes", logic)).toBe("Logic and Discrete Mathematics notes");
    expect(shortName("MTH 214", logic)).toBe("MTH 214");
    expect(shortName("Sets and functions", logic)).toBe("Sets and functions");
    expect(shortName("  MTH 214 Sets  ", undefined)).toBe("MTH 214 Sets");
  });
});

describe("shelves", () => {
  const sources = [{ name: logic.name, folder: logic.folder, code: logic.code }, { name: "Calculus II", folder: "courses/Calculus II" }];

  it("groups by course, by name, with cards of no course last", () => {
    const items = [{ course: undefined, id: 1 }, { course: "Logic and Discrete Math", id: 2 }, { course: "Calculus II", id: 3 }, { course: "Logic and Discrete Math", id: 4 }];
    const out = shelves(items, sources);
    expect(out.map((s) => s.course?.name ?? null)).toEqual(["Calculus II", "Logic and Discrete Math", null]);
    expect(out[1]!.items.map((i) => i.id)).toEqual([2, 4]);
    expect(out[1]!.course?.code).toBe("MTH 214");
  });

  it("is one group when every card shares a course", () => {
    expect(shelves([{ course: "Calculus II" }, { course: "Calculus II" }], sources)).toHaveLength(1);
  });

  it("knows a course the space no longer sees by its own name", () => {
    expect(courseOf("Old Course", sources)).toEqual({ folder: "courses/Old Course", name: "Old Course" });
    expect(courseOf("  ", sources)).toBeUndefined();
  });
});
