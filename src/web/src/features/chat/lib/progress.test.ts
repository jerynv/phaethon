import { describe, expect, test } from "vitest";
import { elapsedText, friendlyStep, patienceHint, prettyName } from "./progress.ts";

describe("friendly progress", () => {
  test("file names read as words", () => {
    expect(prettyName("courses/math301/week-6_notes.md")).toBe("week 6 notes");
    expect(prettyName("Algebra notes.pdf")).toBe("Algebra notes");
    expect(prettyName(".env")).toBe(".env");
  });

  test("each kind of step says what it does without tool names", () => {
    expect(friendlyStep({ category: "read", label: "Reading file", target: "notes/algebra-notes.md" })).toBe("Reading algebra notes");
    expect(friendlyStep({ category: "list", label: "Listing files", target: "." }, "School")).toBe("Looking through your School files");
    expect(friendlyStep({ category: "list", label: "Listing files", target: "courses/" })).toBe("Looking through courses");
    expect(friendlyStep({ category: "search", label: "Searching" }, "Work")).toBe("Searching your Work files");
    expect(friendlyStep({ category: "write", label: "Changing file", target: "summary.md" })).toBe("Writing summary");
    expect(friendlyStep({ category: "command", label: "Running command" })).toBe("Working on your computer");
    expect(friendlyStep({ category: "other", label: "Using tool", target: "calendar" })).toBe("Using calendar");
    expect(friendlyStep({ category: "other", label: "Planning the lesson" })).toBe("Planning the lesson");
  });

  test("elapsed time and the patience hint", () => {
    expect(elapsedText(4200)).toBe("4s");
    expect(elapsedText(65000)).toBe("1m 05s");
    expect(patienceHint(3000)).toBeNull();
    expect(patienceHint(9000, "read")).toBe("Still reading");
    expect(patienceHint(45000)).toMatch(/still working/i);
  });
});
