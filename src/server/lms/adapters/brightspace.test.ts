import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../session.ts";
import { assertReadOnlyWithSession, bytes, html, json, redirect, serve, status, type FakeSite, type Reply } from "../testing/fake-site.ts";
import { GRADES_HIDDEN, LmsError, Site, type Cookie } from "../types.ts";
import { after, brightspace, dispositionName, fileName, MAX_PAGES, objects } from "./brightspace.ts";

const fx = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/brightspace", name), "utf8");

const LP = "/d2l/api/lp/1.49";
const LE = "/d2l/api/le/1.82/6606";
const COOKIES = "d2lSessionVal=s3ss10n; d2lSecureSessionVal=s3cur3";

const sites: FakeSite[] = [];
afterEach(async () => {
  while (sites.length) await sites.pop()!.close();
});

function siteRoutes(): Map<string, Reply> {
  const r = new Map<string, Reply>();
  r.set("/d2l/api/versions/", json(fx("versions.json")));
  r.set(`${LP}/users/whoami`, json(fx("whoami.json")));
  r.set(`${LP}/enrollments/myenrollments/?orgUnitTypeId=3`, json(fx("enrollments-1.json")));
  r.set(`${LP}/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=6606`, json(fx("enrollments-2.json")));
  r.set(`${LP}/courses/6606`, json(fx("course-6606.json")));
  // Students are often refused course offering details.
  r.set(`${LP}/courses/6610`, status(403));
  r.set(`${LE}/content/toc`, json(fx("toc.json")));
  r.set("/content/enforced/6606-M301-F26-12345/Week1/welcome.html", html(fx("welcome.html")));
  r.set(`${LE}/overview`, json(fx("overview.json")));
  r.set(`${LE}/overview/attachment`, bytes("application/pdf", "%PDF-1.4\n", { "content-disposition": 'attachment; filename="M301 Syllabus Fall 2026.pdf"' }));
  r.set(`${LE}/dropbox/folders/`, json(fx("dropbox.json")));
  r.set(`${LE}/quizzes/`, json(fx("quizzes.json")));
  r.set(`${LE}/quizzes/?bookmark=QB-8`, json(fx("quizzes-2.json")));
  r.set(`${LE}/news/`, json(fx("news.json")));
  r.set("/d2l/login?sessionExpired=1", html(fx("login-stub.html")));
  return r;
}

async function serveRoutes(routes: Map<string, Reply>): Promise<FakeSite> {
  const site = await serve((target) => routes.get(target) ?? status(404));
  sites.push(site);
  return site;
}

async function serveFn(route: (t: string) => Reply): Promise<FakeSite> {
  const site = await serve(route);
  sites.push(site);
  return site;
}

function session(base: string, cookies?: Cookie[]): Session {
  const list =
    cookies ??
    COOKIES.split("; ").map((kv) => {
      const [name, value] = kv.split("=");
      return { name, value };
    });
  return new Session(Site.forTest("brightspace", base), { cookies: list, csrf: null });
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof LmsError ? e.kind : `thrown: ${String(e)}`;
  }
}

describe("brightspace", () => {
  it("courses follow the bookmark and read the semester", async () => {
    const f = await serveRoutes(siteRoutes());
    const list = await brightspace.courses(session(f.base));
    expect(list.length).toBe(2);
    expect(list[0]).toEqual({ id: "6606", name: "Calculus II", code: "M301-F26-12345", term: "Fall 2026", current: true });
    // Offering refused: no semester, and the enrollment's dates (ended in 2025) decide.
    expect(list[1].id).toBe("6610");
    expect(list[1].term).toBeNull();
    expect(list[1].current).toBe(false);
    expect(f.log.some((s) => s.target.endsWith("orgUnitTypeId=3&bookmark=6606"))).toBe(true);
    expect(f.log.every((s) => s.cookie === COOKIES)).toBe(true);
  });

  it("content reads modules, files, pages, links, assignments and news", async () => {
    const f = await serveRoutes(siteRoutes());
    const c = await brightspace.content(session(f.base), "6606");
    const b = new URL(f.base);
    expect(c.skipped).toEqual([]);

    expect(c.modules.map((m) => [m.name, m.items])).toEqual([
      ["Week 1: Integration review", ["Course Syllabus.pdf", "Welcome"]],
      ["Week 1: Integration review / Readings", ["OpenStax Calculus Volume 2", "Section 3.1 notes.pdf"]],
      ["Week 2: Series", ["Homework 1 (submit here)", "Pearson MyLab"]],
    ]);

    const notes = c.files.find((x) => x.name === "Section 3.1 notes.pdf")!;
    expect(notes.folder).toBe("Week 1: Integration review/Readings");
    expect(notes.url.href).toBe(new URL(`${LE}/content/topics/1102/file`, b).href);
    const aliases = notes.aliases.map((u) => u.href);
    expect(aliases).toContain(new URL("/content/enforced/6606-M301-F26-12345/Week1/Readings/3.1%20notes.pdf", b).href);
    expect(aliases).toContain(new URL("/d2l/le/content/6606/viewContent/1102/View", b).href);
    expect(c.files.some((x) => x.name.includes("Answer key"))).toBe(false);
    const names = c.files.map((x) => [x.name, x.folder]);
    for (const want of [
      ["Course Syllabus.pdf", "Week 1: Integration review"],
      ["M301 Syllabus Fall 2026.pdf", null],
      ["hw1.pdf", "Assignments/Homework 1"],
      ["Week 1 slides.pptx", "Announcements"],
    ]) {
      expect(names).toContainEqual(want);
    }
    expect(c.files.length).toBe(5);
    expect(c.files.find((x) => x.name === "hw1.pdf")!.url.href).toBe(new URL(`${LE}/dropbox/folders/41/attachments/9001`, b).href);
    expect(c.files.find((x) => x.name === "Week 1 slides.pptx")!.url.href).toBe(new URL(`${LE}/news/501/attachments/77`, b).href);

    expect(c.pages.length).toBe(1);
    expect(c.pages[0].title).toBe("Welcome");
    expect(c.pages[0].html).toContain("Welcome to Calculus II");
    expect(c.pages[0].url?.href).toBe(new URL("/content/enforced/6606-M301-F26-12345/Week1/welcome.html", b).href);

    expect(c.links.length).toBe(1);
    expect(c.links[0].url.href).toBe("https://openstax.org/details/books/calculus-volume-2");

    const syl = c.syllabus!;
    expect(syl).toContain("integration techniques");
    expect(syl).toContain(`${LE}/overview/attachment`);
    expect(syl).toContain("M301 Syllabus Fall 2026.pdf");

    expect(c.assignments.map((a) => [a.title, a.due])).toEqual([
      ["Homework 1", "2026-09-05T03:59:00.000Z"],
      ["Final project draft", null],
      ["Quiz 1: Integration by parts", "2026-09-12T03:59:00.000Z"],
      ["Quiz 2: Series", "2026-10-03T03:59:00.000Z"],
    ]);
    expect(c.assignments[0].points).toBe(20);
    expect(c.assignments[0].html).toContain("1&ndash;15 odd");
    expect(c.assignments[0].html).toContain("hw1.pdf");
    expect(c.assignments[0].url?.href).toBe(new URL("/d2l/lms/dropbox/user/folder_submit_files.d2l?db=41&ou=6606", b).href);
    expect(c.assignments[3].html).toBe("<p>Covers chapter 5</p>");

    expect(c.announcements.length).toBe(1);
    expect(c.announcements[0].title).toBe("Welcome to M301");
    expect(c.announcements[0].posted).toBe("2026-08-24T13:00:00.000Z");
    expect(c.announcements[0].html).toContain("<strong>Tuesdays</strong>");
    expect(c.announcements[0].html).toContain("Week 1 slides.pptx");
  });

  it("syllabus falls back to the topic and refused parts are skipped", async () => {
    const r = siteRoutes();
    r.delete(`${LE}/overview`);
    r.set(`${LE}/dropbox/folders/`, status(403));
    r.set(`${LE}/news/`, status(500));
    const f = await serveRoutes(r);
    const c = await brightspace.content(session(f.base), "6606");
    expect(c.syllabus).toContain(`${LE}/content/topics/1001/file`);
    expect(c.syllabus).toContain("Course Syllabus.pdf");
    expect(c.skipped).toEqual(["Assignments couldn’t be read.", "Announcements couldn’t be read."]);
    expect(c.assignments.length).toBe(2);
    expect(c.modules.length).toBe(3);
  });

  it("an ended session is signed out", async () => {
    const whoami = `${LP}/users/whoami`;
    const cases: [string, () => Reply][] = [
      ["whoami refused", () => status(403)],
      ["whoami 401", () => status(401)],
      ["redirect to the login page", () => redirect("/d2l/login?sessionExpired=1")],
      ["login stub instead of JSON", () => html(fx("login-stub.html"))],
    ];
    for (const [what, reply] of cases) {
      const r = siteRoutes();
      r.set(whoami, reply());
      const f = await serveRoutes(r);
      expect(await kindOf(brightspace.courses(session(f.base))), `courses: ${what}`).toBe("signedOut");
      expect(await kindOf(brightspace.content(session(f.base), "6606")), `content: ${what}`).toBe("signedOut");
    }
    let r = siteRoutes();
    r.set(`${LE}/content/toc`, status(401));
    let f = await serveRoutes(r);
    expect(await kindOf(brightspace.content(session(f.base), "6606"))).toBe("signedOut");
    r = siteRoutes();
    r.set("/content/enforced/6606-M301-F26-12345/Week1/welcome.html", redirect("/d2l/login?sessionExpired=1"));
    f = await serveRoutes(r);
    expect(await kindOf(brightspace.content(session(f.base), "6606"))).toBe("signedOut");
    r = siteRoutes();
    r.set(`${LP}/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=6606`, html(fx("login-stub.html")));
    f = await serveRoutes(r);
    expect(await kindOf(brightspace.courses(session(f.base)))).toBe("signedOut");
  });

  it("a course id is digits only", async () => {
    const f = await serveRoutes(siteRoutes());
    for (const bad of ["", "../6606", "6606/content", "66 06"]) {
      expect(await kindOf(brightspace.content(session(f.base), bad)), bad).toBe("notFound");
    }
    expect(f.log).toEqual([]);
  });

  it("no versions offered is unsupported", async () => {
    const r = siteRoutes();
    r.set("/d2l/api/versions/", json('[{"ProductCode":"lp","LatestVersion":"1.49","SupportedVersions":[]}]'));
    const f = await serveRoutes(r);
    expect(await kindOf(brightspace.courses(session(f.base)))).toBe("unsupported");
  });

  it("signed in only past the login with both session cookies", () => {
    const base = new URL("https://school.brightspace.com");
    expect(brightspace.loginUrl(base).href).toBe("https://school.brightspace.com/d2l/login");
    const c = (name: string, value: string) => ({ name, value });
    const both = [c("d2lSessionVal", "a"), c("d2lSecureSessionVal", "b"), c("clientId", "c"), c("empty", "")];
    const at = (u: string, cookies: Cookie[]) => brightspace.loginResult(base, { url: new URL(u), cookies });

    const got = at("https://school.brightspace.com/d2l/home", both)!;
    expect(got.csrf).toBeNull();
    expect(got.cookies).toEqual(both.slice(0, 3));
    expect(at("https://school.brightspace.com/d2l/home/6606", both)).not.toBeNull();
    for (const u of [
      "https://school.brightspace.com/d2l/login",
      "https://school.brightspace.com/d2l/login?sessionExpired=1",
      "https://school.brightspace.com/d2l/lp/auth/login/ProcessLoginActions.d2l",
      "https://school.brightspace.com/d2l/lp/auth/saml/initiate-login?entityId=x",
      "https://school.brightspace.com/d2l/logout",
      "https://login.microsoftonline.com/d2l/home",
      "http://school.brightspace.com/d2l/home",
    ]) {
      expect(at(u, both), u).toBeNull();
    }
    expect(at("https://school.brightspace.com/d2l/home", both.slice(0, 1))).toBeNull();
    expect(at("https://school.brightspace.com/d2l/home", [c("d2lSessionVal", "a"), c("d2lSecureSessionVal", "")])).toBeNull();
  });

  it("incomplete quiz pagination stops the course instead of skipping it", async () => {
    const r = siteRoutes();
    r.set(`${LE}/quizzes/`, json('{"Objects":[],"Next":"repeat"}'));
    r.set(`${LE}/quizzes/?bookmark=repeat`, json('{"Objects":[],"Next":"repeat"}'));
    const f = await serveRoutes(r);
    expect(await kindOf(brightspace.content(session(f.base, []), "6606"))).toBe("incomplete");
  });

  it("paged dropbox folders include the last page, without asking for page one twice", async () => {
    const r = siteRoutes();
    r.set(`${LE}/dropbox/folders/`, json('{"Objects":[{"Id":1,"Name":"First"}],"Next":"second"}'));
    r.set(`${LE}/dropbox/folders/?bookmark=second`, json('{"Objects":[{"Id":2,"Name":"Last"}],"Next":null}'));
    const f = await serveRoutes(r);
    const c = await brightspace.content(session(f.base, []), "6606");
    expect(c.assignments.some((a) => a.title === "First")).toBe(true);
    expect(c.assignments.some((a) => a.title === "Last")).toBe(true);
    expect(f.log.filter((s) => s.target === `${LE}/dropbox/folders/`).length).toBe(1);
  });

  it("an unreadable later page of dropbox folders only skips assignments", async () => {
    const r = siteRoutes();
    r.set(`${LE}/dropbox/folders/`, json('{"Objects":[{"Id":1,"Name":"First"}],"Next":"second"}'));
    r.set(`${LE}/dropbox/folders/?bookmark=second`, json('{"Objects":"nonsense","Next":null}'));
    const f = await serveRoutes(r);
    const c = await brightspace.content(session(f.base, []), "6606");
    expect(c.skipped).toEqual(["Assignments couldn’t be read."]);
    expect(c.assignments.map((a) => a.title)).toEqual(["Quiz 1: Integration by parts", "Quiz 2: Series"]);
  });

  it("names from titles and headers", () => {
    const at = new URL("https://s.example/content/enforced/1-X/Week1/3.1%20notes.pdf");
    expect(fileName("Section 3.1 notes", at)).toBe("Section 3.1 notes.pdf");
    expect(fileName("notes.PDF", at)).toBe("notes.PDF");
    expect(fileName("Unit 1/2 slides", at)).toBe("Unit 1-2 slides.pdf");
    expect(fileName("", at)).toBe("3.1 notes.pdf");
    expect(dispositionName('attachment; filename="Syllabus.pdf"')).toBe("Syllabus.pdf");
    expect(dispositionName("attachment; filename=\"x.pdf\"; filename*=UTF-8''Caf%C3%A9%20syllabus.pdf")).toBe("Café syllabus.pdf");
    expect(dispositionName("inline")).toBeNull();
    expect(after("2026-12-20T04:59:00.000Z", "2026-10-10T14:03:00Z")).toBe(true);
    expect(after("2025-05-10T03:59:00.000Z", "2026-10-10T14:03:00Z")).toBe(false);
  });

  it("courses refuse repeated, missing or capped bookmarks", async () => {
    for (const mode of ["cycle", "missing", "metadata", "more-metadata", "cap"]) {
      const f = await serveFn((p) => {
        if (p === "/d2l/api/versions/") return json(fx("versions.json"));
        if (p.endsWith("/users/whoami")) return json('{"Identifier":"fixture-user"}');
        if (p.includes("/enrollments/myenrollments/")) {
          if (mode === "metadata") return json('{"Items":[]}');
          if (mode === "more-metadata") return json('{"Items":[],"PagingInfo":{"Bookmark":"next"}}');
          const n = Number(p.split("bookmark=")[1] ?? "0") || 0;
          const bookmark = mode === "missing" ? null : mode === "cycle" ? "again" : String(n + 1);
          return json({ Items: [], PagingInfo: { HasMoreItems: true, Bookmark: bookmark } });
        }
        return status(404);
      });
      expect(await kindOf(brightspace.courses(session(f.base, []))), mode).toBe("incomplete");
      const count = f.log.filter((s) => s.target.includes("/enrollments/myenrollments/")).length;
      expect(count, mode).toBe(mode === "cap" ? MAX_PAGES : mode === "cycle" ? 2 : 1);
    }
  });

  it("object lists refuse repeated, missing, unsafe or capped continuations", async () => {
    for (const mode of ["cycle", "missing", "empty", "unsafe", "cap", "complete"]) {
      const f = await serveFn((p) => {
        if (mode === "missing") return json('{"Objects":[]}');
        const n = Number(p.split("bookmark=")[1] ?? "0") || 0;
        const next = mode === "cycle" ? "again" : mode === "empty" ? "" : mode === "unsafe" ? "https://other.invalid/d2l/api/le/items" : mode === "complete" ? null : String(n + 1);
        return json({ Objects: [], Next: next });
      });
      const result = objects(session(f.base, []), "/d2l/api/le/1.82/6606/quizzes/");
      if (mode === "complete") expect(await result).toEqual([]);
      else expect(await kindOf(result), mode).toBe("incomplete");
      expect(f.log.length, mode).toBe(mode === "cap" ? MAX_PAGES : mode === "cycle" ? 2 : 1);
    }
  });
});

describe("brightspace grades", () => {
  const common = (t: string): Reply | null => {
    if (t === "/d2l/api/versions/") return json(fx("versions.json"));
    if (t === "/d2l/api/lp/1.49/users/whoami") return json(fx("whoami.json"));
    return null;
  };

  it("released grades with weights; the final grade value is the final grade", async () => {
    const f = await serveFn((t) => {
      const c = common(t);
      if (c) return c;
      switch (t.startsWith(LE) ? t.slice(LE.length) : "") {
        case "/grades/values/myGradeValues/":
          return json(fx("my-grade-values.json"));
        case "/grades/final/values/myGradeValue":
          return json(fx("my-final-grade.json"));
        case "/grades/categories/":
          return json(fx("grade-categories.json"));
        case "/grades/setup/":
          return json('{"GradingSystem":"Weighted","IsNullGradeZero":false,"DefaultGradeSchemeId":12}');
        // Students are often refused the grade object list: the categories still name things.
        case "/grades/":
          return status(403);
        default:
          return status(404);
      }
    });
    const g = await brightspace.grades(session(f.base), "6606");
    // Changed from the Rust port: D2L's final grade value goes to `final`, not `current`.
    expect(g.current).toEqual({});
    expect(g.final).toEqual({ percent: 86.5, letter: "B+", points: 86.5, possible: 100 });
    expect(g.groups).toEqual([
      { name: "Exams", weight: 60 },
      { name: "Problem Sets", weight: 40 },
    ]);
    expect(g.items.map((i) => i.title)).toEqual(["Problem Set 1", "Midterm", "Final Exam", "Problem Set 2"]);
    const ps1 = g.items[0];
    expect([ps1.score, ps1.possible, ps1.percent]).toEqual([18, 20, 90]);
    expect(ps1.group).toBe("Problem Sets");
    expect(ps1.graded).toBe(true);
    expect(ps1.grade).toBeUndefined();
    expect(ps1.comments).toEqual(["Good work. Show the steps next time."]);
    expect(g.items[1].grade).toBe("B");
    const fe = g.items[2];
    expect(fe.graded).toBe(false);
    expect(fe.score).toBeUndefined();
    expect(fe.possible).toBe(50);
    expect(fe.group).toBe("Exams");
    assertReadOnlyWithSession(f.log, "d2lSessionVal=s3ss10n");
  });

  it("a refused grade book is empty with a note, and an ended session is signed out", async () => {
    let f = await serveFn((t) => common(t) ?? status(403));
    const g = await brightspace.grades(session(f.base), "6606");
    expect(g.note).toBe(GRADES_HIDDEN);
    expect(g.items).toEqual([]);
    expect(g.groups).toEqual([]);

    f = await serveFn((t) => {
      if (t === "/d2l/api/versions/") return json(fx("versions.json"));
      if (t === "/d2l/login?sessionExpired=1") return html("<html>Login</html>");
      return redirect("/d2l/login?sessionExpired=1");
    });
    expect(await kindOf(brightspace.grades(session(f.base), "6606"))).toBe("signedOut");
    expect(await kindOf(brightspace.grades(session(f.base), "66/06"))).toBe("notFound");
  });
});
