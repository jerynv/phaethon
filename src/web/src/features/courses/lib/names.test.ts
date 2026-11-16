import { describe, expect, it } from "vitest";
import { shortCourseName } from "./names";

describe("shortCourseName", () => {
  it("drops a term code in front and a section or CRN after", () => {
    expect(shortCourseName("XX99: INTRO PLACEHOLDER STUDIES: 1234")).toBe("Intro Placeholder Studies");
    expect(shortCourseName("XX99: Placeholder Methods (All Sections)")).toBe("Placeholder Methods");
    expect(shortCourseName("2099FA - Placeholder Lab - 001")).toBe("Placeholder Lab");
    expect(shortCourseName("Fall 2099: Placeholder Seminar (Section 02)")).toBe("Placeholder Seminar");
    expect(shortCourseName("Placeholder Survey Sec. 3")).toBe("Placeholder Survey");
    expect(shortCourseName("XX99: PLACEHOLDER STUDIES: 1234 (ALL SECTIONS)")).toBe("Placeholder Studies");
  });

  it("leaves names that are already readable alone", () => {
    expect(shortCourseName("Calculus II")).toBe("Calculus II");
    expect(shortCourseName("Logic and Discrete Math")).toBe("Logic and Discrete Math");
    expect(shortCourseName("  Placeholder   History 1865-1945 ")).toBe("Placeholder History 1865-1945");
  });

  it("keeps a course code that looks nothing like a term", () => {
    expect(shortCourseName("XYZ 214: PLACEHOLDER THEORY")).toBe("XYZ 214: Placeholder Theory");
    expect(shortCourseName("XYZ214 PLACEHOLDER THEORY")).toBe("XYZ214 Placeholder Theory");
  });

  it("gives names in capitals ordinary case, keeping acronyms and numerals", () => {
    expect(shortCourseName("XX99: CALCULUS II: 1234")).toBe("Calculus II");
    expect(shortCourseName("THE HISTORY OF THE US AND AI")).toBe("The History of the US and AI");
    expect(shortCourseName("CS FOR SOCIO-ECONOMIC POLICY")).toBe("CS for Socio-Economic Policy");
    expect(shortCourseName("WOMEN'S PLACEHOLDER STUDIES")).toBe("Women's Placeholder Studies");
    expect(shortCourseName("PLACEHOLDER HTML AND CSS")).toBe("Placeholder HTML and CSS");
  });

  it("falls back to the name as given when nothing would be left", () => {
    expect(shortCourseName("XX99: 1234")).toBe("XX99: 1234");
    expect(shortCourseName("")).toBe("");
  });
});
