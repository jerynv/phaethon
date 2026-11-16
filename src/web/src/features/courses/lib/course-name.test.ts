import { describe, expect, test } from "vitest";

import { byShortName, shortCourseName, titleCaseName } from "./course-name";

describe("shortCourseName", () => {
  test("drops the term prefix and the trailing CRN", () => {
    expect(shortCourseName("XX99: INTRO PLACEHOLDER STUDIES: 1234")).toBe("Intro Placeholder Studies");
    expect(shortCourseName("FA26 - LOGIC AND DISCRETE MATH: 40211")).toBe("Logic and Discrete Math");
    expect(shortCourseName("202610: SAMPLE SEMINAR")).toBe("Sample Seminar");
    expect(shortCourseName("Fall 2026: Sample Seminar")).toBe("Sample Seminar");
  });

  test("drops section suffixes in their usual shapes", () => {
    expect(shortCourseName("XX99: CALCULUS II - SEC 002: 40388")).toBe("Calculus II");
    expect(shortCourseName("Placeholder Lab (01)")).toBe("Placeholder Lab");
    expect(shortCourseName("Placeholder Lab, Section B")).toBe("Placeholder Lab");
    expect(shortCourseName("Placeholder Lab [Sec. 3]")).toBe("Placeholder Lab");
  });

  test("keeps codes, numerals and acronyms in capitals", () => {
    expect(shortCourseName("XX99: GENERAL CHEMISTRY I LAB: 30871")).toBe("General Chemistry I Lab");
    expect(shortCourseName("XX99: US HISTORY SINCE 1877: 31004")).toBe("US History Since 1877");
    expect(shortCourseName("XX99: WEB DESIGN WITH HTML AND CSS")).toBe("Web Design with HTML and CSS");
    expect(shortCourseName("XX99: CS101 PROGRAMMING FOUNDATIONS")).toBe("CS101 Programming Foundations");
    expect(shortCourseName("XX99: FIRST-YEAR SEMINAR")).toBe("First-Year Seminar");
    expect(shortCourseName("XX99: WOMEN'S HISTORY: AN OVERVIEW")).toBe("Women's History: An Overview");
  });

  test("leaves names that are already readable alone", () => {
    expect(shortCourseName("Calculus II")).toBe("Calculus II");
    expect(shortCourseName("  Mind and   Behavior ")).toBe("Mind and Behavior");
    expect(shortCourseName("iOS Development")).toBe("iOS Development");
  });

  test("falls back to the raw name when no words would be left", () => {
    expect(shortCourseName("XX99: 1234")).toBe("XX99: 1234");
    expect(shortCourseName("")).toBe("");
  });
});

describe("titleCaseName", () => {
  test("only touches names that arrived in capitals", () => {
    expect(titleCaseName("BEGINNING SPANISH")).toBe("Beginning Spanish");
    expect(titleCaseName("Beginning SPANISH")).toBe("Beginning SPANISH");
    expect(titleCaseName("THE ART OF THE ESSAY")).toBe("The Art of the Essay");
  });
});

describe("byShortName", () => {
  test("orders by the name people read, not the term prefix", () => {
    const list = [{ name: "XX99: ZOOLOGY: 1001" }, { name: "AA11: BIOLOGY: 2002" }, { name: "Algebra" }];
    expect(list.sort(byShortName).map((c) => shortCourseName(c.name))).toEqual(["Algebra", "Biology", "Zoology"]);
  });
});
