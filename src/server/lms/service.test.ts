import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempHome } from "../../../tests/harness.ts";
import { keychainGet, keychainSet, lmsVaultAccount, resetMemoryKeychain } from "../core/secrets.ts";
import { ensureVault, vaultRoot } from "../core/vault.ts";
import { allowAll, courseKey, set as setAccess, visible } from "./access.ts";
import { account, accountFingerprint } from "./adapters/index.ts";
import { setForbiddenRetryDelaysForTests } from "./adapters/canvas.ts";
import { courseContent } from "./browse.ts";
import { sha256Hex } from "./hash.ts";
import { summarise, normalizeReport } from "./material.ts";
import {
  cancelImport,
  canvasSchools,
  chooseConnection,
  connectionId,
  connections,
  disconnect,
  finishSignIn,
  grades,
  gradesRefresh,
  importCourses,
  markSignedIn,
  rankSchools,
  refreshGradesWith,
  session,
  SIGNED_OUT,
  setSiteResolverForTests,
  type GradesEvent,
  type ImportEvent,
} from "./service.ts";
import { Session, allowLoopbackForTests } from "./session.ts";
import { load, loadAccounts, loadGrades, promptIndex, putGrades, save, saveAccounts, type Accounts, type Conn, type Store } from "./store.ts";
import { html, json, serve, stalled, status, tagged, type FakeSite, type Reply } from "./testing/fake-site.ts";
import { GRADES_HIDDEN, Site, type Credential, type Kind } from "./types.ts";

const home = tempHome("phaethon-lms-service-");
ensureVault();
setSiteResolverForTests((c) => Site.forTest(c.kind, c.address));
setForbiddenRetryDelaysForTests([]);
allowLoopbackForTests(true);

const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "adapters/fixtures/canvas", name), "utf8");
const servers: FakeSite[] = [];
async function site(route: (target: string) => Reply | Promise<Reply>): Promise<FakeSite> {
  const s = await serve((t) => route(t));
  servers.push(s);
  return s;
}

function reset(): void {
  const root = vaultRoot();
  for (const p of [".phaethon", "courses"]) fs.rmSync(path.join(root, p), { recursive: true, force: true });
  for (const s of fs.readdirSync(path.join(root, "spaces"))) fs.rmSync(path.join(root, "spaces", s), { recursive: true, force: true });
  ensureVault();
  resetMemoryKeychain();
}

beforeEach(reset);
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
afterAll(() => home.cleanup());

const conn = (id: string, kind: Kind, address: string, extra: Partial<Conn> = {}): Conn => ({ id, kind, address, signedIn: false, courses: {}, ...extra });

function canvasSession(base: string): Session {
  return new Session(Site.forTest("canvas", base), { cookies: [{ name: "_normandy_session", value: "s" }], csrf: null });
}

/** A vault with one Canvas connection (at `base`) and course 1001 imported into courses/Discrete/. */
function gradesVault(base: string): string {
  const root = vaultRoot();
  fs.mkdirSync(path.join(root, "courses/Discrete"), { recursive: true });
  fs.writeFileSync(path.join(root, "courses/Discrete/README.md"), "# Discrete\n\nImported from x on today.\n\n## Coming up\n\nNothing.\n");
  save(root, { connections: [conn("canvas-x", "canvas", base, { courses: { "1001": { name: "Discrete Structures", folder: "Discrete", files: {}, links: {}, due: [] } } })] });
  return root;
}

function recordSignIn(st: Store, acc: Accounts, s: Site, id: string, fp: string | null): void {
  if (fp !== null) acc.connections[id] = fp;
  const c = st.connections.find((x) => x.id === id);
  if (c) c.signedIn = true;
  else st.connections.push(conn(id, s.kind, s.address(), { signedIn: true }));
}

describe("service (ported from service.rs)", () => {
  it("schools best match first", () => {
    const names = [
      "Indiana Online - Parents",
      "Bethel University (Indiana)",
      "Indiana University Health, Inc.",
      "Lebanon Community School Corporation (Parent/Guardian Indiana)",
      "Indiana University",
      "Indiana State University",
    ];
    const got = rankSchools(
      names.map((name) => ({ name, address: "https://x.instructure.com" })),
      "Indiana  university",
    ).map((s) => s.name);
    expect(got[0]).toBe("Indiana University");
    expect(got[1]).toBe("Indiana University Health, Inc.");
    expect(got[got.length - 1]).toBe("Lebanon Community School Corporation (Parent/Guardian Indiana)");
  });

  it("school search through a fake endpoint: collapsed names, valid sites, no duplicates", async () => {
    const s = await site(() =>
      json([
        { name: "Indiana  University", domain: "iu.instructure.com" },
        { name: "Indiana University", domain: "iu.instructure.com " },
        { name: "Broken", domain: "http://" },
        { name: "", domain: "x.instructure.com" },
        { name: "Indiana University Health, Inc.", domain: "iuhealth.instructure.com" },
        { domain: "nameless.instructure.com" },
      ]),
    );
    const endpoint = new URL(`${s.base}/api/v1/accounts/search`);
    expect(await canvasSchools(endpoint, " i ")).toEqual([]);
    expect(s.log.length).toBe(0);
    const found = await canvasSchools(endpoint, "indiana university");
    expect(found).toEqual([
      { name: "Indiana University", address: "https://iu.instructure.com" },
      { name: "Indiana University Health, Inc.", address: "https://iuhealth.instructure.com" },
    ]);
    expect(s.log[0].target).toBe("/api/v1/accounts/search?search_term=indiana+university&per_page=50");
    expect(s.log[0].cookie).toBeUndefined();
    const bad = await site(() => status(500));
    await expect(canvasSchools(new URL(`${bad.base}/x`), "indiana")).rejects.toThrow("Couldn’t search for schools (the search answered 500).");
  });

  it("connection ids are plain and stable", () => {
    const s = Site.create("canvas", "iu.instructure.com/courses/1");
    expect(connectionId(s)).toBe("canvas-iu-instructure-com");
    expect(() => lmsVaultAccount(connectionId(s))).not.toThrow();
    expect(connectionId(Site.forTest("moodle", "http://127.0.0.1:8080"))).toBe("moodle-127-0-0-1-8080");
  });

  it("a very long host keeps every connection id within the keychain's 100 characters", () => {
    const host = `${"a".repeat(60)}.${"b".repeat(60)}.instructure.com`;
    const s = Site.create("canvas", host);
    const base = connectionId(s);
    expect(base.length).toBe(100);
    const st: Store = { connections: [] };
    const acc: Accounts = { connections: {} };
    const a = chooseConnection(st, acc, s, accountFingerprint(s, "1"));
    expect(a).toBe(base);
    recordSignIn(st, acc, s, a, accountFingerprint(s, "1"));
    const b = chooseConnection(st, acc, s, accountFingerprint(s, "2"));
    expect(b).not.toBe(a);
    expect(b.length).toBeLessThanOrEqual(100);
    expect(() => lmsVaultAccount(b)).not.toThrow();
    recordSignIn(st, acc, s, b, accountFingerprint(s, "2"));
    // Even the numbered ones (the hashed id taken too) fit.
    acc.connections[`${b}`] = "taken";
    const c = chooseConnection({ connections: [...st.connections, conn(b, "moodle", "https://elsewhere")] }, acc, s, accountFingerprint(s, "2x"));
    expect(c.length).toBeLessThanOrEqual(100);
    expect(() => lmsVaultAccount(c)).not.toThrow();
  });

  it("events have the contract's shape", () => {
    const p: ImportEvent = { type: "progress", course: "1", step: "files", done: 2, total: 5 };
    expect(JSON.parse(JSON.stringify(p))).toEqual({ type: "progress", course: "1", step: "files", done: 2, total: 5 });
    const report = normalizeReport({ version: 1, files: [{ path: "files/n.pdf", pages: 2, typed: 0, handwriting: [1, 2] }] })!;
    const material = summarise(report, () => true);
    const c: ImportEvent = { type: "course", course: "1", folder: "courses/X", files: 1, readings: 0, links: 0, skipped: [], material };
    const v = JSON.parse(JSON.stringify(c));
    expect(v.material.handwritingPages).toBe(2);
    expect(v.material.lines[0]).toBe("2 pages are handwriting or scans: read with text recognition; may contain mistakes.");
    const root = vaultRoot();
    save(root, { connections: [conn("a", "canvas", "https://x", { signedIn: true })] });
    expect(connections()).toEqual([{ id: "a", kind: "canvas", address: "https://x", signedIn: true, courses: [] }]);
    expect(JSON.stringify(connections()[0])).toBe('{"id":"a","kind":"canvas","address":"https://x","signedIn":true,"courses":[]}');
  });

  it("a grades refresh writes grades.md and grades.json, and lms_grades reads them back", async () => {
    const s = await site((t) => {
      switch (t.split("?")[0]) {
        case "/api/v1/courses/1001/enrollments":
          return json(fixture("grades_enrollments.json"));
        case "/api/v1/courses/1001":
          return json('{"id":1001,"apply_assignment_group_weights":true}');
        case "/api/v1/courses/1001/assignment_groups":
          return json(fixture("grades_groups.json"));
        case "/api/v1/courses/1001/students/submissions":
          return json(fixture("grades_submissions.json"));
        default:
          return status(404);
      }
    });
    const root = gradesVault(s.base);
    const events: GradesEvent[] = [];
    await refreshGradesWith(canvasSession(s.base), "canvas-x", () => true, (e) => events.push(e));
    expect(events[0]).toEqual({ type: "progress", course: "1001", step: "grades", done: 0, total: 1 });
    const ev = events[1];
    if (ev.type !== "course") throw new Error(JSON.stringify(events));
    const rec = ev.grades;
    expect([ev.course, rec.folder, rec.course]).toEqual(["1001", "courses/Discrete", "Discrete Structures"]);

    const md = fs.readFileSync(path.join(root, "courses/Discrete/grades.md"), "utf8");
    const lines = md.split("\n");
    expect(md.startsWith("# Grades: Discrete Structures\n")).toBe(true);
    expect(md).toContain("**Current grade: 88.42% (B+)**");
    expect(md).toContain("Final grade if nothing more is graded (work not graded counts as zero): 74.1% (C).");
    expect(md).toContain("## Homework (40% of the grade)");
    expect(md).toContain("## Exams (60% of the grade)");
    expect(md).toContain("- **Homework 1**: 9 / 10 (90%) · due ");
    expect(md).toContain("  - Teacher’s comment: Nice proof. Watch the base case.");
    expect(lines.some((l) => l.startsWith("- **Homework 2**: 7 / 10 (70%)") && l.endsWith(" · late"))).toBe(true);
    expect(lines.some((l) => l.startsWith("- **Homework 3**: 0 / 10 (0%)") && l.endsWith(" · missing"))).toBe(true);
    expect(md).toContain("- **Homework 4**: excused (doesn’t count)");
    expect(lines.some((l) => l.startsWith("- **Midterm**: not graded yet (out of 150)") && l.endsWith("handed in, not graded yet"))).toBe(true);
    expect(md).toContain("- **Quiz week 3 (paper)**: 152 / 160 (95%), A-");
    expect(md.indexOf("## Homework")).toBeLessThan(md.indexOf("**Homework 1**"));
    expect(md.indexOf("## Exams")).toBeLessThan(md.indexOf("**Midterm**"));
    const readme = fs.readFileSync(path.join(root, "courses/Discrete/README.md"), "utf8");
    expect(readme).toContain("Imported from x on today.\n\n**Grades**: 88.42% (B+) so far. Every grade, by group: [grades.md](grades.md).\n\n## Coming up");

    // lms_grades: the same numbers from disk, only for a space that may see grades.
    fs.mkdirSync(path.join(root, "spaces/s"), { recursive: true });
    setAccess("s", "canvas-x/1001", ["grades"]);
    const list = grades(visible("s"));
    expect(list).toEqual([rec]);
    const v = JSON.parse(JSON.stringify(list[0]));
    for (const k of ["connection", "courseId", "course", "folder", "updated", "current", "final", "groups", "items"]) expect(v).toHaveProperty(k);
    expect(v.current).toEqual({ percent: 88.42, letter: "B+", points: 168 });
    expect(v.items[2].missing).toBe(true);

    // Again: the README keeps one grades line.
    await refreshGradesWith(canvasSession(s.base), "canvas-x", () => true, () => {});
    expect(fs.readFileSync(path.join(root, "courses/Discrete/README.md"), "utf8").split("**Grades**").length - 1).toBe(1);
    allowAll(["s"], ["canvas-x/1001"]);
    const idx = promptIndex(visible("s").courses, loadGrades(root), 0)!;
    expect(idx).toContain("- Discrete Structures: courses/Discrete/ Current grade: 88.42% (B+) (grades.md).");
  });

  it("a grades refresh stops signed out, and a hidden course is noted", async () => {
    const out = await site(() => status(401));
    const root = gradesVault(out.base);
    await expect(refreshGradesWith(canvasSession(out.base), "canvas-x", () => true, () => {})).rejects.toThrow(SIGNED_OUT);
    expect(fs.existsSync(path.join(root, "courses/Discrete/grades.md"))).toBe(false);
    expect(loadGrades(root).courses).toEqual({});

    reset();
    const hidden = await site((t) => (t.startsWith("/api/v1/users/self") ? json('{"id":1}') : status(403)));
    gradesVault(hidden.base);
    await refreshGradesWith(canvasSession(hidden.base), "canvas-x", () => true, () => {});
    expect(fs.readFileSync(path.join(root, "courses/Discrete/grades.md"), "utf8")).toContain(GRADES_HIDDEN);
    expect(fs.readFileSync(path.join(root, "courses/Discrete/README.md"), "utf8")).toContain(
      "**Grades**: Your course site doesn’t show you grades for this course. See [grades.md](grades.md).",
    );
    expect(Object.values(loadGrades(root).courses)[0].note).toBe(GRADES_HIDDEN);
  });

  it("listing reads the signed-in hint, and grades follow access", () => {
    const root = gradesVault("https://x");
    for (const s of ["school", "work"]) fs.mkdirSync(path.join(root, "spaces", s), { recursive: true });
    expect(connections()[0].signedIn).toBe(false);
    markSignedIn("canvas-x", true);
    expect(connections()[0].signedIn).toBe(true);
    expect(load(root).connections[0].signedIn).toBe(true);
    putGrades(root, { connection: "canvas-x", courseId: "1001", course: "Discrete Structures", folder: "courses/Discrete", updated: 0, current: {}, groups: [], items: [] });
    setAccess("school", "canvas-x/1001", ["grades"]);
    setAccess("work", "canvas-x/1001", ["overview", "syllabus"]);
    expect(grades(visible("school")).length).toBe(1);
    expect(grades(visible("work"))).toEqual([]);
  });

  it("a grades refresh skips courses the space can't see grades for, without reading the keychain", async () => {
    const root = gradesVault("http://127.0.0.1:9");
    fs.mkdirSync(path.join(root, "spaces/work"), { recursive: true });
    setAccess("work", "canvas-x/1001", ["overview"]);
    const events: GradesEvent[] = [];
    await gradesRefresh(visible("work"), "canvas-x", (e) => events.push(e));
    expect(events).toEqual([{ type: "done" }]);
    // With grades visible but no session: signed out, then done, and the hint cleared.
    markSignedIn("canvas-x", true);
    setAccess("work", "canvas-x/1001", ["grades"]);
    const again: GradesEvent[] = [];
    await gradesRefresh(visible("work"), "canvas-x", (e) => again.push(e));
    expect(again).toEqual([{ type: "error", message: SIGNED_OUT }, { type: "done" }]);
    expect(connections()[0].signedIn).toBe(false);
  });

  it("a session comes only from a parseable keychain entry; otherwise signed out", () => {
    const root = vaultRoot();
    save(root, { connections: [conn("canvas-x", "canvas", "http://127.0.0.1:9", { signedIn: true })] });
    expect(() => session("nope")).toThrow("That course site isn’t connected.");
    expect(() => session("canvas-x")).toThrow(SIGNED_OUT);
    expect(load(root).connections[0].signedIn).toBe(false);
    keychainSet(lmsVaultAccount("canvas-x"), "not json");
    expect(() => session("canvas-x")).toThrow(SIGNED_OUT);
    keychainSet(lmsVaultAccount("canvas-x"), '{"cookies":[{"name":"canvas_session","value":"v"}],"csrf":null}');
    expect(session("canvas-x").getCredential()).toEqual({ cookies: [{ name: "canvas_session", value: "v" }], csrf: null });
  });

  it("a sign-in is kept in the keychain as the credential's JSON, with its account and school", async () => {
    const s = await site((t) => (t.startsWith("/api/v1/users/self") ? json('{"id":42}') : status(404)));
    const st = Site.forTest("canvas", s.base);
    const cred: Credential = { cookies: [{ name: "canvas_session", value: "v" }], csrf: null };
    const v = await finishSignIn(st, cred, "  Indiana University ");
    expect(v).toMatchObject({ id: connectionId(st), kind: "canvas", address: s.base, schoolName: "Indiana University", signedIn: true, courses: [] });
    expect(keychainGet(lmsVaultAccount(v.id))).toBe('{"cookies":[{"name":"canvas_session","value":"v"}],"csrf":null}');
    expect(loadAccounts(vaultRoot()).connections[v.id]).toBe(accountFingerprint(st, "42"));
    expect(fs.readFileSync(path.join(vaultRoot(), ".phaethon/lms.json"), "utf8")).not.toContain("canvas_session");
    // Again as the same account: the same connection.
    const again = await finishSignIn(st, { ...cred, csrf: "t" }, null);
    expect(again.id).toBe(v.id);
    expect(load(vaultRoot()).connections.length).toBe(1);
    expect(JSON.parse(keychainGet(lmsVaultAccount(v.id))!).csrf).toBe("t");
  });

  it("a failed identity check saves nothing and keeps the known account's session", async () => {
    const s = await site((t) => (t.startsWith("/api/v1/users/self") ? status(500) : html("<html>login</html>")));
    const root = vaultRoot();
    save(root, { connections: [conn("canvas-x", "canvas", s.base, { signedIn: true })] });
    const st = Site.forTest("canvas", s.base);
    const acc: Accounts = { connections: { "canvas-x": accountFingerprint(st, "42") } };
    saveAccounts(root, acc);
    keychainSet(lmsVaultAccount("canvas-x"), "known");
    const before = load(root);
    const err = await finishSignIn(st, { cookies: [{ name: "_normandy_session", value: "someone-else" }], csrf: null }, "School").catch((e: Error) => e.message);
    expect(err).toContain("nothing was saved");
    expect(s.log.some((x) => x.target === "/api/v1/users/self")).toBe(true);
    expect(load(root)).toEqual(before);
    expect(loadAccounts(root)).toEqual(acc);
    expect(keychainGet(lmsVaultAccount("canvas-x"))).toBe("known");
    expect(keychainGet(lmsVaultAccount(connectionId(st)))).toBeNull();
  });

  it("account ids come from each site's documented whoami", async () => {
    const s = await site((t) => (t.startsWith("/api/v1/users/self") ? json('{"id":4242,"name":"Sam"}') : status(404)));
    expect(await account(canvasSession(s.base))).toBe("4242");
    expect(await account(new Session(Site.forTest("moodle", s.base), { cookies: [], csrf: null }))).toBeNull();
  });

  it("a connection is reused only for its own site and account", () => {
    const st: Store = { connections: [] };
    const acc: Accounts = { connections: {} };
    const canvas = Site.create("canvas", "https://iu.instructure.com");
    const fp = (id: string) => accountFingerprint(canvas, id);
    expect(fp("42")).toBe(fp("42"));
    expect(fp("42").length).toBe(32);
    expect(fp("42")).not.toBe(fp("99"));
    recordSignIn(st, acc, canvas, "canvas-iu-instructure-com", null);
    st.connections[0].courses["7"] = { name: "Calc", folder: "Calc", files: {}, links: {}, due: [] };
    const a = chooseConnection(st, acc, canvas, fp("42"));
    expect(a).toBe("canvas-iu-instructure-com");
    recordSignIn(st, acc, canvas, a, fp("42"));
    expect(chooseConnection(st, acc, canvas, fp("42"))).toBe(a);
    expect(st.connections.find((c) => c.id === a)!.courses["7"]).toBeDefined();
    expect(st.connections.length).toBe(1);
    const b = chooseConnection(st, acc, canvas, fp("99"));
    expect(b).not.toBe(a);
    expect(chooseConnection(st, acc, canvas, fp("99"))).toBe(b);
    recordSignIn(st, acc, canvas, b, fp("99"));
    expect(st.connections.find((c) => c.id === b)!.courses).toEqual({});
    expect(chooseConnection(st, acc, canvas, fp("42"))).toBe(a);
    expect(chooseConnection(st, acc, canvas, fp("99"))).toBe(b);
    const unknown = chooseConnection(st, acc, canvas, null);
    expect(unknown !== a && unknown !== b).toBe(true);

    const m1 = Site.create("moodle", "https://x.edu/moodle-a/");
    const m2 = Site.create("moodle", "https://x.edu/moodle-b/");
    expect(connectionId(m1)).toBe(connectionId(m2));
    const id1 = chooseConnection(st, acc, m1, null);
    recordSignIn(st, acc, m1, id1, null);
    const id2 = chooseConnection(st, acc, m2, null);
    expect(id2).not.toBe(id1);
    recordSignIn(st, acc, m2, id2, null);
    expect(chooseConnection(st, acc, m1, null)).toBe(id1);
    expect(chooseConnection(st, acc, m2, null)).toBe(id2);
    expect(st.connections.find((c) => c.id === id2)!.address).toBe("https://x.edu/moodle-b");
    expect(/^[A-Za-z0-9-]+$/.test(id2)).toBe(true);
    expect(courseKey(id2, "5").length).toBeLessThan(128);
  });

  it("disconnecting forgets only the sign-in", () => {
    const root = gradesVault("http://127.0.0.1:9");
    fs.mkdirSync(path.join(root, "spaces/s"), { recursive: true });
    setAccess("s", "canvas-x/1001", ["files"]);
    keychainSet(lmsVaultAccount("canvas-x"), '{"cookies":[],"csrf":null}');
    markSignedIn("canvas-x", true);
    expect(() => disconnect("nope")).toThrow("That course site isn’t connected.");
    disconnect("canvas-x");
    expect(keychainGet(lmsVaultAccount("canvas-x"))).toBeNull();
    const c = load(root).connections[0];
    expect(c.signedIn).toBe(false);
    expect(Object.keys(c.courses)).toEqual(["1001"]);
    expect(visible("s").courses.length).toBe(1);
    expect(fs.existsSync(path.join(root, "courses/Discrete/README.md"))).toBe(true);
  });
});

// ---- Import integrity: every chosen course, cancel and resume, browsing ----

function twoCourseCanvas(state: { stall: boolean; onFiles?: () => void }): (t: string) => Reply {
  return (t) => {
    const [p, query = ""] = t.split("?");
    switch (p) {
      case "/api/v1/courses":
        if (query.includes("enrollment_state=completed")) return json("[]");
        if (query.includes("page=2")) return json('[{"id":2,"name":"Beta"}]');
        return { ...json('[{"id":1,"name":"Alpha"}]'), headers: { link: '</api/v1/courses?enrollment_state=active&page=2>; rel="next"' } };
      case "/api/v1/users/self":
        return json('{"id":42}');
      case "/api/v1/courses/1":
        return json('{"id":1,"syllabus_body":"<p>Alpha syllabus</p>"}');
      case "/api/v1/courses/2":
        return json('{"id":2,"syllabus_body":"<p>Beta syllabus</p>"}');
      case "/api/v1/courses/1/files":
        state.onFiles?.();
        return json('[{"id":11,"display_name":"a.txt","url":"/files/11/download","size":11},{"id":12,"display_name":"b.txt","url":"/files/12/download"}]');
      case "/files/11/download":
        return tagged("text/plain", "alpha bytes", '"e1"');
      case "/files/12/download":
        return state.stall ? stalled("text/plain", "partial") : json("beta");
      default:
        return status(404);
    }
  };
}

function integrityVault(base: string): string {
  const root = vaultRoot();
  for (const s of ["s", "other"]) fs.mkdirSync(path.join(root, "spaces", s), { recursive: true });
  save(root, { connections: [conn("canvas-x", "canvas", base, { signedIn: true })] });
  keychainSet(lmsVaultAccount("canvas-x"), JSON.stringify({ cookies: [{ name: "_normandy_session", value: "s" }], csrf: null }));
  return root;
}

function partsLeft(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".part")) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("imports (ported from service.rs)", () => {
  it("every chosen course across list pages is imported, and a cancel resumes where it stopped", async () => {
    const state = { stall: true };
    const s = await site(twoCourseCanvas(state));
    const root = integrityVault(s.base);
    const ids = ["1", "2"];

    // 1. Cancel while b.txt is downloading, through the registry lms_import_cancel uses.
    expect(cancelImport("canvas-x")).toBe(false);
    const events: ImportEvent[] = [];
    const started = Date.now();
    const run = importCourses("canvas-x", ids, ["s"], (e) => events.push(e));
    let cancelled = false;
    let busy: ImportEvent[] = [];
    for (let i = 0; i < 400; i++) {
      if (s.log.some((x) => x.target.startsWith("/files/12/download"))) {
        // One import at a time in a vault.
        await importCourses("canvas-x", ids, ["s"], (e) => busy.push(e));
        await sleep(100);
        cancelled = cancelImport("canvas-x");
        break;
      }
      await sleep(25);
    }
    await run;
    expect(cancelled).toBe(true);
    expect(busy).toEqual([{ type: "error", message: "Courses are already being imported. Wait for that to finish." }, { type: "done" }]);
    expect(cancelImport("canvas-x")).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(events.slice(-2)).toEqual([{ type: "cancelled" }, { type: "done" }]);
    expect(events.some((e) => e.type === "course")).toBe(false);
    let st = load(root);
    const alpha = st.connections[0].courses["1"];
    expect(alpha.partial).toBe(true);
    const aKey = `${s.base}/files/11/download`;
    expect(alpha.files[aKey].etag).toBe('"e1"');
    expect(alpha.files[aKey].sha256).toBe(sha256Hex("alpha bytes"));
    expect(Object.keys(alpha.files).length).toBe(1);
    expect(st.connections[0].courses["2"]).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "courses/Alpha/files/a.txt"), "utf8")).toBe("alpha bytes");
    expect(fs.existsSync(path.join(root, "courses/Alpha/files/b.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "courses/Alpha/README.md"))).toBe(false);
    expect(partsLeft(path.join(root, "courses"))).toEqual([]);
    expect(visible("s").courses).toEqual([]);
    expect(loadGrades(root).courses).toEqual({});

    // 2. Again: it resumes (a.txt is only asked about) and both courses come in.
    state.stall = false;
    const before = s.log.length;
    const again: ImportEvent[] = [];
    await importCourses("canvas-x", ids, ["s"], (e) => again.push(e));
    expect(again.filter((e) => e.type === "course").map((e) => (e as { course: string }).course)).toEqual(["1", "2"]);
    expect(again[again.length - 1]).toEqual({ type: "done" });
    expect(again.filter((e) => e.type === "done").length).toBe(1);
    const hits = s.log.slice(before);
    expect(hits.some((x) => x.target.includes("page=2"))).toBe(true);
    const aHits = hits.filter((x) => x.target === "/files/11/download");
    expect(aHits.length).toBe(1);
    expect(aHits[0].ifNoneMatch).toBe('"e1"');
    st = load(root);
    expect(st.connections[0].courses["1"].partial).toBeUndefined();
    expect(st.connections[0].courses["2"].partial).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "courses/Alpha/files/b.txt"), "utf8")).toBe("beta");
    expect(visible("s").courses.map((c) => c.key)).toEqual(["canvas-x/1", "canvas-x/2"]);
    expect(visible("other").courses).toEqual([]);
    expect(fs.existsSync(path.join(root, "spaces/s/courses"))).toBe(false);

    // 3. A later import keeps what the person chose for the space.
    setAccess("s", "canvas-x/1", ["overview"]);
    await importCourses("canvas-x", ["1"], ["s"], () => {});
    expect([...visible("s").courses.find((c) => c.key === "canvas-x/1")!.parts]).toEqual(["overview"]);
    setAccess("s", "canvas-x/1", ["overview", "syllabus", "assignments", "announcements", "files", "grades"]);

    // 4. The browser: space-relative paths this space may open.
    const b = courseContent("s", "canvas-x/1");
    const has = (p: string, k: string) => b.entries.some((e) => e.path === p && e.kind === k);
    expect(has("courses/Alpha/README.md", "overview") && has("courses/Alpha/syllabus.md", "overview")).toBe(true);
    const a = b.entries.find((e) => e.path === "courses/Alpha/files/a.txt")!;
    expect([a.kind, a.bytes]).toEqual(["file", 11]);
    expect(b.updated).toBeDefined();
    expect(b.entries[0].kind).toBe("overview");
    expect(() => courseContent("other", "canvas-x/1")).toThrow();
    setAccess("other", "canvas-x/1", ["overview"]);
    expect(courseContent("other", "canvas-x/1").entries.every((e) => e.path === "courses/Alpha/README.md")).toBe(true);
  });

  it("an import refuses unknown spaces and a missing session, and says when the site was disconnected", async () => {
    const state: { stall: boolean; onFiles?: () => void } = { stall: false };
    const s = await site(twoCourseCanvas(state));
    const root = integrityVault(s.base);
    const ev: ImportEvent[] = [];
    await importCourses("canvas-x", ["1"], ["nope"], (e) => ev.push(e));
    expect(ev).toEqual([{ type: "error", message: "There’s no space called “nope”." }, { type: "done" }]);

    // Removed from lms.json while importing.
    state.onFiles = () => save(root, { connections: [] });
    const gone: ImportEvent[] = [];
    await importCourses("canvas-x", ["1"], ["s"], (e) => gone.push(e));
    expect(gone.slice(-2)).toEqual([{ type: "error", message: "This course site was disconnected while importing." }, { type: "done" }]);

    // A missing course is said once; then signed out without a session.
    state.onFiles = undefined;
    integrityVault(s.base);
    const missing: ImportEvent[] = [];
    await importCourses("canvas-x", ["1", "9"], ["s"], (e) => missing.push(e));
    expect(missing[0]).toEqual({ type: "error", message: "Some of the chosen courses aren’t on the course site any more." });
    expect(missing.filter((e) => e.type === "course").length).toBe(1);
    resetMemoryKeychain();
    const out: ImportEvent[] = [];
    await importCourses("canvas-x", ["1"], ["s"], (e) => out.push(e));
    expect(out).toEqual([{ type: "error", message: SIGNED_OUT }, { type: "done" }]);
    expect(load(root).connections[0].signedIn).toBe(false);
  });
});
