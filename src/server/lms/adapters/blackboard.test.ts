import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../session.ts";
import { assertReadOnlyWithSession, html, json, redirect, serve, status, type FakeSite, type Reply } from "../testing/fake-site.ts";
import { GRADES_HIDDEN, LmsError, Site, type Cookie } from "../types.ts";
import { blackboard, blackboardInternals } from "./blackboard.ts";

const FIX = path.join(import.meta.dirname, "fixtures", "blackboard");
const fixture = (name: string) => fs.readFileSync(path.join(FIX, `${name}.json`), "utf8");

const sites: FakeSite[] = [];
afterEach(async () => {
  for (const f of sites.splice(0)) await f.close();
});

const loginPage = (): Reply => ({
  status: 200,
  ctype: "text/html;charset=UTF-8",
  body: '<!doctype html><title>Login</title><form action="/webapps/login/" method="post"></form>',
});
const bbStatus = (code: number): Reply => ({ status: code, ctype: "application/json", body: '{"status":0,"message":"no"}' });

/** Exact path and query → reply; anything else 404. */
async function fakeLearn(routes: [string, Reply][]): Promise<FakeSite> {
  const map = new Map(routes);
  const f = await serve((target) => map.get(target) ?? bbStatus(404));
  sites.push(f);
  return f;
}

const ROUTER = "expires:1760000000,id:ABC,signature:sig,site:s1,timeout:10800,user:4711,v:2,xsrf:tok-123";
function session(base: string): Session {
  return new Session(Site.forTest("blackboard", base), {
    cookies: [
      { name: "BbRouter", value: ROUTER },
      { name: "JSESSIONID", value: "J1" },
    ],
    csrf: "tok-123",
  });
}

const ME = "/learn/api/public/v1/users/me";
const C = "/learn/api/public/v1/courses/_100_1";

function courseRoutes(): [string, Reply][] {
  return [
    [ME, json(fixture("users_me"))],
    ["/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100", json(fixture("gradebook_columns"))],
    ["/learn/api/public/v1/courses/_100_1/contents?limit=200", json(fixture("contents_root"))],
    ["/learn/api/public/v1/courses/_100_1/contents?limit=200&offset=3", json(fixture("contents_root_2"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_1_1/children?limit=200", json(fixture("children_week1"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_6_1/children?limit=200", json(fixture("children_readings"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_2_1/attachments", json(fixture("attachments_syllabus"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_5_1/attachments", json(fixture("attachments_notes"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_9_1/attachments", json(fixture("attachments_ch1"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_7_1/attachments", json(fixture("attachments_empty"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_4_1/attachments", json(fixture("attachments_empty"))],
    ["/learn/api/public/v1/courses/_100_1/announcements?limit=100", json(fixture("announcements"))],
    ["/learn/api/public/v1/courses/_100_1/contents/_9_1/attachments/_503_1/download", redirect("/bbcswebdav/pid-9-dt-content-rid-503_1/xid-503_1")],
    ["/bbcswebdav/pid-9-dt-content-rid-503_1/xid-503_1", { status: 200, ctype: "application/pdf", body: "%PDF-1.7 chapter one" }],
  ];
}

const errKind = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof LmsError ? e.kind : String(e);
  }
  return "ok";
};

describe("blackboard sign-in", () => {
  it("login url is the site root", () => {
    expect(blackboard.loginUrl(new URL("https://learn.example.edu")).href).toBe("https://learn.example.edu/");
  });

  it("signed in only on the site past login with a BbRouter cookie", () => {
    const base = new URL("https://learn.example.edu");
    const router = { name: "BbRouter", value: '"expires%3A1760000000%2Cid%3AABC%2Cuser%3A4711%2Cxsrf%3Axyz-789"' };
    const jsession = { name: "JSESSIONID", value: "J1" };
    const at = (u: string, cookies: Cookie[]) => blackboard.loginResult(base, { url: new URL(u), cookies });
    const both = [router, jsession];
    expect(at("https://learn.example.edu/webapps/login/?action=relogin", both)).toBeNull();
    expect(at("https://learn.example.edu/auth-saml/saml/login?apId=_1_1", both)).toBeNull();
    expect(at("https://learn.example.edu/webapps/bb-auth-provider-shibboleth-BBLEARN/execute/shibbolethLogin", both)).toBeNull();
    expect(at("https://learn.example.edu/", both)).toBeNull();
    expect(at("https://idp.example.edu/idp/profile/SAML2/Redirect/SSO", both)).toBeNull();
    expect(at("https://learn.example.edu.evil.test/ultra/course", both)).toBeNull();
    expect(at("http://learn.example.edu/ultra/course", both)).toBeNull();
    expect(at("https://learn.example.edu/ultra/session-expired", both)).toBeNull();
    expect(at("https://learn.example.edu/ultra/course", [jsession])).toBeNull();
    expect(at("https://learn.example.edu/ultra/course", [{ name: "BbRouter", value: " " }])).toBeNull();
    for (const u of ["https://learn.example.edu/ultra/course", "https://learn.example.edu/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1"]) {
      const c = at(u, both)!;
      expect(c.cookies).toEqual(both);
      expect(c.csrf).toBe("xyz-789");
    }
    expect(at("https://learn.example.edu/ultra/stream", [{ name: "BbRouter", value: "expires:1,id:A,user:4711" }])!.csrf).toBeNull();
  });
});

describe("blackboard courses and content", () => {
  it("lists courses across pages with terms", async () => {
    const f = await fakeLearn([
      [ME, json(fixture("users_me"))],
      ["/learn/api/public/v1/users/_4711_1/courses?expand=course&limit=100", json(fixture("memberships_1"))],
      ["/learn/api/public/v1/users/_4711_1/courses?expand=course&limit=100&offset=100", json(fixture("memberships_2"))],
      ["/learn/api/public/v3/courses/_102_1", json(fixture("course_102_v3"))],
      ["/learn/api/public/v1/terms/_10_1", json(fixture("term_fall"))],
      ["/learn/api/public/v1/terms/_9_1", json(fixture("term_spring"))],
    ]);
    const got = await blackboard.courses(session(f.base));
    expect(got.map((c) => [c.id, c.name, c.code ?? null, c.term ?? null, c.current])).toEqual([
      ["_100_1", "Calculus II", "MATH-M212-FA26", "Fall 2026", true],
      ["_102_1", "Discrete Structures", "CSCI-C241-FA26", null, true],
      ["_103_1", "American History", "HIST-H105-FA26", null, false],
      ["_101_1", "Introductory Psychology", "PSY-P101-SP26", "Spring 2026", false],
    ]);
    expect(got.some((c) => c.id === "_200_1")).toBe(false);
    expect(f.log.filter((s) => s.target === "/learn/api/public/v1/terms/_10_1").length).toBe(1);
    const cookie = `BbRouter=${ROUTER}; JSESSIONID=J1`;
    expect(f.log.every((s) => s.method === "GET" && s.target.startsWith("/") && s.cookie === cookie)).toBe(true);
  });

  it("reads a whole course", async () => {
    const f = await fakeLearn(courseRoutes());
    const base = f.base;
    const s = session(base);
    const got = await blackboard.content(s, "_100_1");
    const b = (p: string) => `${base}${p}`;

    const pdf = b(`${C}/contents/_2_1/attachments/_501_1/download`);
    expect(got.syllabus).toContain("ISBN 978-1-947172-14-2");
    expect(got.syllabus).toContain(`<a href="${pdf}">M212 syllabus.pdf</a>`);

    expect(got.modules.map((m) => [m.name, m.items])).toEqual([
      ["Course content", ["Syllabus", "M212 syllabus.pdf", "OpenStax Calculus", "Homework 1", "lecture-notes.pdf", "Course tools"]],
      ["Week 1", ["Welcome", "Quiz 1"]],
      ["Week 1 / Readings", ["chapter1.pdf"]],
    ]);

    expect(got.pages.map((p) => p.title)).toEqual(["Week 1", "Syllabus", "Welcome"]);
    const welcome = got.pages[2];
    expect(welcome.html).toContain(`src="${base}/bbcswebdav/xid-78_1"`);
    expect(welcome.url?.href).toBe(b("/ultra/courses/_100_1/outline/edit/document/_7_1?courseId=_100_1"));

    expect(got.assignments.map((a) => [a.title, a.due, a.points])).toEqual([
      ["Homework 1", "2026-10-20T03:59:00.000Z", 10],
      ["Quiz 1", "2026-10-15T03:59:00.000Z", 20],
      ["Midterm exam", "2026-10-28T16:00:00.000Z", 100],
    ]);
    expect(got.assignments[0].html).toContain("Problems 1.1");
    expect(got.assignments[2].html).toContain("calculator");
    expect(got.assignments[2].url).toBeNull();

    expect(got.files.map((x) => [x.name, x.folder, x.url.href])).toEqual([
      ["M212 syllabus.pdf", null, pdf],
      ["lecture-notes.pdf", null, b(`${C}/contents/_5_1/attachments/_502_1/download`)],
      ["Week 1 slides.pdf", "Week 1", b("/bbcswebdav/pid-7-dt-content-rid-77_1/xid-77_1")],
      ["xid-78_1", "Week 1", b("/bbcswebdav/xid-78_1")],
      ["chapter1.pdf", "Week 1/Readings", b(`${C}/contents/_9_1/attachments/_503_1/download`)],
    ]);
    const ch1 = got.files[4];
    expect(ch1.mime).toBe("application/pdf");
    expect(ch1.aliases.map((a) => a.href)).toEqual([b(`${C}/contents/_9_1/attachments/_503_1`), b("/ultra/redirect?redirectType=nautilus&courseId=_100_1&contentId=_9_1&parentId=_6_1")]);

    expect(got.links.map((l) => [l.title, l.url.href])).toEqual([["OpenStax Calculus", "https://openstax.org/books/calculus-volume-2/pages/1-introduction"]]);

    expect(got.announcements.map((a) => [a.title, a.posted])).toEqual([
      ["Office hours moved", "2026-10-05T13:00:00.000Z"],
      ["Welcome to Calculus II", "2026-08-20T12:00:00.000Z"],
    ]);
    expect(got.announcements[0].html).toContain(`href="${base}/bbcswebdav/xid-90_1"`);
    expect(got.skipped).toEqual([]);

    const res = await s.get(ch1.url);
    expect((await res.bytes()).toString()).toBe("%PDF-1.7 chapter one");
    expect(f.log.some((x) => x.target.startsWith("/bbcswebdav/pid-9") && x.cookie !== undefined)).toBe(true);
    expect(f.log.every((x) => x.method === "GET")).toBe(true);
  });

  it("parts a course hides are skipped in plain words", async () => {
    const routes = courseRoutes().filter(([p]) => !p.includes("gradebook") && !p.includes("announcements") && !p.includes("_6_1/children"));
    routes.push(["/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100", bbStatus(403)]);
    routes.push(["/learn/api/public/v1/courses/_100_1/announcements?limit=100", bbStatus(403)]);
    routes.push(["/learn/api/public/v1/courses/_100_1/contents/_6_1/children?limit=200", bbStatus(403)]);
    const f = await fakeLearn(routes);
    const got = await blackboard.content(session(f.base), "_100_1");
    expect(got.skipped).toEqual([
      "Due dates from the grade book (the course site didn’t allow reading it)",
      "The folder “Readings” (the course site didn’t allow reading it)",
      "Announcements (the course site didn’t allow reading it)",
    ]);
    expect(got.announcements).toEqual([]);
    expect(got.assignments.map((a) => [a.title, a.due === null])).toEqual([
      ["Homework 1", true],
      ["Quiz 1", true],
    ]);
  });

  it("an incomplete listing stops the course instead of becoming a skipped line", async () => {
    for (const listing of ["/learn/api/public/v1/courses/_100_1/announcements?limit=100", "/learn/api/public/v1/courses/_100_1/contents/_6_1/children?limit=200"]) {
      const routes = courseRoutes().filter(([p]) => p !== listing);
      // A listing whose next page is itself: it can't be read in full.
      routes.push([listing, json({ results: [], paging: { nextPage: listing } })]);
      const f = await fakeLearn(routes);
      expect(await errKind(blackboard.content(session(f.base), "_100_1"))).toBe("incomplete");
    }
  });

  it("an external link with another scheme isn't a link", async () => {
    const root = JSON.parse(fixture("contents_root"));
    const ext = root.results.find((r: { contentHandler?: { id?: string } }) => r.contentHandler?.id === "resource/x-bb-externallink");
    ext.contentHandler.url = "javascript:alert(1)";
    const routes = courseRoutes().filter(([p]) => p !== "/learn/api/public/v1/courses/_100_1/contents?limit=200");
    routes.push(["/learn/api/public/v1/courses/_100_1/contents?limit=200", json(root)]);
    const f = await fakeLearn(routes);
    const got = await blackboard.content(session(f.base), "_100_1");
    expect(got.links).toEqual([]);
    expect(got.modules[0].items).toContain("OpenStax Calculus");
  });

  it("an ended session is signed out", async () => {
    for (const me of [bbStatus(401), bbStatus(403), loginPage(), redirect("/webapps/login/?new_loc=%2Fultra")]) {
      const f = await fakeLearn([
        [ME, me],
        ["/webapps/login/?new_loc=%2Fultra", loginPage()],
      ]);
      expect(await errKind(blackboard.courses(session(f.base)))).toBe("signedOut");
      expect(await errKind(blackboard.content(session(f.base), "_100_1"))).toBe("signedOut");
    }
    const routes = courseRoutes().filter(([p]) => !p.includes("_1_1/children"));
    routes.push(["/learn/api/public/v1/courses/_100_1/contents/_1_1/children?limit=200", bbStatus(401)]);
    const f = await fakeLearn(routes);
    expect(await errKind(blackboard.content(session(f.base), "_100_1"))).toBe("signedOut");
  });

  it("helpers", () => {
    const { rfc3339, enc, routerField } = blackboardInternals;
    expect(rfc3339(0)).toBe("1970-01-01T00:00:00Z");
    expect(rfc3339(1_791_590_400)).toBe("2026-10-10T00:00:00Z");
    expect(rfc3339(951_782_400 + 3661)).toBe("2000-02-29T01:01:01Z");
    expect(enc("_100_1")).toBe("_100_1");
    expect(enc("a/b c")).toBe("a%2Fb%20c");
    expect(routerField("user:1,xsrf:", "xsrf")).toBeNull();
  });

  it("pagination never silently returns a cycle or a capped list", async () => {
    for (const cycle of [true, false]) {
      const f = await serve((target) => {
        const n = Number(target.split("=").pop()) || 0;
        return json({ results: [], paging: { nextPage: `/pages?n=${cycle ? n : n + 1}` } });
      });
      sites.push(f);
      const s = new Session(Site.forTest("blackboard", f.base), { cookies: [], csrf: null });
      expect(await errKind(blackboardInternals.paged(s, "/pages?n=0"))).toBe("incomplete");
      expect(f.log.length).toBe(cycle ? 1 : blackboardInternals.MAX_PAGES);
    }
  });
});

describe("blackboard grades", () => {
  const COLS = "/learn/api/public/v2/courses/_100_1/gradebook/columns?limit=100";
  const MINE = "/learn/api/public/v2/courses/_100_1/gradebook/users/_4711_1?limit=100";
  const CATS = "/learn/api/public/v1/courses/_100_1/gradebook/categories";
  const gsession = (base: string) => new Session(Site.forTest("blackboard", base), { cookies: [{ name: "BbRouter", value: "expires:1,id:A,user:4711,xsrf:t" }], csrf: "t" });
  const me = () => json(fixture("users_me"));
  const categories = () => json('{"results":[{"id":"_31_1","title":"Labs","description":""},{"id":"_32_1","title":"Exams"}]}');

  it("columns and my grades", async () => {
    const f = await serve((t) => {
      if (t === ME) return me();
      if (t === COLS) return json(fixture("grades_columns"));
      if (t === MINE) return json(fixture("grades_mine"));
      if (t === CATS) return categories();
      return status(404);
    });
    sites.push(f);
    const g = await blackboard.grades(gsession(f.base), "_100_1");
    expect(g.current).toEqual({ percent: 86.4, letter: "B+", points: 432, possible: 500 });
    expect(g.groups).toEqual([{ name: "Labs" }, { name: "Exams" }]);
    expect(g.items.map((i) => i.title)).toEqual(["Lab 1", "Lab 2", "Exam 1"]);
    const lab1 = g.items[0];
    expect([lab1.score, lab1.possible, lab1.percent, lab1.grade]).toEqual([18, 20, 90, undefined]);
    expect(lab1.due).toBe("2026-09-12T03:59:00.000Z");
    expect(lab1.comments).toEqual(["Clear write-up. Label your axes."]);
    expect(lab1.graded && lab1.submitted).toBe(true);
    const lab2 = g.items[1];
    expect(lab2.submitted && !lab2.graded && lab2.score === undefined).toBe(true);
    expect([g.items[2].grade, g.items[2].group]).toEqual(["A-", "Exams"]);
    assertReadOnlyWithSession(f.log, "BbRouter=");
  });

  it("one column at a time when the list is refused", async () => {
    const f = await serve((t) => {
      if (t === ME) return me();
      if (t === COLS) return json(fixture("grades_columns"));
      if (t === MINE) return status(403);
      if (t === "/learn/api/public/v2/courses/_100_1/gradebook/columns/_802_1/users/_4711_1") {
        return json('{"userId":"_4711_1","columnId":"_802_1","status":"Graded","score":17.0,"displayGrade":{"scaleType":"Score","score":17.0,"text":"17"}}');
      }
      return status(404);
    });
    sites.push(f);
    const g = await blackboard.grades(gsession(f.base), "_100_1");
    expect(g.items.find((i) => i.title === "Lab 1")!.score).toBe(17);
    expect(g.items.filter((i) => i.title !== "Lab 1").every((i) => i.score === undefined)).toBe(true);
    expect(g.groups).toEqual([]);
  });

  it("refused is empty with a note and signed out is an error", async () => {
    let f = await serve((t) => (t === ME ? me() : status(403)));
    sites.push(f);
    const g = await blackboard.grades(gsession(f.base), "_100_1");
    expect(g.note).toBe(GRADES_HIDDEN);
    expect(g.items).toEqual([]);
    f = await serve((t) => (t.startsWith("/webapps/login") ? html("<form></form>") : redirect("/webapps/login/")));
    sites.push(f);
    expect(await errKind(blackboard.grades(gsession(f.base), "_100_1"))).toBe("signedOut");
  });
});
