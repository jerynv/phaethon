import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { vaultRoot } from "../core/vault.ts";
import { ALL_PARTS, visible } from "./access.ts";
import { run, type Keys, type Report } from "./migrate.ts";
import { markSignedIn } from "./service.ts";
import { load, loadGrades, save, saveGrades, type Conn } from "./store.ts";

const home = tempHome("phaethon-lms-migrate-");
afterAll(() => home.cleanup());

/** A keychain in memory: account → secret, and every call counted. */
class Fake implements Keys {
  entries = new Map<string, string>();
  calls = 0;
  failVaultSet = false;
  failSpaceGet = false;
  spaceGet(space: string, c: string): string | null {
    this.calls++;
    if (this.failSpaceGet) throw new Error("Unable to obtain authorization for this operation.");
    return this.entries.get(`space/${space}/${c}`) ?? null;
  }
  spaceClear(space: string, c: string): void {
    this.calls++;
    this.entries.delete(`space/${space}/${c}`);
  }
  vaultGet(c: string): string | null {
    this.calls++;
    return this.entries.get(`vault/${c}`) ?? null;
  }
  vaultSet(c: string, secret: string): void {
    this.calls++;
    if (this.failVaultSet) throw new Error("keychain locked");
    this.entries.set(`vault/${c}`, secret);
  }
}

const IU = "canvas-iu-instructure-com";
const SECRET = '{"cookies":[{"name":"canvas_session","value":"s3cr3t"}],"csrf":"t"}';
const FOLDERS: [string, string][] = [
  ["2411651", "CSCI-C 241 Fall 2026 (All Sections)"],
  ["2411519", "FA26- INTRO ARTIFICIAL INTELLIGENCE- 1382"],
  ["2411657", "FA26- SYSTEM PROG WITH C AND UNIX- 11310"],
  ["2416319", "FA26- LINEAR ALGEBRA & APPLICATIONS- 11179"],
];

const root = () => vaultRoot();
const school = () => path.join(root(), "spaces/school");

/** The space's old record (lms.json and grades.json). */
function writeOldRecord(): void {
  const c: Conn = { id: IU, kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University", lastSync: 5, signedIn: false, courses: {} };
  for (const [id, folder] of FOLDERS) c.courses[id] = { name: folder, folder, files: {}, links: {}, due: [] };
  save(school(), { connections: [c] });
  saveGrades(school(), {
    courses: { [`${IU}/2411651`]: { connection: IU, courseId: "2411651", course: "C241", folder: "courses/CSCI-C 241 Fall 2026 (All Sections)", updated: 1, current: {}, groups: [], items: [] } },
  });
}

/** The owner's layout: four Canvas courses imported into spaces/school. */
function oldVault(): void {
  fs.rmSync(root(), { recursive: true, force: true });
  for (const s of ["school", "work"]) fs.mkdirSync(path.join(root(), "spaces", s, ".phaethon"), { recursive: true });
  for (const [, folder] of FOLDERS) {
    const c = path.join(school(), "courses", folder);
    fs.mkdirSync(path.join(c, "files/Notes"), { recursive: true });
    fs.writeFileSync(path.join(c, "README.md"), `# ${folder}\n`);
    fs.writeFileSync(path.join(c, "syllabus.md"), "Syllabus.\n");
    fs.writeFileSync(path.join(c, "files/Notes/a.pdf.md"), "Notes.\n");
  }
  writeOldRecord();
}

function keysWithOld(): Fake {
  const k = new Fake();
  k.entries.set(`space/school/${IU}`, SECRET);
  return k;
}

function checkMoved(k: Fake): void {
  expect(fs.existsSync(path.join(school(), "courses"))).toBe(false);
  expect(fs.existsSync(path.join(school(), ".phaethon/lms.json"))).toBe(false);
  expect(fs.existsSync(path.join(school(), ".phaethon/grades.json"))).toBe(false);
  const st = load(root());
  expect(st.connections.length).toBe(1);
  const c = st.connections[0];
  expect([c.id, c.schoolName, c.lastSync, c.signedIn]).toEqual([IU, "Indiana University", 5, true]);
  expect(Object.keys(c.courses).length).toBe(4);
  for (const s of Object.values(c.courses)) expect(fs.statSync(path.join(root(), "courses", s.folder, "files/Notes/a.pdf.md")).isFile()).toBe(true);
  expect(loadGrades(root()).courses[`${IU}/2411651`].folder).toBe("courses/CSCI-C 241 Fall 2026 (All Sections)");
  expect([...k.entries]).toEqual([[`vault/${IU}`, SECRET]]);
  const vis = visible("school");
  expect(vis.courses.length).toBe(4);
  expect(vis.courses.every((x) => ALL_PARTS.every((p) => x.parts.has(p)) && x.parts.size === 6)).toBe(true);
  expect(visible("work").isEmpty()).toBe(true);
}

const empty: Report = { moved: [], notes: [] };

describe("migration to the vault (ported from migrate.rs)", () => {
  beforeEach(oldVault);

  it("a fresh move, and a second run that finds nothing to do", () => {
    const k = keysWithOld();
    const r = run(k);
    expect(r.moved.length).toBe(4);
    expect(r.notes).toEqual([]);
    checkMoved(k);
    const before = fs.readFileSync(path.join(root(), ".phaethon/lms.json"), "utf8");
    expect(run(k)).toEqual(empty);
    expect(fs.readFileSync(path.join(root(), ".phaethon/lms.json"), "utf8")).toBe(before);
    checkMoved(k);
  });

  it("stopped halfway, it finishes on the next run", () => {
    const k = keysWithOld();
    run(k);
    fs.mkdirSync(path.join(school(), "courses"));
    for (const f of ["CSCI-C 241 Fall 2026 (All Sections)", "FA26- INTRO ARTIFICIAL INTELLIGENCE- 1382"]) {
      fs.renameSync(path.join(root(), "courses", f), path.join(school(), "courses", f));
    }
    writeOldRecord();
    k.entries.set(`space/school/${IU}`, SECRET);
    const r = run(k);
    expect(r.moved.length).toBe(2);
    checkMoved(k);
  });

  it("a keychain that fails keeps the old sign-in", () => {
    const k = keysWithOld();
    k.failVaultSet = true;
    const r = run(k);
    expect(r.notes.length).toBe(1);
    expect(r.notes[0]).not.toContain("s3cr3t");
    expect(k.entries.get(`space/school/${IU}`)).toBe(SECRET);
    expect(fs.existsSync(path.join(school(), ".phaethon/lms.json"))).toBe(true);
    k.failVaultSet = false;
    run(k);
    checkMoved(k);
  });

  it("an unreadable sign-in waits for the next launch", () => {
    const k = keysWithOld();
    k.failSpaceGet = true;
    const r = run(k);
    expect(r.notes.some((n) => n.includes("trying again next time"))).toBe(true);
    expect(fs.existsSync(path.join(school(), ".phaethon/lms.json"))).toBe(true);
    expect(k.entries.get(`space/school/${IU}`)).toBe(SECRET);
    k.failSpaceGet = false;
    run(k);
    checkMoved(k);
  });

  it("a sign-in left behind is picked up while a space still has its own course sites", () => {
    const k = keysWithOld();
    run(k);
    checkMoved(k);
    const secret = k.entries.get(`vault/${IU}`)!;
    k.entries.delete(`vault/${IU}`);
    k.entries.set(`space/school/${IU}`, secret);
    markSignedIn(IU, false);
    // A normal launch (no space keeps an lms.json) reads nothing from the keychain.
    k.calls = 0;
    expect(run(k)).toEqual(empty);
    expect(k.calls).toBe(0);
    // A launch that still moves a space's record also picks up the left sign-in.
    save(path.join(root(), "spaces/work"), { connections: [] });
    const r = run(k);
    expect(r.moved.some((m) => m.includes("the sign-in"))).toBe(true);
    checkMoved(k);
  });

  it("a normal launch never touches the keychain", () => {
    const k = keysWithOld();
    run(k);
    const k2 = new Fake();
    k2.failSpaceGet = true;
    markSignedIn(IU, false);
    expect(run(k2)).toEqual(empty);
    expect(k2.calls).toBe(0);
  });

  it("a name taken at the vault level gets another", () => {
    const taken = path.join(root(), "courses/CSCI-C 241 Fall 2026 (All Sections)");
    fs.mkdirSync(taken, { recursive: true });
    fs.writeFileSync(path.join(taken, "mine.md"), "someone else's");
    run(keysWithOld());
    const st = load(root());
    expect(st.connections[0].courses["2411651"].folder).toBe("CSCI-C 241 Fall 2026 (All Sections) (2)");
    expect(fs.statSync(path.join(root(), "courses/CSCI-C 241 Fall 2026 (All Sections) (2)/syllabus.md")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(taken, "mine.md"), "utf8")).toBe("someone else's");
    expect(loadGrades(root()).courses[`${IU}/2411651`].folder).toBe("courses/CSCI-C 241 Fall 2026 (All Sections) (2)");
  });

  it("a vault without course sites is left alone", () => {
    fs.rmSync(root(), { recursive: true, force: true });
    fs.mkdirSync(path.join(root(), "spaces/school/notes"), { recursive: true });
    const k = new Fake();
    expect(run(k)).toEqual(empty);
    expect(k.calls).toBe(0);
    expect(fs.existsSync(path.join(root(), ".phaethon"))).toBe(false);
    expect(fs.existsSync(path.join(root(), "courses"))).toBe(false);
  });
});
