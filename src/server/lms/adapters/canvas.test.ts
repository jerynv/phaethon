import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { allowLoopbackForTests, Session } from "../session.ts";
import { assertReadOnlyWithSession, html, json, redirect, serve, status, type FakeSite, type Reply, type Route } from "../testing/fake-site.ts";
import { GRADES_HIDDEN, LmsError, Site, summaryIsEmpty, type Cookie } from "../types.ts";
import { canvas, canvasInternals, setForbiddenRetryDelaysForTests } from "./canvas.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "canvas");
const fixture = (name: string, base: string) => fs.readFileSync(path.join(FIX, `${name}.json`), "utf8").replaceAll("{BASE}", base);

const UNAUTHORIZED = '{"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]}';
const UNAUTHENTICATED = '{"status":"unauthenticated","errors":[{"message":"user authorization required"}]}';
const reply = (code: number, body: string): Reply => ({ status: code, ctype: "application/json; charset=utf-8", body });

const sites: FakeSite[] = [];
async function fake(route: (u: URL, base: string, target: string) => Reply): Promise<FakeSite> {
  let base = "";
  const r: Route = (target) => route(new URL(base + target), base, target);
  const f = await serve(r);
  base = f.base;
  sites.push(f);
  return f;
}
afterEach(async () => {
  for (const f of sites.splice(0)) await f.close();
  allowLoopbackForTests(false);
});
beforeAll(() => setForbiddenRetryDelaysForTests([1, 1, 1]));

function session(base: string, cookies: Cookie[] = [{ name: "_normandy_session", value: "sess123" }, { name: "log_session_id", value: "abc" }]): Session {
  return new Session(Site.forTest("canvas", base), { cookies, csrf: "tok+en==" });
}
const q = (u: URL, k: string) => u.searchParams.getAll(k);
const errKind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof LmsError ? e.kind : String(e);
  }
  return "ok";
};

describe("canvas sign-in", () => {
  it("login url is the site's login page", () => {
    expect(canvas.loginUrl(new URL("https://iu.instructure.com")).href).toBe("https://iu.instructure.com/login");
  });

  it("signed in only back on the site past login with a session", () => {
    const base = new URL("https://iu.instructure.com");
    const cookies = [
      { name: "_normandy_session", value: "s3ss" },
      { name: "log_session_id", value: "f00" },
      { name: "_csrf_token", value: "abc%2Bdef%2F%3D%3D" },
    ];
    const at = (u: string, c: Cookie[]) => canvas.loginResult(base, { url: new URL(u), cookies: c });
    expect(at("https://iu.instructure.com/login/canvas", cookies)).toBeNull();
    expect(at("https://iu.instructure.com/login/saml", cookies)).toBeNull();
    expect(at("https://idp.iu.edu/idp/profile/SAML2/Redirect/SSO", cookies)).toBeNull();
    expect(at("http://iu.instructure.com/", cookies)).toBeNull();
    expect(at("https://iu.instructure.com:8443/", cookies)).toBeNull();
    expect(at("https://iu.instructure.com/", cookies.slice(1))).toBeNull();
    const cred = at("https://iu.instructure.com/?login_success=1", cookies)!;
    expect(cred.cookies).toEqual(cookies);
    expect(cred.csrf).toBe("abc+def/==");
    const old = at("https://iu.instructure.com/courses", [{ name: "canvas_session", value: "x" }])!;
    expect(old.csrf).toBeNull();
  });
});

describe("canvas courses and content", () => {
  it("courses across pages with the json guard", async () => {
    const f = await fake((u, b) => {
      if (u.pathname !== "/api/v1/courses") return reply(404, "{}");
      if (q(u, "enrollment_state")[0] === "completed") return json(fixture("courses_completed", b));
      if (q(u, "page")[0] === "2") return json(fixture("courses_active_2", b));
      const r = json(`while(1);${fixture("courses_active_1", b)}`);
      r.headers = {
        Link: `<${b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=1&per_page=100>; rel="current",<${b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=2&per_page=100>; rel="next",<${b}/api/v1/courses?enrollment_state=active&include%5B%5D=term&page=1&per_page=100>; rel="first"`,
      };
      return r;
    });
    const list = await canvas.courses(session(f.base));
    expect(list.map((c) => [c.id, c.name, c.code ?? null, c.term ?? null, c.current])).toEqual([
      ["1001", "Data Structures", "C343", "Fall 2026", true],
      ["1002", "Calculus II", "M212", "Fall 2026", true],
      ["1003", "Intro to Ethics", "P100", "Spring 2020", false],
      ["1005", "Research Seminar", null, null, false],
      ["900", "Discrete Mathematics", "C241", "Spring 2026", false],
    ]);
    expect(f.log.length).toBe(3);
    for (const s of f.log) {
      expect(s.method).toBe("GET");
      expect(s.cookie).toBe("_normandy_session=sess123; log_session_id=abc");
      expect(s.headers.authorization).toBeUndefined();
    }
  });

  it("an ended session is signed out", async () => {
    let f = await fake(() => reply(401, UNAUTHENTICATED));
    expect(await errKind(canvas.courses(session(f.base)))).toBe("signedOut");
    f = await fake((u) => (u.pathname.startsWith("/login") ? html("<form>Sign in</form>") : redirect("/login")));
    expect(await errKind(canvas.courses(session(f.base)))).toBe("signedOut");
    expect(await errKind(canvas.content(session(f.base), "1001"))).toBe("signedOut");
    f = await fake((u, b) => (u.pathname === "/api/v1/courses/1001" ? json(fixture("course", b)) : reply(401, UNAUTHENTICATED)));
    expect(await errKind(canvas.content(session(f.base), "1001"))).toBe("signedOut");
  });

  it("a course with its files, pages and modules", async () => {
    const f = await fake((u, b) => {
      switch (u.pathname) {
        case "/api/v1/users/self":
          return json('{"id":42,"name":"Sam Student"}');
        case "/api/v1/courses/1001":
          return json(fixture("course", b));
        case "/api/v1/courses/1001/tabs":
          return json(`while(1);${fixture("tabs", b)}`);
        case "/api/v1/courses/1001/folders":
          return json(fixture("folders", b));
        case "/api/v1/courses/1001/files":
          return json(fixture("files", b));
        case "/api/v1/courses/1001/files/5009":
          return json(fixture("file_5009", b));
        case "/api/v1/courses/1001/pages/reading-guide":
          return json(fixture("page_reading_guide", b));
        case "/api/v1/courses/1001/assignments":
          return json(fixture("assignments", b));
        case "/api/v1/courses/1001/assignments/7003":
          return reply(401, UNAUTHORIZED);
        case "/api/v1/courses/1001/discussion_topics":
          return q(u, "only_announcements")[0] === "true" ? json(fixture("announcements", b)) : reply(404, "{}");
        case "/api/v1/courses/1001/modules":
          return json(fixture("modules", b));
        case "/api/v1/courses/1001/modules/2/items":
          return json(fixture("module_2_items", b));
        default:
          return reply(404, '{"errors":[{"message":"The specified resource does not exist."}]}');
      }
    });
    const base = f.base;
    const c = await canvas.content(session(base), "1001");
    const at = (p: string) => new URL(base + p).href;

    expect(c.syllabus).toContain('href="https://open.example.org/books/ods-java.pdf"');
    expect(c.syllabus).toContain(`href="${base}/courses/1001/files/5003?verifier=Zx9&amp;wrap=1"`);

    expect(c.files.map((x) => [x.name, x.folder, x.mime])).toEqual([
      ["Lecture 1 - Arrays.pdf", "Lectures/Week 1", "application/pdf"],
      ["schedule.pdf", null, "application/pdf"],
      ["Chapter 1 notes.pdf", "Lectures", "application/pdf"],
    ]);
    const schedule = c.files[1];
    expect(schedule.url.href).toBe(at("/files/5003/download?download_frd=1&verifier=Sc3"));
    expect(schedule.size).toBe(48213);
    const aliases = schedule.aliases.map((a) => a.href);
    for (const alias of ["/courses/1001/files/5003", "/courses/1001/files/5003/download", "/files/5003", "/api/v1/courses/1001/files/5003", "/courses/1001/files/5003/file_preview?annotate=0"]) {
      expect(aliases).toContain(at(alias));
    }
    expect(c.files.every((x) => x.url.href.startsWith(base))).toBe(true);

    expect(c.pages.length).toBe(1);
    expect(c.pages[0].title).toBe("Reading guide");
    expect(c.pages[0].url?.href).toBe(at("/courses/1001/pages/reading-guide"));
    expect(c.pages[0].html).toContain("Read chapter 1");

    expect(c.assignments.map((a) => [a.title, a.due, a.points])).toEqual([
      ["Homework 1", "2026-10-20T03:59:00Z", 10],
      ["Homework 2", null, 10],
    ]);
    expect(c.assignments[0].html).toContain("dynamic array");
    expect(c.assignments[0].url?.href).toBe(at("/courses/1001/assignments/7001"));

    expect(c.announcements.length).toBe(1);
    expect(c.announcements[0].title).toBe("Office hours moved");
    expect(c.announcements[0].posted).toBe("2026-09-02T15:00:00Z");

    expect(c.modules.map((m) => [m.name, m.items])).toEqual([
      ["Week 1: Arrays", ["Lecture 1 - Arrays.pdf", "Reading guide", "Homework 1", "Visualgo", "Connect homework"]],
      ["Week 2: Lists", ["Homework 2", "Quiz 1", "Bonus project"]],
    ]);
    expect(c.links.map((l) => [l.title, l.url.href])).toEqual([
      ["Visualgo", "https://visualgo.net/en/list"],
      ["Connect homework", "https://connect.mheducation.com/lti"],
    ]);
    expect(c.skipped).toEqual([
      "McGraw Hill Connect: an outside tool, open it on the course site",
      "File “Midterm key.pdf”: locked for now",
      "Pages: hidden in this course",
      "Assignment “Bonus project”: not open to you in this course",
    ]);
    expect(f.log.some((s) => s.target.startsWith("/api/v1/courses/1001/pages?"))).toBe(false);
    expect(f.log.every((s) => s.method === "GET" && s.cookie?.includes("_normandy_session=sess123"))).toBe(true);
  });

  it("imports link-only files from published module pages without treating hidden as locked", async () => {
    const f = await fake((u, b) => {
      switch (u.pathname) {
        case "/api/v1/courses/1001": return json({ syllabus_body: "" });
        case "/api/v1/courses/1001/tabs": return json([{ id: "modules" }, { id: "files", hidden: true }, { id: "pages", hidden: true }]);
        case "/api/v1/courses/1001/folders": return json([]);
        case "/api/v1/courses/1001/modules": return json([{ name: "Week 1", items: [{ type: "Page", page_url: "readings", title: "Readings" }] }]);
        case "/api/v1/courses/1001/pages/readings": return json({
          title: "Readings", body: [1, 2, 3].map((id) => `<a href="/courses/1001/files/${id}">Reading ${id}</a>`).join(""),
        });
        default: {
          const id = Number(u.pathname.match(/^\/api\/v1\/courses\/1001\/files\/(\d+)$/)?.[1]);
          if (!id) return status(404);
          return json({
            id, display_name: `reading${id}.pdf`, hidden: true, hidden_for_user: true,
            locked_for_user: id === 2, url: id === 3 ? "" : `${b}/files/${id}/download?download_frd=1&verifier=link-access`,
          });
        }
      }
    });
    const c = await canvas.content(session(f.base), "1001");
    expect(c.files.map((x) => x.name)).toEqual(["reading1.pdf"]);
    expect(c.files[0].url.searchParams.get("verifier")).toBe("link-access");
    expect(c.skipped).toContain("File “reading2.pdf”: locked for now");
    expect(c.skipped).toContain("File “reading3.pdf”: locked for now");
    expect(c.skipped).not.toContain("File “reading1.pdf”: locked for now");
    expect(f.log.every((r) => r.method === "GET")).toBe(true);
  });

  it("never leaves the site", async () => {
    const other = await fake(() => json("[]"));
    const f = await fake((u) => {
      if (u.pathname === "/api/v1/courses") {
        const r = json("[]");
        r.headers = { Link: `<${other.base}/api/v1/courses?page=2>; rel="next"` };
        return r;
      }
      return { status: 302, ctype: "text/plain", headers: { location: `${other.base}/stolen` }, body: "" };
    });
    const s = session(f.base);
    const e = await canvas.courses(s).catch((x) => x);
    expect(e).toBeInstanceOf(LmsError);
    expect((e as LmsError).kind).toBe("other");
    expect(other.log.length).toBe(0);
    allowLoopbackForTests(true);
    const res = await s.get(new URL(`${f.base}/files/1/download`)).catch(() => null);
    res?.discard();
    expect(other.log.length).toBe(1);
    expect(other.log.every((h) => h.cookie === undefined)).toBe(true);
  });

  it("discovers files through the home page and nested published pages when Pages is hidden", async () => {
    const f = await fake((u, b) => {
      switch (u.pathname) {
        case "/api/v1/users/self": return json({ id: 42 });
        case "/api/v1/courses/1001": return json({});
        case "/api/v1/courses/1001/tabs": return json([{ id: "pages", hidden: true }]);
        case "/api/v1/courses/1001/folders": return json([]);
        case "/api/v1/courses/1001/front_page": return json({ url: "home", title: "Home", body: `<A HREF = "/courses/1001/pages/week-1">Week 1</A><a href="${b}/courses/2002/pages/private">Other course</a><a href="https://other.example/courses/1001/pages/private">Other site</a>` });
        case "/api/v1/courses/1001/pages/week-1": return json({ title: "Week 1", body: '<a href="week-2">Week 2</a><a href="/courses/1001/pages/locked">Locked</a>' });
        case "/api/v1/courses/1001/pages/week-2": return json({ title: "Week 2", body: '<a href="/courses/1001/pages/home">Home</a><a href="/courses/1001/pages/locked">Locked again</a><a HREF = /courses/1001/files/7/download>Notes</a><img SRC="/files/8/preview">' });
        case "/api/v1/courses/1001/pages/locked": return reply(403, UNAUTHORIZED);
        case "/api/v1/courses/1001/files/7": return json({ id: 7, display_name: "notes.pdf", hidden_for_user: true, locked_for_user: false, url: `${b}/files/7/download` });
        case "/api/v1/files/8": return json({ id: 8, display_name: "diagram.png", url: `${b}/files/8/download` });
        default: return status(404);
      }
    });
    const c = await canvas.content(session(f.base), "1001");
    expect(c.pages.map((p) => p.title)).toEqual(["Home", "Week 1", "Week 2"]);
    expect(c.files.map((x) => x.name)).toEqual(["notes.pdf", "diagram.png"]);
    expect(c.skipped).toContain("Page “locked”: not open to you in this course");
    expect(f.log.filter((r) => r.target === "/api/v1/courses/1001/pages/locked")).toHaveLength(1);
    expect(f.log.some((r) => r.target.includes("/pages/home") || r.target.includes("private"))).toBe(false);
    expect(f.log.every((r) => r.method === "GET")).toBe(true);
  });

  it("course ids are numbers", async () => {
    const s = session("http://127.0.0.1:9");
    expect(await errKind(canvas.content(s, "../users/self"))).toBe("notFound");
    expect(await errKind(canvas.content(s, ""))).toBe("notFound");
  });

  it("imports a reachable home page even when the visible Pages list is refused", async () => {
    const f = await fake((u, b) => {
      switch (u.pathname) {
        case "/api/v1/courses/1001": return json({});
        case "/api/v1/courses/1001/tabs": return json([{ id: "pages" }]);
        case "/api/v1/courses/1001/folders": return json([]);
        case "/api/v1/courses/1001/pages": return reply(403, UNAUTHORIZED);
        case "/api/v1/courses/1001/front_page": return json({ url: "home", title: "Home", body: '<a href="/courses/1001/files/7">Slides</a>' });
        case "/api/v1/courses/1001/files/7": return json({ id: 7, display_name: "slides.pdf", url: `${b}/files/7/download` });
        default: return status(404);
      }
    });
    const c = await canvas.content(session(f.base), "1001");
    expect(c.pages.map((p) => p.title)).toEqual(["Home"]);
    expect(c.files.map((f) => f.name)).toEqual(["slides.pdf"]);
  });

  it("discovers same-course files and pages added to modules as URL links", async () => {
    const f = await fake((u, b) => {
      switch (u.pathname) {
        case "/api/v1/courses/1001": return json({});
        case "/api/v1/courses/1001/tabs": return json([{ id: "modules" }]);
        case "/api/v1/courses/1001/folders": return json([]);
        case "/api/v1/courses/1001/modules": return json([{ name: "Week 1", items: [
          { type: "ExternalUrl", title: "Slides", external_url: `${b}/courses/1001/files/7` },
          { type: "ExternalUrl", title: "Readings", external_url: `${b}/courses/1001/pages/week-1` },
          { type: "ExternalUrl", title: "Other course", external_url: `${b}/courses/2002/pages/private` },
          { type: "ExternalUrl", title: "Publisher", external_url: "https://publisher.example/files/9" },
        ] }]);
        case "/api/v1/courses/1001/pages/week-1": return json({ title: "Readings", body: '<a href="/courses/1001/files/8">Notes</a>' });
        case "/api/v1/courses/1001/files/7": return json({ id: 7, display_name: "slides.pdf", url: `${b}/files/7/download` });
        case "/api/v1/courses/1001/files/8": return json({ id: 8, display_name: "notes.pdf", url: `${b}/files/8/download` });
        default: return status(404);
      }
    });
    const c = await canvas.content(session(f.base), "1001");
    expect(c.pages.map((p) => p.title)).toEqual(["Readings"]);
    expect(c.files.map((f) => f.name).sort()).toEqual(["notes.pdf", "slides.pdf"]);
    expect(c.links.some((l) => l.title === "Publisher")).toBe(true);
    expect(f.log.some((r) => r.target.includes("private"))).toBe(false);
  });

  it("link headers, times and folders", () => {
    const { nextLink, unix, folderPaths } = canvasInternals;
    expect(nextLink('<https://x/a?page=1>; rel="current", <https://x/a?page=2&per_page=100>; rel="next", <https://x/a?page=9>; rel="last"')).toBe("https://x/a?page=2&per_page=100");
    expect(nextLink('<https://x/a?page=1>; rel="first"')).toBeNull();
    expect(unix("1970-01-01T00:00:00Z")).toBe(0);
    expect(unix("2026-10-10T12:00:00Z")).toBe(1_791_633_600);
    expect(unix("2026-10-10T08:00:00.123-04:00")).toBe(1_791_633_600);
    expect(unix("soon")).toBeNull();
    const p = folderPaths(JSON.parse(fixture("folders", "")));
    expect(p.get("10")).toBeNull();
    expect(p.get("12")).toBe("Lectures/Week 1");
  });

  it("pagination never silently returns a cycle or a capped list", async () => {
    for (const cycle of [true, false]) {
      const f = await serve((target) => {
        const n = Number(target.split("=").pop()) || 0;
        const r = json("[]");
        r.headers = { Link: `</pages?n=${cycle ? n : n + 1}>; rel="next"` };
        return r;
      });
      sites.push(f);
      const s = new Session(Site.forTest("canvas", f.base), { cookies: [], csrf: null });
      expect(await errKind(canvasInternals.getAll(s, new URL(`${f.base}/pages?n=0`)))).toBe("incomplete");
      expect(f.log.length).toBe(cycle ? 1 : canvasInternals.MAX_PAGES);
    }
  });

  it("module and html references beyond three hundred are all discovered", async () => {
    for (const linked of [false, true]) {
      const f = await serve((target) => {
        const p = target.split("?")[0];
        if (p === "/api/v1/courses/1001") {
          const body = linked
            ? Array.from({ length: 350 }, (_, i) => `<a href='/courses/1001/files/${i + 1}/download'>File${i + 1}</a>`).join("")
            : "";
          return json({ syllabus_body: body });
        }
        if (p === "/api/v1/courses/1001/tabs") return json('[{"id":"modules"},{"id":"syllabus"}]');
        if (p === "/api/v1/courses/1001/folders") return json("[]");
        if (p === "/api/v1/courses/1001/modules") {
          const ids = linked ? [] : [...Array.from({ length: 350 }, (_, i) => i + 1), ...Array.from({ length: 10 }, (_, i) => i + 1)];
          return json([{ name: "All readings", items: ids.map((id) => ({ type: "File", content_id: id, title: `File${id}` })) }]);
        }
        if (p.startsWith("/api/v1/courses/1001/files/")) {
          const id = Number(p.split("/").pop());
          return json({ id, display_name: `file${id}.txt`, size: 10, updated_at: "2026-11-01T00:00:00Z" });
        }
        return status(404);
      });
      sites.push(f);
      const s = new Session(Site.forTest("canvas", f.base), { cookies: [], csrf: null });
      const c = await canvas.content(s, "1001");
      expect(c.files.length).toBe(350);
      expect(c.files.some((x) => x.name === "file350.txt")).toBe(true);
      expect(f.log.filter((r) => r.target.startsWith("/api/v1/courses/1001/files/")).length).toBe(350);
      expect(c.skipped.some((x) => x.includes("too many") || x.includes("incomplete"))).toBe(false);
      expect(c.files[0].version).toBe("2026-11-01T00:00:00Z/10");
    }
  });

  it("the reference budget is explicit and counts unique requests only", () => {
    const files = new canvasInternals.Files();
    for (let id = 0; id < canvasInternals.MAX_REFERENCED; id++) expect(files.request(String(id))).toBe(true);
    expect(files.request("0")).toBe(false);
    expect(() => files.request("one-too-many")).toThrow(LmsError);
    expect(files.requested.size).toBe(canvasInternals.MAX_REFERENCED);
  });

  it("an incomplete file listing is not downgraded to a skipped course section", async () => {
    const f = await serve((target) => {
      const p = target.split("?")[0];
      if (p === "/api/v1/courses/1001") return json("{}");
      if (p === "/api/v1/courses/1001/tabs") return json('[{"id":"files"}]');
      if (p === "/api/v1/courses/1001/folders") return json("[]");
      if (p === "/api/v1/courses/1001/files") {
        const r = json("[]");
        r.headers = { Link: `<${target}>; rel="next"` };
        return r;
      }
      return status(404);
    });
    sites.push(f);
    const s = new Session(Site.forTest("canvas", f.base), { cookies: [], csrf: null });
    expect(await errKind(canvas.content(s, "1001"))).toBe("incomplete");
  });

  it("a part that is rate limited is asked again instead of counting as closed", async () => {
    let tries = 0;
    const f = await serve((target) => {
      const p = target.split("?")[0];
      if (p === "/api/v1/courses/1001") return json("{}");
      if (p === "/api/v1/courses/1001/tabs") return json('[{"id":"assignments"}]');
      if (p === "/api/v1/courses/1001/folders") return json("[]");
      if (p === "/api/v1/courses/1001/assignments") {
        tries++;
        if (tries < 3) return { status: 403, ctype: "text/plain", headers: { "x-rate-limit-remaining": "0" }, body: "403 Forbidden (Rate Limit Exceeded)" };
        return json([{ id: 1, name: "Homework 1", points_possible: 5 }]);
      }
      return status(404);
    });
    sites.push(f);
    const s = new Session(Site.forTest("canvas", f.base), { cookies: [], csrf: null });
    const c = await canvas.content(s, "1001");
    expect(c.assignments.map((a) => a.title)).toEqual(["Homework 1"]);
    expect(c.skipped.some((x) => x.startsWith("Assignments"))).toBe(false);
  });
});

describe("canvas grades", () => {
  const fx = (name: string) => fixture(`grades_${name}`, "");
  const gradeSite =
    (weighted: boolean): Route =>
    (t) => {
      const p = t.split("?")[0];
      if (p === "/api/v1/courses/1001/enrollments" && t.includes("user_id=self")) return json(fx("enrollments"));
      if (p === "/api/v1/courses/1001") return json(`{"id":1001,"name":"Discrete","apply_assignment_group_weights":${weighted}}`);
      if (p === "/api/v1/courses/1001/assignment_groups") return json(fx("groups"));
      if (p === "/api/v1/courses/1001/students/submissions" && t.includes("student_ids%5B%5D=self")) return json(`while(1);${fx("submissions")}`);
      if (p === "/api/v1/users/self") return json('{"id":42}');
      return status(404);
    };
  const gsession = (base: string) => new Session(Site.forTest("canvas", base), { cookies: [{ name: "_normandy_session", value: "sess123" }], csrf: "tok" });

  it("current and final, weights and flags", async () => {
    const f = await serve(gradeSite(true));
    sites.push(f);
    const g = await canvas.grades(gsession(f.base), "1001");
    expect(g.current.percent).toBe(88.42);
    expect(g.current.letter).toBe("B+");
    expect(g.current.points).toBe(168);
    expect(g.current.possible).toBeUndefined();
    expect([g.final?.percent, g.final?.letter]).toEqual([74.1, "C"]);
    expect(g.groups).toEqual([
      { name: "Homework", weight: 40 },
      { name: "Exams", weight: 60 },
    ]);
    expect(g.note).toBeUndefined();
    const by = (t: string) => g.items.find((i) => i.title === t)!;
    const h1 = by("Homework 1");
    expect([h1.score, h1.possible, h1.percent]).toEqual([9, 10, 90]);
    expect(h1.graded && h1.submitted && !h1.late && !h1.missing).toBe(true);
    expect(h1.group).toBe("Homework");
    expect(h1.comments).toEqual(["Nice proof. Watch the base case."]);
    expect(by("Homework 2").late).toBe(true);
    const h3 = by("Homework 3");
    expect(h3.missing && !h3.submitted && h3.score === 0).toBe(true);
    const h4 = by("Homework 4");
    expect(h4.excused && h4.score === undefined && h4.graded).toBe(true);
    const mid = by("Midterm");
    expect(mid.score === undefined && mid.percent === undefined && !mid.graded && mid.submitted).toBe(true);
    const quiz = by("Quiz week 3 (paper)");
    expect([quiz.grade, quiz.percent]).toEqual(["A-", 95]);
    expect(quiz.comments).toEqual(["Strong work on graphs."]);
    const fe = by("Final exam");
    expect(!fe.graded && !fe.excused && fe.score === undefined).toBe(true);
    expect(g.items[0].title).toBe("Homework 1");
    expect(g.items[g.items.length - 1].title).toBe("Quiz week 3 (paper)");
    assertReadOnlyWithSession(f.log, "_normandy_session=sess123");
  });

  it("an unweighted course has points out of what's graded and no weights", async () => {
    const f = await serve(gradeSite(false));
    sites.push(f);
    const g = await canvas.grades(gsession(f.base), "1001");
    expect(g.groups.every((gr) => gr.weight === undefined)).toBe(true);
    expect(g.current.possible).toBe(190);
  });

  it("a refused grade book is empty with a note", async () => {
    let f = await serve((t) => (t.split("?")[0] === "/api/v1/users/self" ? json('{"id":42}') : { status: 401, ctype: "application/json", body: '{"status":"unauthorized"}' }));
    sites.push(f);
    let g = await canvas.grades(gsession(f.base), "1001");
    expect(g.items.length === 0 && summaryIsEmpty(g.current)).toBe(true);
    expect(g.note).toBe(GRADES_HIDDEN);
    f = await serve(() => status(403));
    sites.push(f);
    g = await canvas.grades(gsession(f.base), "1001");
    expect(g.note).toBe(GRADES_HIDDEN);
  });

  it("signed out is an error", async () => {
    let f = await serve(() => status(401));
    sites.push(f);
    expect(await errKind(canvas.grades(gsession(f.base), "1001"))).toBe("signedOut");
    f = await serve((t) => (t.startsWith("/login") ? html("<form>Sign in</form>") : redirect("/login")));
    sites.push(f);
    expect(await errKind(canvas.grades(gsession(f.base), "1001"))).toBe("signedOut");
    expect(await errKind(canvas.grades(gsession(f.base), "../users"))).toBe("notFound");
  });
});
