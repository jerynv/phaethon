import { describe, expect, test } from "vitest";
import { fileGroups, folderOf, readSkipped, skippedGroups } from "./content";
import type { CourseContentEntry } from "./types";

const C = "courses/Cell Biology";
const file = (rel: string, from?: string): CourseContentEntry => ({ path: `${C}/files/${rel}`, title: rel.split("/").pop()!, kind: "file", ...(from ? { from } : {}) });

describe("course files", () => {
  test("the folder below files/", () => {
    expect(folderOf(`${C}/files/Lectures/Week 1/a.pdf`)).toBe("Lectures/Week 1");
    expect(folderOf(`${C}/files/a.pdf`)).toBe("");
    expect(folderOf(`${C}/syllabus.md`)).toBe("");
  });

  test("attachments first, then folders with the top one first", () => {
    const groups = fileGroups([
      file("Labs/lab1.pdf"),
      file("review.pdf", "Announcement “Exam 2”"),
      file("syllabus.pdf"),
      file("Exams/old.pdf"),
      { path: `${C}/syllabus.md`, title: "Syllabus", kind: "overview" },
    ]);
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.title)])).toEqual([
      ["From announcements and discussions", ["review.pdf"]],
      ["Course files", ["syllabus.pdf"]],
      ["Exams", ["old.pdf"]],
      ["Labs", ["lab1.pdf"]],
    ]);
  });
});

describe("what the last import skipped", () => {
  test("what and why, locked or not", () => {
    expect(readSkipped("File “key.pdf” (from announcement “Exam 2”): locked for now")).toEqual({ what: "key.pdf (from announcement “Exam 2”)", why: "locked for now", locked: true });
    expect(readSkipped("Page “Week 9”: locked for now")).toMatchObject({ what: "Week 9", locked: true });
    expect(readSkipped("big.mp4: too big to download (900 MB; the limit is 500 MB)")).toEqual({ what: "big.mp4", why: "too big to download (900 MB; the limit is 500 MB)", locked: false });
    expect(readSkipped("Syllabus")).toEqual({ what: "Syllabus", why: "", locked: false });
  });

  test("locked first", () => {
    const g = skippedGroups(["Announcements: the site didn’t answer.", "File “a.pdf”: locked for now"]);
    expect(g.locked.map((n) => n.what)).toEqual(["a.pdf"]);
    expect(g.other.map((n) => n.what)).toEqual(["Announcements"]);
    expect(skippedGroups(undefined)).toEqual({ locked: [], other: [] });
  });
});
