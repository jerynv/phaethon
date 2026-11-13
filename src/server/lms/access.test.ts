import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { vaultRoot } from "../core/vault.ts";
import { ALL_PARTS, allowAll, filterText, forget, load, partOf, set, view, visible, type Part, type Seen } from "./access.ts";
import { browse, firstHeading, headings } from "./browse.ts";
import { load as loadStore, parseTime, promptIndex, save, serializeStore, type GradeBook, type Store } from "./store.ts";

const home = tempHome("phaethon-access-");
afterAll(() => home.cleanup());

const FILE = "course-access.json";
let dir = "";

function vault(): void {
  dir = vaultRoot();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const s of ["school", "work", "home"]) fs.mkdirSync(path.join(dir, "spaces", s), { recursive: true });
  const calc = path.join(dir, "courses/Calculus II");
  for (const d of ["files/Notes", "readings", "pages"]) fs.mkdirSync(path.join(calc, d), { recursive: true });
  const put = (rel: string, body: string) => fs.writeFileSync(path.join(calc, rel), body);
  put(
    "README.md",
    "# Calculus II\n\nImported from x.\n\n**Grades**: 91% (A-) so far. Every grade, by group: [grades.md](grades.md).\n\n## Coming up\n\n- Tue Oct 14 2026, 11:59 PM: [PS 4](assignments.md#ps-4)\n\n## Textbooks and readings\n\n- **Textbook**: [Stewart](readings/stewart.pdf)\n\n## In this folder\n\n- [syllabus.md](syllabus.md): the syllabus\n- [assignments.md](assignments.md): 1 assignment by due date\n- [grades.md](grades.md): your grades, by group\n\n### Files\n\n- [files/Notes/series.pdf](files/Notes/series.pdf)\n",
  );
  put("syllabus.md", "Syllabus: integrals and series. Office hours Tuesday.\n");
  put("assignments.md", "# Assignments\n\n## PS 4\n\nDue Oct 14. Series convergence.\n");
  put("announcements.md", "Quiz moved to Friday.\n");
  put("grades.md", "# Grades: Calculus II\n\n**Current grade: 91% (A-)**\n");
  put("files/Notes/series.pdf.md", "Ratio test: series converge when the limit is below one.\n");
  put("readings/stewart.pdf.md", "Stewart chapter 11 on series.\n");
  put("pages/week 1.md", "Week 1: review integrals.\n");
  put("modules.md", "Module 1: series.\n");
  fs.mkdirSync(path.join(dir, "courses/Linear Algebra"), { recursive: true });
  fs.writeFileSync(path.join(dir, "courses/Linear Algebra/syllabus.md"), "Linear algebra syllabus: eigenvalues.\n");
  const store: Store = {
    connections: [
      {
        id: "canvas-x",
        kind: "canvas",
        address: "https://x",
        signedIn: false,
        courses: {
          "1": { name: "Calculus II", folder: "Calculus II", files: {}, links: {}, due: [{ title: "PS 4", due: "2026-10-14T23:59:00Z", anchor: "ps-4" }] },
          "2": { name: "Linear Algebra", folder: "Linear Algebra", files: {}, links: {}, due: [] },
        },
      },
    ],
  };
  save(dir, store);
}

function writeFile(v: unknown): void {
  fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".phaethon", FILE), JSON.stringify(v));
}

function raw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, ".phaethon", FILE), "utf8"));
}

beforeEach(() => vault());

describe("access.rs", () => {
  it("parts of a course folder", () => {
    expect(partOf("README.md")).toBe("overview");
    expect(partOf("readme.MD")).toBe("overview");
    expect(partOf("syllabus.md")).toBe("syllabus");
    expect(partOf("Syllabus.md.")).toBe("syllabus");
    expect(partOf("assignments.md")).toBe("assignments");
    expect(partOf("announcements.md")).toBe("announcements");
    expect(partOf("grades.md")).toBe("grades");
    expect(partOf("GRADES.MD ")).toBe("grades");
    expect(partOf("grades.md/x")).toBe("grades");
    for (const f of ["files/a.pdf", "files/a.pdf.md", "readings/x.pdf", "pages/w.md", "links.md", "modules.md", "notes.txt", "README.md/x", "files/grades.md"]) expect(partOf(f), f).toBe("files");
  });

  it("the file is validated and unknown entries are kept", () => {
    writeFile({
      school: { "canvas-x/1": ["overview", "grades", "bogus", "grades"], "canvas-x/../2": ["files"], "bad key": ["files"], "canvas-x/2": "files" },
      nope: { "canvas-x/1": ["files"] },
      "../work": { "canvas-x/1": ["files"] },
      work: ["files"],
      home: { "canvas-x/2": [] },
    });
    const l = load();
    expect(l.map.size).toBe(1);
    expect([...l.map.get("school")!.get("canvas-x/1")!].sort()).toEqual(["grades", "overview"]);
    expect(l.problems.length).toBe(7);
    expect(l.problems).toContain('In “school”, “canvas-x/1”: "bogus" isn’t a part of a course, so it’s ignored.');
    expect(() => set("work", "canvas-x/2", ["syllabus"])).toThrow("course-access.json has something Phaethon doesn’t understand for “work”");
    set("home", "canvas-x/2", ["syllabus", "syllabus"]);
    expect((raw().home as Record<string, unknown>)["canvas-x/2"]).toEqual(["syllabus"]);
    expect(raw().nope).toEqual({ "canvas-x/1": ["files"] });
    set("home", "canvas-x/2", []);
    expect(raw().home).toBeUndefined();
    for (const [space, key] of [
      ["nope", "canvas-x/1"],
      ["../school", "canvas-x/1"],
      ["school", "x"],
      ["school", "a/b/c"],
      ["school", "canvas-x/1 2"],
    ]) {
      expect(() => set(space, key, ["files"]), `${space} ${key}`).toThrow();
    }
    fs.writeFileSync(path.join(dir, ".phaethon", FILE), "{ not json");
    expect(load().map.size).toBe(0);
    expect(load().problems.length).toBe(1);
    expect(() => set("school", "canvas-x/1", ["files"])).toThrow("course-access.json has a typing mistake, so Phaethon won’t change it.");
    expect(() => allowAll(["school"], ["canvas-x/1"])).toThrow();
    expect(fs.readFileSync(path.join(dir, ".phaethon", FILE), "utf8")).toBe("{ not json");
  });

  it("writes keys sorted, as serde did", () => {
    set("work", "canvas-x/2", ["files", "overview"]);
    set("school", "canvas-x/1", ["grades"]);
    expect(fs.readFileSync(path.join(dir, ".phaethon", FILE), "utf8")).toBe('{\n  "school": {\n    "canvas-x/1": [\n      "grades"\n    ]\n  },\n  "work": {\n    "canvas-x/2": [\n      "overview",\n      "files"\n    ]\n  }\n}');
  });

  it.skipIf(!canSymlinkFiles)("the file is never read or written through a link", () => {
    const outside = path.join(dir, "outside.json");
    const body = JSON.stringify({ school: { "canvas-x/1": ["files"] } });
    fs.writeFileSync(outside, body);
    fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
    symlink(outside, path.join(dir, ".phaethon", FILE));
    expect(load().map.size).toBe(0);
    expect(visible("school").isEmpty()).toBe(true);
    expect(() => set("school", "canvas-x/1", ["files"])).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe(body);
  });

  it("allowAll adds and forget removes", () => {
    set("school", "canvas-x/2", ["syllabus"]);
    allowAll(["school", "work"], ["canvas-x/1"]);
    let l = load();
    expect(l.map.get("school")!.get("canvas-x/1")!.size).toBe(6);
    expect([...l.map.get("school")!.get("canvas-x/2")!]).toEqual(["syllabus"]);
    expect(l.map.get("work")!.get("canvas-x/1")!.size).toBe(6);
    expect(() => allowAll(["nope"], ["canvas-x/1"])).toThrow("There’s no space called “nope”.");
    forget(["canvas-x/1"]);
    l = load();
    expect(l.map.has("work")).toBe(false);
    expect(l.map.get("school")!.size).toBe(1);
  });

  it("a space sees only what it was allowed", () => {
    expect(visible("school").isEmpty()).toBe(true);
    set("school", "canvas-x/1", ["overview", "files"]);
    set("school", "canvas-x/9", ["files"]);
    const vis = visible("school");
    expect(vis.courses.length).toBe(1);
    expect(vis.courses[0].state.folder).toBe("Calculus II");
    expect(visible("work").isEmpty()).toBe(true);
    const ok = (p: string) => vis.place(p, true);
    for (const good of ["courses", "courses/Calculus II", "Courses/Calculus II/README.md", "courses/Calculus II/files/Notes/series.pdf.md", "courses/Calculus II/readings/stewart.pdf.md", "courses/Calculus II/pages/week 1.md"]) ok(good);
    for (const bad of [
      "courses/Calculus II/syllabus.md",
      "courses/Calculus II/grades.md",
      "courses/Calculus II/GRADES.md",
      "courses/Calculus II/assignments.md",
      "courses/Linear Algebra/syllabus.md",
      "courses/Linear Algebra",
      "courses/calculus ii/README.md",
      "courses/Calculus%20II/README.md",
      "courses/Calculus II/missing.md",
    ]) {
      expect(() => ok(bad), bad).toThrow();
    }
    expect(() => ok("courses/Linear Algebra")).toThrow('"courses/Linear Algebra" isn’t among the courses this space can see');
    expect(() => ok("courses/Nope")).toThrow('"courses/Nope" isn’t among the courses this space can see');
    expect(() => ok("courses/Calculus II/missing.md")).toThrow('"courses/Calculus II/missing.md" does not exist');
    const seen = vis.courses[0];
    const calc = vis.dirOf(seen)!;
    expect(vis.listCourse(seen, "", calc)).toEqual(["README.md", "files/", "modules.md", "pages/", "readings/"]);
    const walked = vis.walk(seen, calc, calc, 100).map(([r]) => r);
    expect(walked).toContain("README.md");
    expect(walked.some((w) => w.includes("grades") || w.includes("syllabus"))).toBe(false);
  });

  it.skipIf(!canSymlinkFiles)("links cannot reach a part or place not allowed", () => {
    set("school", "canvas-x/1", ["files"]);
    const calc = path.join(dir, "courses/Calculus II");
    symlink(path.join(calc, "grades.md"), path.join(calc, "files/g.md"));
    symlink(path.join(dir, "courses/Linear Algebra"), path.join(calc, "files/la"));
    symlink(path.join(dir, "spaces/work"), path.join(calc, "files/work"));
    const vis = visible("school");
    for (const bad of ["courses/Calculus II/files/g.md", "courses/Calculus II/files/la/syllabus.md", "courses/Calculus II/files/work"]) {
      expect(() => vis.place(bad, true), bad).toThrow();
    }
    const seen = vis.courses[0];
    const real = vis.dirOf(seen)!;
    expect(vis.walk(seen, real, real, 100).every(([r]) => !r.endsWith("g.md"))).toBe(true);
    fs.renameSync(calc, path.join(dir, "calc-real"));
    symlink(path.join(dir, "calc-real"), calc);
    expect(() => visible("school").place("courses/Calculus II/files", true)).toThrow();
  });

  it("the readme shows only allowed parts", () => {
    set("school", "canvas-x/1", ["overview", "syllabus"]);
    let vis = visible("school");
    const text = fs.readFileSync(path.join(dir, "courses/Calculus II/README.md"), "utf8");
    const shown = filterText(vis.courses[0], "README.md", text);
    expect(shown).toContain("## Coming up");
    expect(shown).toContain("PS 4");
    expect(shown).toContain("[syllabus.md](syllabus.md)");
    for (const gone of ["**Grades**", "91%", "grades.md", "Textbooks", "Stewart", "### Files", "series.pdf", "[assignments.md](assignments.md)"]) expect(shown, gone).not.toContain(gone);
    expect(shown).not.toContain("\n\n\n");
    set("school", "canvas-x/1", [...ALL_PARTS]);
    vis = visible("school");
    expect(filterText(vis.courses[0], "README.md", text)).toBe(text);
    expect(filterText(vis.courses[0], "files/README.md", "**Grades**")).toBe("**Grades**");
  });

  it("the view for settings", () => {
    set("work", "canvas-x/2", ["syllabus"]);
    allowAll(["school"], ["canvas-x/1"]);
    const all = view(null);
    expect(all.spaces).toEqual(["home", "school", "work"]);
    expect(all.courses.map((c) => c.folder)).toEqual(["courses/Calculus II", "courses/Linear Algebra"]);
    expect(Object.keys(all.access).length).toBe(2);
    const one = view("work");
    expect(one.access).toEqual({ work: { "canvas-x/2": ["syllabus"] } });
    expect(() => view("nope")).toThrow();
    expect(JSON.parse(JSON.stringify(one.courses[0]))).toEqual({ key: "canvas-x/1", connection: "canvas-x", courseId: "1", name: "Calculus II", folder: "courses/Calculus II" });
  });
});

describe("browse.rs", () => {
  it("module navigation ignores fenced examples and keeps duplicate ordinals", () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-browse-")), "m.md");
    fs.writeFileSync(p, "# Modules\n## Algebra `$x$`\n```markdown\n## Not a module\n```\n### A detail\n## Algebra `$x$`\n");
    expect(headings(p)).toEqual([
      ["Algebra `$x$`", "algebra-x"],
      ["Algebra `$x$`", "algebra-x-1"],
    ]);
  });

  it("a utf-8 boundary after the title does not hide it", () => {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-browse-")), "t.md");
    fs.writeFileSync(p, `# Name\n${"é".repeat(5000)}`);
    expect(firstHeading(p)).toBe("Name");
  });

  it("lists only what the space may open", () => {
    const st = loadStore(dir);
    st.connections[0].courses["1"].files = { "https://x/files/1": { path: "files/Notes/series.pdf" } };
    st.connections[0].courses["1"].lastSync = 5;
    save(dir, st);
    fs.writeFileSync(path.join(dir, "courses/Calculus II/files/Notes/series.pdf"), "%PDF");
    set("school", "canvas-x/1", ["overview", "assignments", "files"]);
    const b = browse(visible("school"), "canvas-x/1");
    expect(b.updated).toBe(5);
    expect(b.entries.map((e) => [e.kind, e.title])).toEqual([
      ["overview", "Overview"],
      ["assignment", "Assignments"],
      ["assignment", "PS 4"],
      ["module", "Modules"],
      ["page", "week 1"],
      ["file", "series.pdf"],
    ]);
    const ps4 = b.entries[2];
    expect(ps4.anchor).toBe("ps-4");
    expect(ps4.headingIndex).toBe(0);
    expect(b.entries[5]).toEqual({ path: "courses/Calculus II/files/Notes/series.pdf", title: "series.pdf", kind: "file", bytes: 4, text: "courses/Calculus II/files/Notes/series.pdf.md" });
    expect(() => browse(visible("school"), "canvas-x/2")).toThrow("That course isn’t among the courses this space can see.");
  });
});

describe("store.rs", () => {
  it("lms.json round-trips in serde's layout", () => {
    const st = loadStore(dir);
    expect(serializeStore(st)).toBe(fs.readFileSync(path.join(dir, ".phaethon/lms.json"), "utf8"));
    expect(serializeStore(st)).toContain('"courses": {\n        "1": {\n          "name": "Calculus II",\n          "folder": "Calculus II",\n          "files": {},\n          "links": {},\n          "due": [');
    // Damaged and symlinked files say so.
    fs.writeFileSync(path.join(dir, ".phaethon/lms.json"), '{"connections":[{"id":"a"}]}');
    expect(() => loadStore(dir)).toThrow("This space’s course sites file is damaged (missing field `kind`). Fix or remove .phaethon/lms.json.");
    // A material block without `typed` no longer makes the whole file unreadable.
    fs.writeFileSync(
      path.join(dir, ".phaethon/lms.json"),
      JSON.stringify({ connections: [{ id: "a", kind: "canvas", address: "https://x", courses: { "1": { name: "n", folder: "n", material: { version: 2, files: [{ path: "files/a.pdf" }] } } } }] }),
    );
    expect(loadStore(dir).connections[0].courses["1"].material?.files.length).toBe(1);
  });

  it("the index lists this space's courses with what's next", () => {
    expect(promptIndex([], { courses: {} }, 0)).toBe(null);
    const state = loadStore(dir).connections[0].courses["1"];
    state.code = "M212";
    state.due = [
      { title: "Old", due: "2026-01-01T00:00:00Z", anchor: "" },
      { title: "PS 5", due: "2026-10-20T00:00:00Z", anchor: "" },
      { title: "PS 4", due: "2026-10-13T00:00:00Z", anchor: "" },
    ];
    const now = parseTime("2026-10-10T00:00:00Z")!;
    const book: GradeBook = {
      courses: { "canvas-x/1": { connection: "canvas-x", courseId: "1", course: "Calculus II", folder: "courses/Calculus II", updated: 0, current: { percent: 91, letter: "A-" }, groups: [], items: [] } },
    };
    const seen = (parts: Part[]): Seen => ({ key: "canvas-x/1", connection: "canvas-x", courseId: "1", state, parts: new Set(parts) });
    let idx = promptIndex([seen([...ALL_PARTS])], book, now)!;
    expect(idx).toContain("- Calculus II (M212): courses/Calculus II/ Next due: PS 4 (");
    expect(idx).toContain("Current grade: 91% (A-)");
    expect(idx.indexOf("PS 4")).toBeLessThan(idx.indexOf("PS 5"));
    expect(idx).not.toContain("Old");
    idx = promptIndex([seen(["syllabus", "files"])], book, now)!;
    expect(idx).toContain("- Calculus II (M212): courses/Calculus II/ (this space sees only: syllabus, files)");
    expect(idx.includes("PS 4") || idx.includes("91%")).toBe(false);
    idx = promptIndex([seen(["assignments"])], book, now)!;
    expect(idx.includes("Next due: PS 4") && !idx.includes("91%")).toBe(true);
    idx = promptIndex([seen(["grades"])], book, now)!;
    expect(!idx.includes("PS 4") && idx.includes("91%")).toBe(true);
    // Past 20 courses the index says there are more.
    idx = promptIndex(Array.from({ length: 21 }, () => seen(["files"])), book, now)!;
    expect(idx.endsWith("- …and more under courses/")).toBe(true);
  });
});
