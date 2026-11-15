import { describe, expect, it } from "vitest";
import { gpaText, pointsFor, readScale, scaleMax, STANDARD, termGpa } from "./gpa";

describe("grade points", () => {
  it("reads letters as a site writes them, on the standard scale", () => {
    expect(pointsFor("A-", STANDARD)).toBe(3.7);
    expect(pointsFor(" b+ ", STANDARD)).toBe(3.3);
    expect(pointsFor("A−", STANDARD)).toBe(3.7);
    expect(pointsFor("complete", STANDARD)).toBeNull();
    expect(pointsFor(undefined, STANDARD)).toBeNull();
  });

  it("averages only the letters it knows", () => {
    expect(termGpa(["A", "B+", "complete", undefined], STANDARD)).toEqual({ gpa: 3.65, counted: 2 });
    expect(termGpa(["P"], STANDARD)).toBeNull();
    expect(gpaText(3.65)).toBe("3.65");
    expect(gpaText(4)).toBe("4.0");
    expect(gpaText(3.7)).toBe("3.7");
  });

  it("takes a custom scale over the standard points and keeps its top mark", () => {
    const scale = readScale({ kind: "custom", points: { "A+": 4.3, A: 4, bad: "x", huge: 99 } });
    expect(scale).toEqual({ kind: "custom", points: { "A+": 4.3, A: 4 } });
    expect(pointsFor("A+", scale)).toBe(4.3);
    expect(pointsFor("B", scale)).toBe(3);
    expect(scaleMax(scale)).toBe(4.3);
    expect(scaleMax(STANDARD)).toBe(4);
    expect(readScale("nonsense")).toEqual(STANDARD);
    expect(readScale({ kind: "standard" })).toEqual(STANDARD);
  });
});
