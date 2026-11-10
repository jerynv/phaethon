import fs from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { canvas } from "./adapters/canvas.ts";
import { defaultOptions, fetchFile, fileKey, importCourse, linkKey, sniff, type Got, type Options, type Step } from "./import.ts";
import { allowLoopbackForTests, Session } from "./session.ts";
import type { FileRec } from "./store.ts";
import { testPdf } from "./text/test-pdfs.ts";
import { emptyContent, gradeItem, remoteFile, Site, type Course, type CourseContent, type CourseGrades, type RemoteFile } from "./types.ts";

/**
 * The importer end to end against two local fake servers: the course site
 * (which wants the session cookie) and "the internet" (a publisher, a blog, a
 * storage host the site redirects to), which must never see the cookie.
 */

type Route = { status: number; headers: Record<string, string>; body: Buffer };
type Hit = [string, string | null];

const ok = (ct: string, body: string | Buffer): Route => ({ status: 200, headers: { "Content-Type": ct }, body: typeof body === "string" ? Buffer.from(body) : body });

class Server {
  routes = new Map<string, Route>();
  log: Hit[] = [];
  cond: Hit[] = [];
  modifiedCond: Hit[] = [];
  base!: URL;
  #server!: http.Server;
  #sockets = new Set<Socket>();

  async start(): Promise<this> {
    this.#server = http.createServer((req, res) => {
      const target = req.url ?? "/";
      const p = target.split("?")[0];
      const inm = (req.headers["if-none-match"] as string | undefined) ?? null;
      const ims = (req.headers["if-modified-since"] as string | undefined) ?? null;
      this.log.push([p, req.headers.cookie ?? null]);
      this.cond.push([p, inm]);
      this.modifiedCond.push([p, ims]);
      let r = this.routes.get(p) ?? { status: 404, headers: {}, body: Buffer.from("nope") };
      // A server that honours conditional requests; ETag takes precedence.
      const etag = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "etag")?.[1] ?? null;
      const modified = Object.entries(r.headers).find(([k]) => k.toLowerCase() === "last-modified")?.[1] ?? null;
      if (inm !== null ? etag !== null && etag === inm : ims !== null && modified === ims) r = { status: 304, headers: r.headers, body: Buffer.alloc(0) };
      res.writeHead(r.status, { Connection: "close", "Content-Length": String(r.body.length), ...r.headers });
      res.end(r.body);
    });
    this.#server.on("connection", (s) => {
      this.#sockets.add(s);
      s.on("close", () => this.#sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve()));
    this.base = new URL(`http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`);
    return this;
  }

  route(p: string, r: Route): void {
    this.routes.set(p, r);
  }

  hits(p: string): (string | null)[] {
    return this.log.filter(([x]) => x === p).map(([, c]) => c);
  }

  close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

const servers: Server[] = [];
const extraClose: (() => Promise<void>)[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const c of extraClose.splice(0)) await c();
  if (!process.env.PHAETHON_KEEP_IMPORT) for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
  allowLoopbackForTests(false);
});

function tempRoot(tag: string): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `phaethon-import-${tag}-`));
  roots.push(r);
  return r;
}

type Fixture = { site: Server; web: Server; s: URL; e: URL; root: string; session: Session };

async function fixture(tag: string): Promise<Fixture> {
  allowLoopbackForTests(true);
  const site = await new Server().start();
  const web = await new Server().start();
  servers.push(site, web);
  const root = tempRoot(tag);
  fs.mkdirSync(path.join(root, "courses"));
  const session = new Session(Site.forTest("canvas", site.base.href), { cookies: [{ name: "canvas_session", value: "SECRET" }], csrf: null });
  return { site, web, s: site.base, e: web.base, root, session };
}

function file(name: string, folder: string | null, url: URL, size: number | null, aliases: URL[]): RemoteFile {
  return remoteFile(name, url, { folder, size, aliases });
}

const j = (b: URL, p: string) => new URL(p, b);

function content(f: Fixture): CourseContent {
  const { s, e } = f;
  const syllabus =
    `<h1>Syllabus</h1><p>Required textbook: <a href="${j(e, "/book")}">OpenStax Calculus</a>, ISBN 978-1-337-61392-7.</p>` +
    `<p>Slides: <a href="/courses/1/files/1?verifier=zz&amp;wrap=1">Lecture 1</a>. Start with <a href="/courses/1/pages/intro">the intro</a>.</p>` +
    `<p>Tips: <a href="${j(e, "/blog")}">this blog</a>. Notes: <a href="${j(e, "/notes.pdf")}">Notes</a>. <a href="${j(e, "/locked.pdf")}">Publisher chapter</a> (required reading).</p>` +
    `<p>Due: <a href="/courses/1/assignments/5">Problem Set 1</a>.</p><script>steal()</script>`;
  return {
    syllabus,
    modules: [{ name: "Week 1", items: ["Intro", "Lecture 1.pdf", "Problem Set 1", "Unknown thing"] }],
    pages: [{ title: "Intro", html: '<p>Back to <a href="/courses/1/files/1/preview">the slides</a>.</p>', url: j(s, "/courses/1/pages/intro") }],
    assignments: [
      { title: "Problem Set 1", due: "2099-01-02T03:59:00Z", points: 10, html: "<p>Do it.</p>", url: j(s, "/courses/1/assignments/5") },
      { title: "Old quiz", due: "2001-01-01T00:00:00Z", points: null, html: "", url: null },
    ],
    announcements: [{ title: "Welcome", posted: "2026-08-20T12:00:00Z", html: "<p>Hi all</p>" }],
    files: [
      file("Lecture 1.pdf", "Week 1", j(s, "/files/1/download?verifier=abc"), null, [j(s, "/courses/1/files/1")]),
      file("../../evil.txt", "../..", j(s, "/files/2/download"), 1, []),
      file("Evil.txt", null, j(s, "/files/3/download"), 1, []),
      file("huge.zip", null, j(s, "/files/4/download"), 10 * 1024 * 1024 * 1024, []),
      file("stream.bin", null, j(s, "/files/5/download"), null, []),
      file("storage.pdf", null, j(s, "/files/6/download"), null, []),
    ],
    links: [{ title: "Course blog", url: j(e, "/blog") }],
    skipped: ["Discussions: turned off for this course"],
  };
}

function serveCourse(f: Fixture, lecture: string, etag: string): void {
  f.site.route("/files/1/download", { status: 200, headers: { "Content-Type": "application/pdf", ETag: etag }, body: testPdf(lecture) });
  f.site.route("/files/2/download", ok("text/plain", "x"));
  f.site.route("/files/3/download", ok("text/plain", "y"));
  f.site.route("/files/5/download", ok("application/octet-stream", Buffer.alloc(3000, 7)));
  f.site.route("/files/6/download", { status: 302, headers: { Location: j(f.e, "/storage/6").href }, body: Buffer.alloc(0) });
  f.web.route("/storage/6", ok("application/pdf", testPdf("Stored on another host")));
  f.web.route(
    "/book",
    ok("text/html", '<html><head><title>Calculus Volume 1</title></head><body><a href="/about">About</a><a href="/book/download.pdf">Download PDF</a></body></html>'),
  );
  f.web.route("/book/download.pdf", ok("application/pdf", testPdf("Calculus textbook text")));
  f.web.route("/blog", ok("text/html; charset=utf-8", "<title>Study Tips Blog</title><p>tips</p>"));
  f.web.route("/notes.pdf", ok("application/pdf", testPdf("Lecture notes")));
  f.web.route("/locked.pdf", { status: 403, headers: {}, body: Buffer.from("no") });
}

const course = (): Course => ({ id: "1", name: "Calculus I", code: "M211", term: "Fall 2026", current: true });
const read = (p: string) => fs.readFileSync(p, "utf8");
const opts = (over: Partial<Options> = {}): Options => ({ ...defaultOptions(), ...over });
const none = () => {};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ino = (p: string) => fs.statSync(p).ino;
const ls = (p: string) => fs.readdirSync(p).sort();

describe("importer", () => {
  it("a course is imported and re-imported with only what changed", async () => {
    const f = await fixture("e2e");
    serveCourse(f, "Derivatives lecture", '"v1"');
    const o = opts({ maxDownload: 2000, maxLinks: 80 });
    const courses = path.join(f.root, "courses");
    const steps: [Step, number, number][] = [];
    const out = await importCourse(f.session, courses, course(), content(f), undefined, [], o, (s, d, t) => steps.push([s, d, t]));
    const c = path.join(courses, "Calculus I");

    // Course files, with the session.
    expect(read(path.join(c, "files/Week 1/Lecture 1.pdf.md"))).toContain("Derivatives lecture");
    expect(read(path.join(c, "files/evil.txt"))).toBe("x");
    expect(read(path.join(c, "files/Evil (2).txt"))).toBe("y");
    expect(ls(courses)).toEqual(["Calculus I"]);
    expect(f.site.hits("/files/2/download").every((x) => x === "canvas_session=SECRET")).toBe(true);
    expect(f.site.hits("/files/4/download")).toEqual([]);
    expect(out.skipped.some((s) => s.startsWith("huge.zip: too big to download"))).toBe(true);
    expect(out.skipped.some((s) => (s.startsWith("stream.bin: ") && s.includes("too big")) || s.startsWith("stream.bin: it is bigger"))).toBe(true);
    expect(fs.existsSync(path.join(c, "files/stream.bin"))).toBe(false);
    expect(out.skipped).toContain("Discussions: turned off for this course");
    // A redirect off the site: followed, but without the session.
    expect(read(path.join(c, "files/storage.pdf.md"))).toContain("Stored on another host");
    expect(f.site.hits("/files/6/download")).toEqual(["canvas_session=SECRET"]);
    expect(f.web.hits("/storage/6")).toEqual([null]);
    // The internet never sees the session.
    expect(f.web.log.every(([, ck]) => ck === null)).toBe(true);

    // Links rewritten.
    const syl = read(path.join(c, "syllabus.md"));
    expect(syl).toContain("[Lecture 1](files/Week%201/Lecture%201.pdf)");
    expect(syl).toContain("[the intro](pages/Intro.md)");
    // Anchors now follow the written headings (due-date order, one_line titles, the file's own
    // title counted) instead of Rust's raw site-order titles; no title here repeats, so the
    // expected anchors are the same as Rust's.
    expect(syl).toContain("[Problem Set 1](assignments.md#problem-set-1)");
    expect(syl).toContain(`[this blog](${j(f.e, "/blog").href})`);
    expect(syl).not.toContain("steal");
    expect(read(path.join(c, "pages/Intro.md"))).toContain("[the slides](../files/Week%201/Lecture%201.pdf)");

    // The textbook: its page → its PDF (one level), saved with a text copy.
    expect(read(path.join(c, "readings/Calculus Volume 1.pdf.md"))).toContain("Calculus textbook text");
    expect(read(path.join(c, "readings/notes.pdf.md"))).toContain("Lecture notes");
    expect(read(path.join(c, "links.md"))).toContain("[Study Tips Blog](");
    expect(ls(path.join(c, "readings")).some((n) => n.includes("blog") || n.endsWith(".part"))).toBe(false);

    const readme = read(path.join(c, "README.md"));
    expect(readme).toContain("M211 · Fall 2026");
    expect(readme).toContain("## Coming up");
    expect(readme).toContain("[Problem Set 1](assignments.md#problem-set-1)");
    expect(readme).not.toContain("Old quiz");
    expect(readme).toContain("**Textbook**: [Calculus Volume 1](readings/Calculus%20Volume%201.pdf)");
    expect(readme).toContain("the PDF linked from its page");
    expect(readme).toContain("ISBN 9781337613927");
    expect(readme).toContain("Publisher chapter");
    expect(readme).toContain("needs a sign-in");
    expect(readme).toContain("Reading: [Notes](readings/notes.pdf)");
    const modules = read(path.join(c, "modules.md"));
    expect(modules).toContain("- [Intro](pages/Intro.md)");
    expect(modules).toContain("- [Lecture 1.pdf](files/Week%201/Lecture%201.pdf)");
    expect(modules).toContain("- Unknown thing");
    const asg = read(path.join(c, "assignments.md"));
    expect(asg.indexOf("Problem Set 1")).toBeGreaterThan(asg.indexOf("Old quiz"));

    expect([out.files, out.downloaded, out.readings, out.links]).toEqual([4, 4, 2, 1]);
    expect(out.state.folder).toBe("Calculus I");
    expect(steps).toContainEqual(["writing", 1, 1]);
    expect(out.state.files[fileKey(j(f.s, "/files/1/download"))].etag).toBe('"v1"');

    // Re-import: the lecture changed (new ETag); nothing else did.
    const evilBefore = fs.statSync(path.join(c, "files/evil.txt")).mtimeMs;
    const webBefore = f.web.log.length;
    serveCourse(f, "Integrals lecture", '"v2"');
    // Text copies made before pages were recognised (a page left empty) are made again, without downloading.
    fs.writeFileSync(path.join(c, "files/storage.pdf.md"), "# Text of storage.pdf\n\n## Page 1\n\n\n\n## Page 2\n\nkept\n");
    fs.writeFileSync(path.join(c, "readings/notes.pdf.md"), "# Text of notes.pdf\n\n(This file has no text in it: it may be scanned pages or pictures.)\n");
    const again = await importCourse(f.session, courses, course(), content(f), out.state, [], o, none);
    expect(again.state.folder).toBe("Calculus I");
    expect(again.downloaded, JSON.stringify(again.skipped)).toBe(1);
    expect(read(path.join(c, "files/Week 1/Lecture 1.pdf.md"))).toContain("Integrals lecture");
    expect(read(path.join(c, "files/storage.pdf.md"))).toContain("Stored on another host");
    expect(read(path.join(c, "readings/notes.pdf.md"))).toContain("Lecture notes");
    expect(fs.statSync(path.join(c, "files/evil.txt")).mtimeMs).toBe(evilBefore);
    expect(fs.existsSync(path.join(c, "files/Evil (2).txt")) && !fs.existsSync(path.join(c, "files/Evil (3).txt"))).toBe(true);
    const webAfter = f.web.log.slice(webBefore).map(([p]) => p);
    expect(webAfter.some((p) => p === "/book" || p === "/notes.pdf" || p === "/blog")).toBe(false);
    expect(again.readings).toBe(2);
    // Each PDF text copy runs in a child process, which is slow to start under vitest.
  }, 180_000);

  it("a second course with the same name gets its own folder and a symlinked folder is refused", async () => {
    const f = await fixture("folders");
    const courses = path.join(f.root, "courses");
    const out = await importCourse(f.session, courses, course(), emptyContent(), undefined, ["calculus i"], opts(), none);
    expect(out.state.folder).toBe("Calculus I (M211)");
    expect(read(path.join(courses, "Calculus I (M211)/README.md"))).toContain("The course doesn’t name a textbook");
    if (process.platform !== "win32") {
      const outside = path.join(f.root, "outside");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(courses, "Linked"));
      const c = { ...course(), name: "Linked", code: null };
      await expect(importCourse(f.session, courses, c, emptyContent(), undefined, [], opts(), none)).rejects.toThrow();
      expect(fs.readdirSync(outside).length).toBe(0);
    }
  });

  it("links match files without their query or download suffix", () => {
    const u = (s: string) => new URL(s);
    expect(linkKey(u("https://x/courses/1/files/9/download?download_frd=1"))).toBe(linkKey(u("https://x/courses/1/files/9?wrap=1")));
    expect(linkKey(u("https://x/courses/1/files/9/preview#p"))).toBe("https://x/courses/1/files/9");
    expect(fileKey(u("https://x/f/9/download?verifier=a"))).toBe("https://x/f/9/download");
  });

  it("documents are told by their bytes", () => {
    const b = (s: string | number[]) => (typeof s === "string" ? Buffer.from(s, "latin1") : Buffer.from(s));
    expect(sniff(b("%PDF-1.7"), "text/html", "")).toBe("pdf");
    expect(sniff(b("<html>"), "application/pdf", "pdf")).toBeNull();
    expect(sniff(b("PK\x03\x04"), "application/epub+zip", "")).toBe("epub");
    expect(sniff(b("PK\x03\x04"), "application/zip", "zip")).toBeNull();
    expect(sniff(b([0xd0, 0xcf, 0x11, 0xe0]), "application/msword", "")).toBe("doc");
  });

  it("grades go into grades.md and the README, and a skipped line is said once", async () => {
    const f = await fixture("grades");
    const courses = path.join(f.root, "courses");
    const grades: CourseGrades = {
      current: { percent: 91.25, letter: "A-", points: 73, possible: 80 },
      groups: [{ name: "Problem sets" }],
      items: [
        gradeItem("PS 1", { group: "Problem sets", score: 9.5, possible: 10, percent: 95, graded: true, submitted: true, comments: ["Tidy."] }),
        gradeItem("Attendance", { score: 63.5, possible: 70, percent: 90.71, graded: true }),
      ],
    };
    // Seen in real data: a course with two outside tools of the same name.
    const tool = "Campus Course Policies: an outside tool, open it on the course site";
    const c0 = { ...emptyContent(), skipped: [tool, tool] };
    const out = await importCourse(f.session, courses, course(), c0, undefined, [], opts({ grades }), none);
    const c = path.join(courses, "Calculus I");
    const md = read(path.join(c, "grades.md"));
    const readme = read(path.join(c, "README.md"));
    expect(md).toContain("**Current grade: 91.25% (A-)**, 73 of 80 points");
    expect(md).toContain("## Problem sets\n\n- **PS 1**: 9.5 / 10 (95%)\n  - Teacher’s comment: Tidy.");
    expect(md).toContain("## Other\n\n- **Attendance**: 63.5 / 70 (90.71%)");
    expect(readme).toContain("**Grades**: 91.25% (A-) so far. Every grade, by group: [grades.md](grades.md).");
    expect(readme).toContain("- [grades.md](grades.md): your grades, by group");
    expect(readme.split("Campus Course Policies").length - 1).toBe(1);
    expect(out.skipped).toEqual([tool]);

    // Imported again when the grades couldn't be read: the last grades.md stays and the README still points at it.
    await importCourse(f.session, courses, course(), emptyContent(), out.state, [], opts(), none);
    expect(read(path.join(c, "grades.md"))).toContain("91.25%");
    expect(read(path.join(c, "README.md"))).toContain("**Grades**: [grades.md](grades.md) (from the last time they could be read).");
  });

  it("unchanged bytes are neither downloaded nor written, and changed ones always are", async () => {
    const f = await fixture("unchanged");
    const courses = path.join(f.root, "courses");
    const route = (body: string, etag: string | null): Route => ({ status: 200, headers: { "Content-Type": "text/plain", ...(etag ? { ETag: etag } : {}) }, body: Buffer.from(body) });
    const files = (v3: string): CourseContent => {
      const list = [file("tagged.txt", null, j(f.s, "/t/1"), null, []), file("plain.txt", null, j(f.s, "/t/2"), null, []), file("listed.txt", null, j(f.s, "/t/3"), 5, [])];
      list[2].version = v3;
      return { ...emptyContent(), syllabus: "<p>Read the notes.</p>", files: list };
    };
    f.site.route("/t/1", route("one", '"a"'));
    f.site.route("/t/2", route("same", null));
    f.site.route("/t/3", route("three", null));
    const first = await importCourse(f.session, courses, course(), files("v1"), undefined, [], opts(), none);
    expect([first.downloaded, first.unchanged], JSON.stringify(first.skipped)).toEqual([3, 0]);
    const c = path.join(courses, "Calculus I");
    const watched = ["files/tagged.txt", "files/plain.txt", "files/listed.txt", "README.md", "syllabus.md"];
    const before = watched.map((p) => ino(path.join(c, p)));
    // Someone's own notes and a file the site no longer lists: the import never touches them.
    fs.writeFileSync(path.join(c, "my notes.md"), "mine");
    fs.writeFileSync(path.join(c, "files/old handout.txt"), "kept");

    // Again, nothing changed on the site.
    const hits = f.site.cond.length;
    const again = await importCourse(f.session, courses, course(), files("v1"), first.state, [], opts(), none);
    expect([again.downloaded, again.unchanged, again.files], JSON.stringify(again.skipped)).toEqual([0, 3, 3]);
    // t/1 conditional (304), t/2 read and hashed, t/3 not asked at all.
    expect(f.site.cond.slice(hits)).toEqual([
      ["/t/1", '"a"'],
      ["/t/2", null],
    ]);
    expect(watched.map((p) => ino(path.join(c, p)))).toEqual(before);
    expect(again.state.files[fileKey(j(f.s, "/t/2"))].sha256).toBe(sha("same"));

    // Changed: a new ETag and body; the same size but different bytes and no validators;
    // a new listing version with the very same bytes (read, compared, not written).
    f.site.route("/t/1", route("two", '"b"'));
    f.site.route("/t/2", route("SAME", null));
    const third = await importCourse(f.session, courses, course(), files("v2"), again.state, [], opts(), none);
    expect([third.downloaded, third.unchanged], JSON.stringify(third.skipped)).toEqual([2, 1]);
    expect(read(path.join(c, "files/tagged.txt"))).toBe("two");
    expect(read(path.join(c, "files/plain.txt"))).toBe("SAME");
    expect(ino(path.join(c, "files/listed.txt"))).toBe(before[2]);
    expect(third.state.files[fileKey(j(f.s, "/t/3"))].version).toBe("v2");
    expect(read(path.join(c, "my notes.md"))).toBe("mine");
    expect(read(path.join(c, "files/old handout.txt"))).toBe("kept");
    expect(ls(courses)).toEqual(["Calculus I"]);
  });
});

function downloaded(got: Got): FileRec {
  if (got.kind === "written") return got.rec;
  if (got.kind === "same") throw new Error("expected the source to be repaired, but it was accepted as unchanged");
  if (got.kind === "skipped") throw new Error(`the source was skipped: ${got.why}`);
  throw new Error("the download was cancelled");
}

describe("one course file", () => {
  it("a corrupted source is repaired despite the same listing version", async () => {
    const f = await fixture("corrupt-version");
    f.site.route("/source", ok("text/plain", "source"));
    const remote = file("source.txt", null, j(f.s, "/source"), 6, []);
    remote.version = "v1";
    const rel = "files/source.txt";
    const old = downloaded(await fetchFile(f.session, f.root, remote, rel, undefined, opts()));
    const dest = path.join(f.root, rel);
    const before = ino(dest);
    // A verified copy still takes the listing's no-request, no-write shortcut.
    expect((await fetchFile(f.session, f.root, remote, rel, old, opts())).kind).toBe("same");
    expect(f.site.hits("/source").length).toBe(1);
    expect(ino(dest)).toBe(before);
    // Local changes can have exactly the same length and unchanged listing metadata.
    fs.writeFileSync(dest, "broken");
    const repaired = downloaded(await fetchFile(f.session, f.root, remote, rel, old, opts()));
    expect(read(dest)).toBe("source");
    expect(repaired.sha256).toBe(sha("source"));
    expect(f.site.hits("/source").length).toBe(2);
  });

  it("corrupted sources are fetched without either HTTP validator", async () => {
    for (const [tag, etag, modified] of [
      ["etag", true, false],
      ["modified", false, true],
      ["both", true, true],
    ] as const) {
      const f = await fixture(`corrupt-${tag}`);
      const headers: Record<string, string> = { "Content-Type": "text/plain" };
      if (etag) headers.ETag = '"v1"';
      if (modified) headers["Last-Modified"] = "Wed, 04 Nov 2026 12:00:00 GMT";
      f.site.route("/source", { status: 200, headers, body: Buffer.from("source") });
      const remote = file("source.txt", null, j(f.s, "/source"), 6, []);
      const rel = "files/source.txt";
      const old = downloaded(await fetchFile(f.session, f.root, remote, rel, undefined, opts()));
      // This server would return 304 if the stale validators were sent.
      expect((await fetchFile(f.session, f.root, remote, rel, old, opts())).kind).toBe("same");
      expect(f.site.cond[1][1] !== null).toBe(etag);
      expect(f.site.modifiedCond[1][1] !== null).toBe(modified);
      fs.writeFileSync(path.join(f.root, rel), "broken");
      const repaired = downloaded(await fetchFile(f.session, f.root, remote, rel, old, opts()));
      expect(read(path.join(f.root, rel)), tag).toBe("source");
      expect(repaired.sha256).toBe(old.sha256);
      expect(f.site.cond[2][1], `repair must not send If-None-Match (${tag})`).toBeNull();
      expect(f.site.modifiedCond[2][1], `repair must not send If-Modified-Since (${tag})`).toBeNull();
    }
  });

  it("a missing source is restored without HTTP validators", async () => {
    const f = await fixture("missing-source");
    f.site.route("/source", { status: 200, headers: { "Content-Type": "text/plain", ETag: '"v1"' }, body: Buffer.from("source") });
    const remote = file("source.txt", null, j(f.s, "/source"), 6, []);
    remote.version = "v1";
    const rel = "files/source.txt";
    const old = downloaded(await fetchFile(f.session, f.root, remote, rel, undefined, opts()));
    fs.rmSync(path.join(f.root, rel));
    const repaired = downloaded(await fetchFile(f.session, f.root, remote, rel, old, opts()));
    expect(read(path.join(f.root, rel))).toBe("source");
    expect(repaired.sha256).toBe(old.sha256);
    expect(f.site.cond[1][1]).toBeNull();
  });

  it("legacy source digests are established from a fresh download", async () => {
    const f = await fixture("legacy-source");
    f.site.route("/source", { status: 200, headers: { "Content-Type": "text/plain", ETag: '"v1"' }, body: Buffer.from("source") });
    const remote = file("source.txt", null, j(f.s, "/source"), 6, []);
    remote.version = "v1";
    const rel = "files/source.txt";
    const legacy = { ...downloaded(await fetchFile(f.session, f.root, remote, rel, undefined, opts())) };
    delete legacy.sha256;
    const before = ino(path.join(f.root, rel));
    const got = await fetchFile(f.session, f.root, remote, rel, legacy, opts());
    if (got.kind !== "same") throw new Error("an equal legacy source should be verified without being rewritten");
    const verified = got.rec;
    expect(verified.sha256).toBe(sha("source"));
    expect(f.site.hits("/source").length).toBe(2);
    expect(ino(path.join(f.root, rel))).toBe(before);
    fs.writeFileSync(path.join(f.root, rel), "broken");
    const repaired = downloaded(await fetchFile(f.session, f.root, remote, rel, legacy, opts()));
    expect(read(path.join(f.root, rel))).toBe("source");
    expect(repaired.sha256).toBe(verified.sha256);
    expect(f.site.cond.every(([, v]) => v === null)).toBe(true);
  });
});

// ---- Canvas adapter + importer -------------------------------------------------

const CANVAS_FIX = path.join(import.meta.dirname, "adapters", "fixtures", "canvas");
const canvasFixture = (name: string, base: string) => fs.readFileSync(path.join(CANVAS_FIX, `${name}.json`), "utf8").replaceAll("{BASE}", base);

type Answer = { status: number; ctype: string; headers?: Record<string, string>; body: string | Buffer };

/** A small fake site answering `route(url, base)` and logging each request's Cookie header and target. */
async function fakeSite(route: (u: URL, base: string) => Answer): Promise<{ base: string; seen: { target: string; cookie: string | null }[] }> {
  const seen: { target: string; cookie: string | null }[] = [];
  let base = "";
  const server = http.createServer((req, res) => {
    const target = req.url ?? "/";
    seen.push({ target, cookie: req.headers.cookie ?? null });
    const a = route(new URL(base + target), base);
    const body = typeof a.body === "string" ? Buffer.from(a.body) : a.body;
    res.writeHead(a.status, { "content-type": a.ctype, connection: "close", "content-length": String(body.length), ...(a.headers ?? {}) });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  extraClose.push(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  return { base, seen };
}

const jsonA = (body: string): Answer => ({ status: 200, ctype: "application/json; charset=utf-8", body });
const notFound: Answer = { status: 404, ctype: "application/json; charset=utf-8", body: "{}" };

describe("canvas course end to end", () => {
  it("a canvas course imported end to end", async () => {
    allowLoopbackForTests(true);
    const PDF = "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
    // The publisher's copy is a real PDF, so the agent gets its words.
    const book = testPdf("Chapter 1. Arrays: a contiguous block of memory.");
    const books = await fakeSite(() => ({ status: 200, ctype: "application/pdf", body: book }));
    const site = await fakeSite((u, b) => {
      switch (u.pathname) {
        case "/api/v1/users/self":
          return jsonA('{"id":42,"name":"Sam Student"}');
        case "/api/v1/courses/1001":
          return jsonA(canvasFixture("course", b).replaceAll("https://open.example.org", books.base));
        case "/api/v1/courses/1001/tabs":
          return jsonA(canvasFixture("tabs", b));
        case "/api/v1/courses/1001/folders":
          return jsonA(canvasFixture("folders", b));
        case "/api/v1/courses/1001/files":
          return jsonA(canvasFixture("files", b));
        case "/api/v1/courses/1001/files/5009":
          return jsonA(canvasFixture("file_5009", b));
        case "/api/v1/courses/1001/pages/reading-guide":
          return jsonA(canvasFixture("page_reading_guide", b));
        case "/api/v1/courses/1001/assignments":
          return jsonA(canvasFixture("assignments", b));
        case "/api/v1/courses/1001/discussion_topics":
          return jsonA(canvasFixture("announcements", b));
        case "/api/v1/courses/1001/modules":
          return jsonA(canvasFixture("modules", b));
        case "/api/v1/courses/1001/modules/2/items":
          return jsonA(canvasFixture("module_2_items", b));
        default:
          return u.pathname.endsWith("/download") ? { status: 200, ctype: "application/pdf", body: PDF } : notFound;
      }
    });
    const s = new Session(Site.forTest("canvas", site.base), {
      cookies: [
        { name: "_normandy_session", value: "sess123" },
        { name: "log_session_id", value: "abc" },
      ],
      csrf: "tok+en==",
    });
    const c = await canvas.content(s, "1001");
    const crs: Course = { id: "1001", name: "C343 Data Structures", code: "C343", term: "Fall 2026", current: true };
    const tmp = tempRoot("canvas-e2e");
    const out = await importCourse(s, tmp, crs, c, undefined, [], opts(), none);
    const dir = path.join(tmp, fs.readdirSync(tmp)[0]);
    const rd = (p: string) => read(path.join(dir, p));
    const syllabus = rd("syllabus.md");
    const readme = rd("README.md");
    expect(out.files >= 3 && out.readings >= 1, JSON.stringify(out)).toBe(true);
    expect(fs.statSync(path.join(dir, "files/Lectures/Week 1/Lecture 1 - Arrays.pdf")).isFile()).toBe(true);
    expect(books.seen.some((h) => h.cookie?.includes("sess123"))).toBe(false);
    expect(syllabus).not.toContain(site.base);
    expect(fs.readdirSync(path.join(dir, "readings")).length).toBeGreaterThanOrEqual(1);
    expect(readme).toContain("Textbooks");
    expect(readme).toContain("readings/");
    expect(syllabus).toContain("](readings/ods-java.pdf)");
    expect(readme.split("**Textbook**").length - 1).toBe(1);
    expect(readme).toContain("ISBN 9781927356388");
    expect(rd("readings/ods-java.pdf.md")).toContain("contiguous block of memory");
    expect(readme).toContain("Text copy: [readings/ods-java.pdf.md]");
    expect(fs.existsSync(path.join(dir, "files/schedule.pdf.md"))).toBe(false);
    expect(readme).not.toContain("schedule.pdf.md");
  });

  it("350 module files are imported, then re-imported without a single file request", async () => {
    const site = await fakeSite((u) => {
      const p = u.pathname;
      if (p === "/api/v1/courses/1001") return jsonA(JSON.stringify({ syllabus_body: "" }));
      if (p === "/api/v1/courses/1001/tabs") return jsonA('[{"id":"modules"},{"id":"syllabus"}]');
      if (p === "/api/v1/courses/1001/folders") return jsonA("[]");
      if (p === "/api/v1/courses/1001/modules") {
        const ids = [...Array.from({ length: 350 }, (_, i) => i + 1), ...Array.from({ length: 10 }, (_, i) => i + 1)];
        return jsonA(JSON.stringify([{ name: "All readings", items: ids.map((id) => ({ type: "File", content_id: id, title: `File${id}` })) }]));
      }
      if (p.startsWith("/courses/1001/files/") && p.endsWith("/download")) return { status: 200, ctype: "text/plain", body: "0123456789" };
      if (p.startsWith("/api/v1/courses/1001/files/")) {
        const id = Number(p.split("/").pop());
        return jsonA(JSON.stringify({ id, display_name: `file${id}.txt`, size: 10, updated_at: "2026-11-01T00:00:00Z" }));
      }
      return { status: 404, ctype: "application/json", body: '{"errors":[{"message":"no"}]}' };
    });
    const s = new Session(Site.forTest("canvas", site.base), { cookies: [], csrf: null });
    const c = await canvas.content(s, "1001");
    expect(c.files.length).toBe(350);
    const root = tempRoot("many-module-files");
    const crs: Course = { id: "1001", name: "All module files", code: null, term: null, current: true };
    const imported = await importCourse(s, root, crs, c, undefined, [], opts(), none);
    expect(imported.downloaded).toBe(350);
    expect(Object.keys(imported.state.files).length).toBe(350);
    expect(imported.state.partial).toBeFalsy();
    const one = path.join(root, imported.state.folder, Object.values(imported.state.files)[0].path);
    const modified = fs.statSync(one).mtimeMs;
    const fileGets = () => site.seen.filter((r) => r.target.startsWith("/courses/1001/files/")).length;
    const before = fileGets();
    const again = await importCourse(s, root, crs, c, imported.state, [], opts(), none);
    expect(again.downloaded).toBe(0);
    expect(again.unchanged).toBe(350);
    expect(Object.keys(again.state.files).length).toBe(350);
    expect(fs.statSync(one).mtimeMs).toBe(modified);
    expect(fileGets()).toBe(before);
  }, 60_000);
});
