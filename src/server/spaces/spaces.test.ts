import { canSymlinkFiles, symlink } from "../../../tests/fs.ts";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { ensureVault, spaceDir, vaultRoot } from "../core/vault.ts";
import {
  createSpace,
  defaultHue,
  defaultName,
  getSpace,
  listSpaces,
  readSpaceMeta,
  slug,
  touchAt,
  touchSpace,
  updateSpace,
  updateSpaceMeta,
  type SpaceView,
} from "./meta.ts";

const env = tempHome();
afterAll(() => env.cleanup());

const root = () => vaultRoot();
const sp = (...p: string[]) => path.join(root(), "spaces", ...p);
const ids = (v: SpaceView[]) => v.map((s) => s.id);

beforeEach(() => {
  fs.rmSync(root(), { recursive: true, force: true });
  ensureVault();
});

const plain = (id: string, name: string, hue: number): SpaceView => ({ id, name, description: "", hue, educationEnabled: false, lastUsed: null });

describe("spaces", () => {
  it("defaults for a fresh vault", () => {
    expect(listSpaces()).toEqual([plain("school", "School", 240), plain("work", "Work", 50)]);
  });

  it("a folder added by hand appears sorted by name", () => {
    fs.mkdirSync(sp("side-project_2"));
    fs.mkdirSync(sp("art"));
    const spaces = listSpaces();
    expect(ids(spaces)).toEqual(["art", "school", "side-project_2", "work"]);
    expect(spaces[2]!.name).toBe("Side project 2");
    expect(spaces[2]!.hue).toBe(defaultHue("side-project_2"));
  });

  it("listing never writes space.json (fixed Rust bug)", () => {
    listSpaces();
    expect(fs.existsSync(sp("school", ".phaethon"))).toBe(false);
    fs.mkdirSync(sp("work/.phaethon"), { recursive: true });
    fs.writeFileSync(sp("work/.phaethon/space.json"), `{"name":"Job"}`);
    listSpaces();
    expect(fs.readFileSync(sp("work/.phaethon/space.json"), "utf8")).toBe(`{"name":"Job"}`);
  });

  it("education is opt-in, and legacy study detection is saved once the space is used", () => {
    const fresh = createSpace("School notes");
    expect(fresh.educationEnabled).toBe(false);
    expect(updateSpace(fresh.id, { educationEnabled: true }).educationEnabled).toBe(true);
    expect(getSpace(fresh.id).educationEnabled).toBe(true);
    const dir = sp("work/study/quizzes");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Algebra.json"), "{}");
    expect(getSpace("work").educationEnabled).toBe(true);
    touchSpace("work");
    fs.rmSync(path.join(dir, "Algebra.json"));
    expect(getSpace("work").educationEnabled).toBe(true);
    expect(updateSpace("work", { educationEnabled: false }).educationEnabled).toBe(false);
    // Plan files count when they hold more than an empty value.
    fs.mkdirSync(sp("school/study"), { recursive: true });
    fs.writeFileSync(sp("school/study/exams.json"), "[]");
    expect(getSpace("school").educationEnabled).toBe(false);
    fs.writeFileSync(sp("school/study/exams.json"), `[{"x":1}]`);
    expect(getSpace("school").educationEnabled).toBe(true);
  });

  it("education migration never overwrites unreadable metadata", () => {
    fs.mkdirSync(sp("work/.phaethon"), { recursive: true });
    fs.writeFileSync(sp("work/.phaethon/space.json"), "{ broken");
    expect(getSpace("work").educationEnabled).toBe(false);
    touchSpace("work");
    expect(fs.readFileSync(sp("work/.phaethon/space.json"), "utf8")).toBe("{ broken");
  });

  it("invalid entries are skipped", () => {
    fs.mkdirSync(sp("Capitals"));
    fs.mkdirSync(sp(".hidden"));
    fs.mkdirSync(sp("has space"));
    fs.writeFileSync(sp("notes.md"), "a file, not a space");
    symlink(path.join(root(), "memory"), sp("sneaky"));
    symlink(sp("school"), sp("alias"));
    symlink("/", sp("rootlink"));
    expect(ids(listSpaces())).toEqual(["school", "work"]);
  });

  it("no spaces folder means no spaces", () => {
    fs.rmSync(sp(), { recursive: true });
    expect(listSpaces()).toEqual([]);
  });

  it("metadata is read and bad fields are ignored", () => {
    const state = sp("school/.phaethon");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "space.json"), `{"name":"  Uni  ","description":"Lectures","hue":300.4,"future":true}`);
    const school = listSpaces().find((s) => s.id === "school")!;
    expect([school.name, school.description, school.hue]).toEqual(["Uni", "Lectures", 300]);
    for (const bad of [
      { name: "", description: 5, hue: 361 },
      { name: "x".repeat(61), description: "d".repeat(161), hue: -1 },
      { name: "Two\nlines", description: "tab\there", hue: "250" },
      { name: null, hue: null },
      ["not", "an", "object"],
    ]) {
      fs.writeFileSync(path.join(state, "space.json"), JSON.stringify(bad));
      expect(getSpace("school"), JSON.stringify(bad)).toEqual(plain("school", "School", 240));
    }
    fs.writeFileSync(path.join(state, "space.json"), "{ not json");
    expect(getSpace("school").name).toBe("School");
  });

  it.skipIf(!canSymlinkFiles)("metadata symlinks are not followed", () => {
    fs.writeFileSync(path.join(root(), "outside.json"), `{"name":"Leaked"}`);
    const state = sp("school/.phaethon");
    fs.mkdirSync(state, { recursive: true });
    symlink(path.join(root(), "outside.json"), path.join(state, "space.json"));
    expect(getSpace("school").name).toBe("School");
    expect(() => updateSpace("school", { name: "New" })).toThrow();
    expect(fs.readFileSync(path.join(root(), "outside.json"), "utf8")).toContain("Leaked");
    fs.mkdirSync(path.join(root(), "elsewhere"));
    symlink(path.join(root(), "elsewhere"), sp("work/.phaethon"));
    expect(() => updateSpace("work", { name: "New" })).toThrow();
    expect(fs.existsSync(path.join(root(), "elsewhere/space.json"))).toBe(false);
  });

  it("create derives a unique id and saves metadata", () => {
    const a = createSpace("  Side Project! ", "Weekend things", 130);
    expect(a).toEqual({ id: "side-project", name: "Side Project!", description: "Weekend things", hue: 130, educationEnabled: false, lastUsed: null });
    const b = createSpace("side project");
    expect(b.id).toBe("side-project-2");
    expect(b.hue).toBe(defaultHue("side-project-2"));
    expect(createSpace("Side—Project").id).toBe("side-project-3");
    fs.writeFileSync(sp("home"), "");
    expect(createSpace("Home").id).toBe("home-2");
    expect(createSpace("School").id).toBe("school-2");
    expect(createSpace("日本語").id).toBe("space");
    expect(createSpace("..").id).toBe("space-2");
    expect(createSpace("a".repeat(60)).id.length).toBe(48);
    expect(listSpaces()).toContainEqual(a);
    const saved = JSON.parse(fs.readFileSync(sp("side-project/.phaethon/space.json"), "utf8"));
    expect(saved).toEqual({ name: "Side Project!", description: "Weekend things", hue: 130, educationEnabled: false });
    expect(fs.readFileSync(sp("side-project/.phaethon/space.json"), "utf8").endsWith("}\n")).toBe(true);
  });

  it("create refuses bad input and creates nothing", () => {
    const cases: [string, string | null, number | null][] = [
      ["", null, null],
      ["   ", null, null],
      ["x".repeat(61), null, null],
      ["Two\nlines", null, null],
      ["Ok", "d".repeat(161), null],
      ["Ok", null, -1],
      ["Ok", null, 360.5],
      ["Ok", null, NaN],
    ];
    for (const [n, d, h] of cases) expect(() => createSpace(n, d, h), n).toThrow();
    expect(ids(listSpaces())).toEqual(["school", "work"]);
    expect(() => createSpace("")).toThrow("A space needs a name.");
  });

  it("update changes only what is given and keeps unknown fields", () => {
    const state = sp("work/.phaethon");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, "space.json"), `{"name":"Work","future":{"x":1}}`);
    fs.writeFileSync(path.join(state, "session"), "kept");
    let w = updateSpace("work", { name: "Job" });
    expect([w.id, w.name, w.hue]).toEqual(["work", "Job", 50]);
    w = updateSpace("work", { description: "Meetings", hue: 200 });
    expect([w.name, w.description, w.hue]).toEqual(["Job", "Meetings", 200]);
    expect(updateSpace("work", { description: "" }).description).toBe("");
    const saved = JSON.parse(fs.readFileSync(path.join(state, "space.json"), "utf8"));
    expect(saved).toEqual({ name: "Job", description: "", hue: 200, future: { x: 1 } });
    expect(fs.existsSync(path.join(state, "space.json.tmp"))).toBe(false);
    expect(fs.readFileSync(path.join(state, "session"), "utf8")).toBe("kept");
    expect(fs.existsSync(sp("job"))).toBe(false);
    expect(updateSpace("school", { name: "Uni" }).name).toBe("Uni");
  });

  it("update refuses bad input and unknown spaces, and never overwrites a broken file", () => {
    expect(() => updateSpace("work", { name: " " })).toThrow();
    expect(() => updateSpace("work", { description: "d".repeat(161) })).toThrow();
    expect(() => updateSpace("work", { hue: 400 })).toThrow();
    for (const id of ["nope", "../memory", "", "School", ".phaethon", "work/../school"]) expect(() => updateSpace(id, { name: "X" }), id).toThrow();
    expect(fs.existsSync(path.join(root(), "memory/.phaethon"))).toBe(false);
    fs.mkdirSync(sp("work/.phaethon"), { recursive: true });
    fs.writeFileSync(sp("work/.phaethon/space.json"), "{ broken");
    expect(() => updateSpace("work", { name: "X" })).toThrow("can’t be read");
    expect(fs.readFileSync(sp("work/.phaethon/space.json"), "utf8")).toBe("{ broken");
  });

  it.skipIf(!canSymlinkFiles)("lists the most recently used first", () => {
    createSpace("Art");
    createSpace("Home");
    expect(ids(listSpaces())).toEqual(["art", "home", "school", "work"]);
    const dir = (id: string) => sp(id);
    touchAt(dir("work"), 1000);
    touchAt(dir("home"), 3000);
    touchAt(dir("school"), 2000);
    expect(ids(listSpaces())).toEqual(["home", "school", "work", "art"]);
    touchSpace("art");
    const listed = listSpaces();
    expect(ids(listed)).toEqual(["art", "home", "school", "work"]);
    expect(listed[0]!.lastUsed!).toBeGreaterThan(3000);
    expect(listed[1]!.lastUsed).toBe(3000);
    expect(fs.readFileSync(path.join(dir("work"), ".phaethon/last-used"), "utf8")).toBe("1000\n");
    fs.writeFileSync(path.join(dir("work"), ".phaethon/last-used"), "18446744073709551615");
    expect(getSpace("work").lastUsed!).toBeLessThanOrEqual(Date.now());
    for (const junk of ["", "soon", "-5", "1.5"]) {
      fs.writeFileSync(path.join(dir("work"), ".phaethon/last-used"), junk);
      expect(getSpace("work").lastUsed, junk).toBeNull();
    }
    fs.writeFileSync(path.join(root(), "outside"), "9999");
    fs.rmSync(path.join(dir("work"), ".phaethon/last-used"));
    symlink(path.join(root(), "outside"), path.join(dir("work"), ".phaethon/last-used"));
    expect(getSpace("work").lastUsed).toBeNull();
    expect(() => touchSpace("work")).toThrow("This space’s last use couldn’t be saved");
    expect(fs.readFileSync(path.join(root(), "outside"), "utf8")).toBe("9999");
    for (const bad of ["nope", "../memory", "", "School"]) expect(() => touchSpace(bad), bad).toThrow();
  });

  it("touch leaves space.json alone once education is saved", () => {
    updateSpace("work", { educationEnabled: false });
    const before = fs.readFileSync(sp("work/.phaethon/space.json"), "utf8");
    touchSpace("work");
    expect(fs.readFileSync(sp("work/.phaethon/space.json"), "utf8")).toBe(before);
  });

  it("slugs and names", () => {
    expect(slug("School")).toBe("school");
    expect(slug("  My  Big -- Plan! 2026 ")).toBe("my-big-plan-2026");
    expect(slug("Café")).toBe("caf");
    expect(slug("!!!")).toBe("space");
    expect(slug("Ab".repeat(40)).length).toBeLessThanOrEqual(48);
    expect(defaultName("side-project_2")).toBe("Side project 2");
    expect(defaultName("2026")).toBe("2026");
  });

  it("a saved hue outlives a change of default", () => {
    for (const [id, hue] of [["school", 250], ["work", 55]] as const) {
      fs.mkdirSync(sp(id, ".phaethon"), { recursive: true });
      fs.writeFileSync(sp(id, ".phaethon/space.json"), `{"hue":${hue}}`);
    }
    expect(listSpaces().map((s) => s.hue)).toEqual([250, 55]);
  });

  it("default hues are stable and spread", () => {
    expect(defaultHue("school")).toBe(240);
    expect(defaultHue("work")).toBe(50);
    expect(defaultHue("garden")).toBe(defaultHue("garden"));
    const hues = ["home", "garden", "music", "health", "travel", "money"].map(defaultHue);
    expect(hues.every((h) => h < 360)).toBe(true);
    expect(new Set(hues).size).toBeGreaterThanOrEqual(5);
  });
});

describe("space meta for other modules", () => {
  it("reads validated per-space fields and patches without losing others", () => {
    fs.mkdirSync(sp("school/.phaethon"), { recursive: true });
    fs.writeFileSync(
      sp("school/.phaethon/space.json"),
      JSON.stringify({ name: "Uni", model: "openai:gpt-5", cliModels: { codex: " gpt-6 ", claude: "--dangerously-skip" }, tutorMode: "quiz", future: 1 }),
    );
    const m = readSpaceMeta("school");
    expect(m.name).toBe("Uni");
    expect(m.model).toBe("openai:gpt-5");
    expect(m.cliModels).toEqual({ codex: "gpt-6" });
    expect(m.tutorMode).toBe("quiz");
    const after = updateSpaceMeta("school", { tutorMode: null, model: "claude-haiku-5-5" });
    expect(after.tutorMode).toBeUndefined();
    expect(after.raw).toEqual({ name: "Uni", model: "claude-haiku-5-5", cliModels: { codex: " gpt-6 ", claude: "--dangerously-skip" }, future: 1 });
    fs.writeFileSync(sp("school/.phaethon/space.json"), "[1]");
    expect(() => updateSpaceMeta("school", { model: "x" }, { unreadable: "the model wasn’t changed" })).toThrow(
      `This space’s settings file can’t be read, so the model wasn’t changed. Fix or delete ${path.join(spaceDir("school"), ".phaethon/space.json")}.`,
    );
  });
});
