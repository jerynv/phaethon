import { describe, expect, test } from "vitest";
import { mentionText, rankCommands, rankFiles, replaceTrigger, triggerAt } from "./composer-menu.ts";

describe("composer autocomplete", () => {
  test("@ opens after a space or at the start, / only at a line start", () => {
    expect(triggerAt("see @lec", 8)).toEqual({ kind: "mention", query: "lec", start: 4, end: 8 });
    expect(triggerAt("@", 1)).toEqual({ kind: "mention", query: "", start: 0, end: 1 });
    expect(triggerAt("mail me@uni", 11)).toBeNull();
    expect(triggerAt("/qu", 3)).toEqual({ kind: "command", query: "qu", start: 0, end: 3 });
    expect(triggerAt("hi\n/new", 7)).toEqual({ kind: "command", query: "new", start: 3, end: 7 });
    expect(triggerAt("a/b", 3)).toBeNull();
    expect(triggerAt("see @lec now", 12)).toBeNull();
  });

  test("picking replaces the trigger and leaves one space", () => {
    expect(replaceTrigger("see @lec", { kind: "mention", query: "lec", start: 4, end: 8 }, "@notes/l.md")).toEqual({ text: "see @notes/l.md ", caret: 16 });
    expect(replaceTrigger("/qu rest", { kind: "command", query: "qu", start: 0, end: 3 }, "")).toEqual({ text: " rest", caret: 0 });
    expect(mentionText("a b/c.md")).toBe('@"a b/c.md"');
  });

  test("files rank by name start, then name, then path, then letters in order", () => {
    const files = [{ path: "courses/lec/notes.md" }, { path: "notes/lecture-7.md" }, { path: "x/my-lecture.pdf" }, { path: "a/l-e-c.txt" }];
    expect(rankFiles(files, "lec").map((f) => f.path)).toEqual(["notes/lecture-7.md", "x/my-lecture.pdf", "courses/lec/notes.md", "a/l-e-c.txt"]);
    expect(rankFiles(files, "zzz")).toEqual([]);
    expect(rankFiles(files, "", 2)).toHaveLength(2);
  });

  test("teaching modes appear only in spaces with study tools", () => {
    expect(rankCommands("", false).map((c) => c.id)).toEqual(["new", "model", "attach"]);
    expect(rankCommands("q", true).map((c) => c.id)).toEqual(["quiz"]);
    expect(rankCommands("exam", true).map((c) => c.id)).toEqual(["cram"]);
  });
});
