import { describe, expect, it } from "vitest";
import { countText, jobFraction } from "./progress";

describe("jobFraction", () => {
  it("gives each make step its slice", () => {
    expect(jobFraction({ step: "reading", done: 0, total: 1 }, "make")).toBeCloseTo(0.25);
    expect(jobFraction({ step: "checking", done: 6, total: 12 }, "make")).toBeCloseTo(0.745);
    expect(jobFraction({ step: "saving", done: 1, total: 1 }, "make")).toBe(1);
  });
  it("never moves back", () => {
    const at = jobFraction({ step: "checking", done: 6, total: 12 }, "make");
    expect(jobFraction({ step: "making", done: 1, total: 3 }, "make", at)).toBe(at);
  });
  it("uses done/total for single-step jobs", () => {
    expect(jobFraction({ step: "mapping", done: 1, total: 4 }, "single")).toBe(0.25);
    expect(jobFraction({ step: "grading", done: 0, total: 0 }, "single")).toBe(0);
  });
});

describe("countText", () => {
  it("shows a count only when there is more than one", () => {
    expect(countText({ done: 3, total: 12 })).toBe("3/12");
    expect(countText({ done: 0, total: 1 })).toBe("");
    expect(countText({ done: 14, total: 12 })).toBe("12/12");
    expect(countText(null)).toBe("");
    expect(countText({ step: "checking", done: 3, total: 12 })).toBe("");
  });
});

import { coursesOf, partPath } from "./kinds";

describe("source paths", () => {
  it("names a course part's path", () => {
    expect(partPath("courses/Calc", "syllabus")).toBe("courses/Calc/syllabus.md");
    expect(partPath("courses/Calc", "files")).toBe("courses/Calc/files");
  });
  it("finds the courses chosen paths come from", () => {
    const folders = ["courses/Calc", "courses/Calc II"];
    expect(coursesOf(["courses/Calc II/files/a.pdf", "courses/Calc/syllabus.md", "courses/Calc/files"], folders)).toEqual(["courses/Calc II", "courses/Calc"]);
    expect(coursesOf(["notes.md"], folders)).toEqual([]);
  });
});
