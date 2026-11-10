import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fromCookies, metaToken, moodleSesskey, urlDecode } from "./csrf.ts";
import { isRustWhitespace } from "./types.ts";
import { isPlain, linkTarget, relPath, segment, Taken, write } from "./names.ts";
import { looksLike, type Answer } from "./probe.ts";
import { isPublic } from "./session.ts";
import { gradeWords, num, parseTime, utcParts } from "./store.ts";
import { isbns, isTextbook, pdfLinkOnPage } from "./textbooks.ts";
import { Site, type Kind } from "./types.ts";

describe("sites (mod.rs)", () => {
  it("a site is its https origin and moodle keeps its folder", () => {
    expect(Site.create("canvas", "iu.instructure.com/courses/12?x=1#y").base.href).toBe("https://iu.instructure.com/");
    expect(() => Site.create("canvas", "http://iu.instructure.com")).toThrow("Use the https address you see when you open your course site.");
    expect(() => Site.create("canvas", "https://me:pw@iu.instructure.com")).toThrow();
    for (const [typed, base] of [
      ["https://x.edu/moodle/my/", "https://x.edu/moodle/"],
      ["x.edu/moodle/login/index.php", "https://x.edu/moodle/"],
      ["https://x.edu/campus/moodle/course/view.php?id=3", "https://x.edu/campus/moodle/"],
      ["https://moodle.x.edu/my/courses.php", "https://moodle.x.edu/"],
      ["https://moodle.x.edu", "https://moodle.x.edu/"],
      ["https://x.edu/moodle", "https://x.edu/moodle/"],
    ]) {
      expect(Site.create("moodle", typed).base.href, typed).toBe(base);
    }
    const m = Site.create("moodle", "https://x.edu/moodle/");
    expect(m.join("lib/ajax/service.php").href).toBe("https://x.edu/moodle/lib/ajax/service.php");
    expect(m.owns(new URL("https://x.edu/other"))).toBe(true);
    expect(m.owns(new URL("https://x.edu:8443/other"))).toBe(false);
  });

  it("links out reach only the public internet", () => {
    for (const local of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1", "224.0.0.1", "255.255.255.255", "192.0.2.5", "::"]) {
      expect(isPublic(local), local).toBe(false);
    }
    for (const pub of ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "::ffff:1.1.1.1"]) expect(isPublic(pub), pub).toBe(true);
  });

  it("uses Rust's idea of whitespace", () => {
    expect(isRustWhitespace("\u0085")).toBe(true);
    expect(isRustWhitespace("\ufeff")).toBe(false);
  });
});

describe("names.rs", () => {
  it("hostile names become plain parts", () => {
    expect(segment("../../.ssh/config")).toBe("ssh-config");
    expect(segment("..")).toBe("untitled");
    expect(segment("...")).toBe("untitled");
    expect(segment("/etc/passwd")).toBe("etc-passwd");
    expect(segment("a\u0000b\nc\u007f.pdf")).toBe("abc.pdf");
    expect(segment(".hidden")).toBe("hidden");
    expect(segment("CON.txt")).toBe("_CON.txt");
    expect(segment("C:\\Windows")).toBe("C--Windows");
    const long = `${"x".repeat(300)}.pdf`;
    expect([...segment(long)].length).toBe(100);
    expect(segment(long).endsWith(".pdf")).toBe(true);
    expect(relPath("../Lectures//./Week 1/..", "../notes.pdf")).toBe("Lectures/Week 1/notes.pdf");
    expect(relPath("/abs/olute", "x")).toBe("abs/olute/x");
    expect(isPlain(relPath("/", "/"))).toBe(true);
  });

  it("collisions are numbered without case", () => {
    const t = new Taken();
    expect(t.claim("files/a.pdf")).toBe("files/a.pdf");
    expect(t.claim("files/A.pdf")).toBe("files/A (2).pdf");
    expect(t.claim("files/a.pdf")).toBe("files/a (3).pdf");
  });

  it("writes never follow a symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-names-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-names-outside-"));
    try {
      write(root, "a/b.txt", "one");
      expect(fs.readFileSync(path.join(root, "a/b.txt"), "utf8")).toBe("one");
      write(root, "a/b.txt", "two");
      expect(fs.readFileSync(path.join(root, "a/b.txt"), "utf8")).toBe("two");
      fs.symlinkSync(outside, path.join(root, "link"));
      expect(() => write(root, "link/x.txt", "no")).toThrow();
      expect(fs.existsSync(path.join(outside, "x.txt"))).toBe(false);
      fs.symlinkSync(path.join(outside, "target.txt"), path.join(root, "f.txt"));
      write(root, "f.txt", "safe");
      expect(fs.existsSync(path.join(outside, "target.txt"))).toBe(false);
      expect(fs.lstatSync(path.join(root, "f.txt")).isSymbolicLink()).toBe(false);
      expect(() => write(root, "../escape.txt", "no")).toThrow();
      expect(() => write(root, "/tmp/escape.txt", "no")).toThrow();
      expect(fs.readdirSync(path.join(root, "a")).filter((n) => n.endsWith(".part"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("link targets escape what breaks Markdown links", () => {
    expect(linkTarget("files/Week 1/a (1).pdf")).toBe("files/Week%201/a%20%281%29.pdf");
    expect(linkTarget("a%b<c>")).toBe("a%25b%3Cc%3E");
  });
});

describe("store.rs dates and numbers", () => {
  it("rfc3339 times", () => {
    expect(parseTime("1970-01-01T00:00:00Z")).toBe(0);
    expect(parseTime("2026-10-14T23:59:00Z")).toBe(1_792_022_340);
    expect(parseTime("2026-10-14T19:59:00-04:00")).toBe(1_792_022_340);
    expect(parseTime("2026-10-14T23:59:00.123Z")).toBe(1_792_022_340);
    expect(parseTime("2026-10-14")).toBe(1_791_936_000);
    expect(parseTime("soon")).toBe(null);
    expect(parseTime("2026-13-01T00:00:00Z")).toBe(null);
    expect(utcParts(1_792_022_340)).toEqual([2026, 10, 14, 23, 59, 3]);
  });

  it("grades in a few words", () => {
    expect(num(86.4)).toBe("86.4");
    expect(num(90)).toBe("90");
    expect(num(2.005)).toBe("2.01");
    expect(gradeWords({ percent: 86.4, letter: "B+" })).toBe("86.4% (B+)");
    expect(gradeWords({ letter: "B+" })).toBe("B+");
    expect(gradeWords({ points: 432, possible: 500 })).toBe("432 of 500 points");
    expect(gradeWords({ possible: 500 })).toBe(null);
  });
});

describe("csrf.rs", () => {
  it("tokens from cookies and pages", () => {
    const c = (name: string, value: string) => ({ name, value });
    expect(fromCookies([c("a", "1"), c("_csrf_token", "ab%2Bc%3D%3D")])).toBe("ab+c==");
    expect(fromCookies([c("XSRF-TOKEN", "x1")])).toBe("x1");
    expect(fromCookies([c("_csrf_token", "bad\r\nX: y")])).toBe(null);
    expect(moodleSesskey('M.cfg = {"wwwroot":"https://m","sesskey":"AbC123","x":1};')).toBe("AbC123");
    expect(moodleSesskey('<input type="hidden" name="sesskey" value="Zz9">')).toBe("Zz9");
    expect(metaToken('<head><meta charset="utf-8"><META name="csrf-token" content="t&amp;k"></head>')).toBe("t&k");
    expect(metaToken("<meta name=description content=x>")).toBe(null);
    expect(urlDecode("a%20b%zz%4")).toBe("a b%zz%4");
  });
});

describe("probe.rs", () => {
  const answer = (status: number, contentType: string, cookies: string[], headers: string[], body: string): Answer => ({ status, contentType, cookies, headers, body });
  it("each kind is told apart by its own answer", () => {
    const canvas = answer(401, "application/json", [], [], '{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}');
    expect(looksLike("canvas", canvas)).toBe(true);
    expect(looksLike("moodle", canvas) || looksLike("brightspace", canvas) || looksLike("blackboard", canvas)).toBe(false);
    const d2l = answer(200, "application/json; charset=utf-8", [], [], '[{"ProductCode":"lp","LatestVersion":"1.47","SupportedVersions":["1.0"]}]');
    expect(looksLike("brightspace", d2l) && !looksLike("canvas", d2l)).toBe(true);
    const moodle = answer(303, "text/html", ["MoodleSession=abc; path=/; secure"], [], "");
    expect(looksLike("moodle", moodle) && !looksLike("canvas", moodle)).toBe(true);
    const bb = answer(200, "application/json", [], [], '{"learn":{"major":3900,"minor":110}}');
    expect(looksLike("blackboard", bb) && !looksLike("brightspace", bb)).toBe(true);
  });
  it("an ordinary web page is no course site", () => {
    const page = answer(404, "text/html", [], [], "<html><title>Not found</title><p>Example University</p></html>");
    for (const k of ["canvas", "brightspace", "moodle", "blackboard"] as Kind[]) expect(looksLike(k, page), k).toBe(false);
  });
});

describe("textbooks.rs", () => {
  it("isbns need a valid check digit", () => {
    const text =
      "Required: Stewart, Calculus 9th ed., ISBN 978-1-337-61392-7 (hardcover).\nAlso ISBN-10: 0-306-40615-2.\nCall 812-555-1234 or 9781337613920 (wrong check digit).\nTen digits without the word: 0306406152.";
    const found = isbns(text);
    expect(found.map((i) => i.isbn)).toEqual(["9781337613927", "0306406152"]);
    expect(found[0].line.startsWith("Required: Stewart")).toBe(true);
  });
  it("textbook links by words or host", () => {
    const l = (u: string, text: string, context: string) => ({ url: new URL(u), text, context });
    expect(isTextbook(l("https://example.com/book", "Book", "Required textbook: Book"))).toBe(true);
    expect(isTextbook(l("https://math.libretexts.org/Bookshelves/x", "Chapter 2", "Read Chapter 2"))).toBe(true);
    expect(isTextbook(l("https://zoom.us/j/1", "Office hours", "Office hours on Zoom"))).toBe(false);
  });
  it("the pdf link on a book page", () => {
    const page = new URL("https://open.umn.edu/opentextbooks/textbooks/123");
    expect(pdfLinkOnPage('<a href="/about">About</a><a href="https://cdn.example.org/files/book.PDF">Get it</a>', page)?.href).toBe("https://cdn.example.org/files/book.PDF");
    expect(pdfLinkOnPage('<a href="/dl/77">Download PDF</a>', page)?.href).toBe("https://open.umn.edu/dl/77");
    expect(pdfLinkOnPage('<a href="/x">Read online</a>', page)).toBe(null);
  });
});
