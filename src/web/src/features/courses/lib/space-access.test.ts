import { describe, expect, test } from "vitest";

import { courseGroups, shortCourseName, sortSpaces, spacesOf } from "./space-access";
import type { CourseAccessView, CourseInfo } from "./types";

describe("shortCourseName", () => {
  test("drops the term, the code and the section, and title-cases capitals", () => {
    expect(shortCourseName("FA26 MTH-214-01 LOGIC AND DISCRETE MATH")).toBe("Logic and Discrete Math");
    expect(shortCourseName("2026FA-BIO-1406-003 GENERAL BIOLOGY I")).toBe("General Biology I");
    expect(shortCourseName("Fall 2026: CHM 1311.002 - INTRO TO CHEMISTRY II")).toBe("Intro to Chemistry II");
    expect(shortCourseName("202610_HIS_2301_012 WORLD HISTORY OF THE AMERICAS (Sec 02)")).toBe("World History of the Americas");
    expect(shortCourseName("SP26 ART 120 DRAWING STUDIO CRN 48213")).toBe("Drawing Studio");
    expect(shortCourseName("ECON 201 PRINCIPLES OF MICROECONOMICS - 004")).toBe("Principles of Microeconomics");
    expect(shortCourseName("STATISTICS FOR THE SCIENCES [31877]")).toBe("Statistics for the Sciences");
  });

  test("leaves readable names alone", () => {
    expect(shortCourseName("Calculus II")).toBe("Calculus II");
    expect(shortCourseName("Mind and Behavior")).toBe("Mind and Behavior");
    expect(shortCourseName("Beginning Spanish 2")).toBe("Beginning Spanish 2");
    expect(shortCourseName("Intro to Python")).toBe("Intro to Python");
  });

  test("keeps the raw name when nothing readable would be left", () => {
    expect(shortCourseName("FA26 MTH-214-01")).toBe("FA26 MTH-214-01");
    expect(shortCourseName("12345")).toBe("12345");
  });
});

const course = (key: string, name: string, connection = "c1"): CourseInfo => ({ key, connection, courseId: key, name, folder: `courses/${name}` });

describe("access rows", () => {
  const view: CourseAccessView = {
    spaces: ["a", "b", "c"],
    courses: [course("1", "ZOOLOGY 101 - 001"), course("2", "Algebra"), course("3", "Chemistry", "c2"), course("4", "Drawing", "c2")],
    access: { a: { "1": ["overview", "files"], "2": ["overview"] }, b: { "1": ["overview"] }, c: {} },
    problems: [],
  };

  test("spaces that see every part, and those that see some", () => {
    expect(spacesOf(view, "1", 2)).toEqual({ all: ["a"], some: ["b"] });
    expect(spacesOf(view, "3", 2)).toEqual({ all: [], some: [] });
  });

  test("study spaces first, then by name", () => {
    expect(sortSpaces([{ id: "w", name: "Work" }, { id: "l", name: "Life" }, { id: "s", name: "School", educationEnabled: true }]).map((s) => s.id)).toEqual(["s", "l", "w"]);
  });

  test("one school: one group; courses no space sees go last", () => {
    const r = courseGroups(view, { partCount: 2, schoolOf: () => "North" });
    expect(r.groups.map((g) => [g.label, g.rows.map((x) => x.label)])).toEqual([[undefined, ["Algebra", "Zoology 101"]]]);
    expect(r.hidden.map((x) => x.label)).toEqual(["Chemistry", "Drawing"]);
    expect(r.total).toBe(4);
  });

  test("more than one school: grouped by school", () => {
    const seen: CourseAccessView = { ...view, access: { ...view.access, c: { "3": ["overview"] } } };
    const r = courseGroups(seen, { partCount: 2, schoolOf: (c) => (c.connection === "c1" ? "North" : "Ridge") });
    expect(r.groups.map((g) => [g.label, g.rows.map((x) => x.course.key)])).toEqual([
      ["North", ["2", "1"]],
      ["Ridge", ["3"]],
    ]);
    expect(r.hidden.map((x) => x.course.key)).toEqual(["4"]);
  });

  test("a query matches the short name, the raw name or the code", () => {
    expect(courseGroups(view, { partCount: 2, query: "zoo", schoolOf: () => "" }).total).toBe(1);
    expect(courseGroups(view, { partCount: 2, query: "101", schoolOf: () => "" }).total).toBe(1);
    expect(courseGroups(view, { partCount: 2, query: "draw", schoolOf: () => "" }).hidden.map((x) => x.label)).toEqual(["Drawing"]);
  });
});
