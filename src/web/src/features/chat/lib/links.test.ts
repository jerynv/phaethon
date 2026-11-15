import { describe, expect, test } from "vitest";
import { baseName, linkTarget, looksLikeFilePath } from "./links.ts";

describe("links in replies", () => {
  test("web and mail links open outside, anchors and other schemes do nothing", () => {
    expect(linkTarget("https://example.com/a?b")).toEqual({ kind: "external", url: "https://example.com/a?b" });
    expect(linkTarget("mailto:prof@uni.edu")).toEqual({ kind: "external", url: "mailto:prof@uni.edu" });
    expect(linkTarget("#section")).toEqual({ kind: "anchor" });
    expect(linkTarget("javascript:alert(1)")).toEqual({ kind: "none" });
    expect(linkTarget("")).toEqual({ kind: "none" });
  });

  test("relative, rooted and app:// links are files in the space", () => {
    expect(linkTarget("notes/week%206.md")).toEqual({ kind: "file", path: "notes/week 6.md" });
    expect(linkTarget("./notes/a.md#h")).toEqual({ kind: "file", path: "notes/a.md" });
    expect(linkTarget("/courses/math301/problem-set-6.pdf")).toEqual({ kind: "file", path: "courses/math301/problem-set-6.pdf" });
    expect(linkTarget("app://phaethon/notes/b.md")).toEqual({ kind: "file", path: "notes/b.md" });
  });

  test("a link that climbs out of the space is not a file", () => {
    expect(linkTarget("../other/secret.md")).toEqual({ kind: "none" });
  });

  test("inline code reads as a file only when it is a plain relative path with a known extension", () => {
    expect(looksLikeFilePath("notes/week-6.md")).toBe(true);
    expect(looksLikeFilePath("problem-set-6.pdf")).toBe(true);
    expect(looksLikeFilePath("npm run build")).toBe(false);
    expect(looksLikeFilePath("/etc/passwd")).toBe(false);
    expect(looksLikeFilePath("../x.md")).toBe(false);
    expect(looksLikeFilePath("x = a.md")).toBe(false);
    expect(looksLikeFilePath("Array.map")).toBe(false);
  });

  test("base names", () => {
    expect(baseName("a/b/c.pdf")).toBe("c.pdf");
    expect(baseName("c.pdf")).toBe("c.pdf");
    expect(baseName("a/b/")).toBe("b");
  });
});
