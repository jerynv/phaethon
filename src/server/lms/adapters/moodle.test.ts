import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Session } from "../session.ts";
import { assertReadOnlyWithSession, html, redirect, serve, status, type FakeSite, type Reply, type Seen } from "../testing/fake-site.ts";
import { GRADES_HIDDEN, LmsError, Site, type Cookie, type CourseContent } from "../types.ts";
import { ajaxError, attr, findSesskey, hasWord, inner, moodle, openTags, parseCoursePage, rfc3339, text } from "./moodle.ts";
import { percentDecode } from "../types.ts";

const SESSKEY = "Xq7Lm2Pz9K";
const raw = (name: string) => fs.readFileSync(path.join(import.meta.dirname, "fixtures/moodle", `${name}.html`), "utf8");
const fixture = (name: string, base: string) => raw(name).replaceAll("{BASE_ESCAPED}", base.replaceAll("/", "\\/")).replaceAll("{BASE}", base);

const sites: FakeSite[] = [];
afterEach(async () => {
  while (sites.length) await sites.pop()!.close();
});

type Behaviour = { signedOut?: boolean; noState?: boolean; ajaxError?: string; gonePage?: boolean };

const ok = (data: unknown) => [{ error: false, data }];
const err = (code: string) => [{ error: true, exception: { message: `Error: ${code}`, errorcode: code, link: "", moreinfourl: "" } }];

function coursesJson() {
  return {
    courses: [
      {
        id: 7,
        fullname: "C241 Discrete Structures for Computer Science",
        shortname: "C241-FA26",
        idnumber: "",
        summary: "<p>Logic, sets, proofs &amp; counting.</p>",
        summaryformat: 1,
        startdate: 1_756_684_800,
        enddate: 0,
        visible: true,
        hidden: false,
        coursecategory: "Fall 2026",
      },
      { id: 3, fullname: "M211 Calculus I", shortname: "M211-SP26", summary: "", startdate: 1_735_689_600, enddate: 1_747_000_000, visible: true, hidden: true, coursecategory: "Spring 2026" },
      { id: 9, fullname: "Research &amp; Writing", shortname: "", summary: "", startdate: 4_102_444_800, enddate: 0, coursecategory: "" },
    ],
    nextoffset: 3,
  };
}

function stateJson(base: string): Record<string, unknown> {
  return {
    course: { id: "7", numsections: 1, sectionlist: ["50", "51"], editmode: false, baseurl: `${base}/course/view.php?id=7` },
    section: [
      { id: "50", section: 0, number: 0, title: "General", hassummary: false, rawtitle: null, cmlist: ["100", "101", "102"], visible: true },
      { id: "51", section: 1, number: 1, title: "Week 1: Logic &amp; Proofs", hassummary: true, rawtitle: "Week 1: Logic & Proofs", cmlist: ["103", "104", "105", "106", "107"], visible: true },
    ],
    cm: [
      { id: "100", name: "Announcements", visible: true, uservisible: true, sectionid: "50", modname: "Forum", module: "forum", url: `${base}/mod/forum/view.php?id=100` },
      { id: "101", name: "Course syllabus", visible: true, uservisible: true, sectionid: "50", module: "resource", url: `${base}/mod/resource/view.php?id=101` },
      { id: "102", name: "Office hours: Tue 2–4pm", visible: true, uservisible: true, sectionid: "50", module: "label" },
      { id: "103", name: "Reading guide", visible: true, uservisible: true, sectionid: "51", module: "page", url: `${base}/mod/page/view.php?id=103` },
      { id: "104", name: "Open textbook: Discrete Math", visible: true, uservisible: true, sectionid: "51", module: "url", url: `${base}/mod/url/view.php?id=104` },
      { id: "105", name: "Homework 1", visible: true, uservisible: true, sectionid: "51", module: "assign", url: `${base}/mod/assign/view.php?id=105` },
      { id: "106", name: "Lecture slides", visible: true, uservisible: true, sectionid: "51", module: "folder", url: `${base}/mod/folder/view.php?id=106` },
      { id: "107", name: "Quiz 1 (opens after Homework 1)", visible: true, uservisible: false, sectionid: "51", module: "quiz", url: `${base}/mod/quiz/view.php?id=107` },
    ],
  };
}

function eventsJson(base: string) {
  return {
    events: [
      {
        id: 5001,
        name: "Homework 1 is due",
        modulename: "assign",
        instance: 31,
        eventtype: "due",
        timestart: 1_792_295_940,
        timesort: 1_792_295_940,
        overdue: false,
        url: `${base}/mod/assign/view.php?id=105`,
        action: { name: "Add submission", url: "", itemcount: 1, actionable: true },
      },
    ],
    firstid: 5001,
    lastid: 5001,
  };
}

function postsJson(discussion: number) {
  const [subject, message, at] =
    discussion === 902
      ? ["Test 1 moved", "<p>Test 1 is now on <strong>October 16</strong>.</p>", 1_791_554_400]
      : ["Welcome to C241", "<p>Welcome! The syllabus is in General.</p>", 1_787_576_400];
  return {
    posts: [
      { id: discussion * 10, subject, replysubject: `Re: ${subject}`, message, messageformat: 1, discussionid: discussion, hasparent: false, parentid: null, timecreated: at, timemodified: at },
      { id: discussion * 10 + 1, subject: `Re: ${subject}`, message: "<p>Thanks!</p>", discussionid: discussion, hasparent: true, parentid: discussion * 10, timecreated: at + 60 },
    ],
    forumid: 12,
    courseid: 7,
  };
}

function route(b: Behaviour, base: string, req: Seen): Reply {
  const page = (name: string) => html(fixture(name, base));
  const [p, query = ""] = req.target.split(/\?(.*)/s);
  if (req.method === "GET" && p === "/my/") return b.signedOut ? redirect(`${base}/login/index.php`, 303) : page("my");
  if (req.method === "GET" && p === "/login/index.php") return page("login");
  if (req.method === "POST" && p === "/lib/ajax/service.php") {
    const q = new URLSearchParams(query);
    const call = JSON.parse(req.body)[0];
    if (q.get("info") !== call.methodname) throw new Error("info names the function");
    let out: unknown;
    if (q.get("sesskey") !== SESSKEY) out = err("invalidsesskey");
    else if (b.ajaxError) out = err(b.ajaxError);
    else {
      switch (call.methodname) {
        case "core_course_get_enrolled_courses_by_timeline_classification":
          out = ok(coursesJson());
          break;
        case "core_courseformat_get_state": {
          if (b.noState) out = err("servicenotavailable");
          else if (b.gonePage) {
            const state = stateJson(base) as { cm: unknown[]; section: { cmlist: string[] }[] };
            state.cm.push({ id: "108", name: "Gone page", uservisible: true, module: "page", url: `${base}/mod/page/view.php?id=108` });
            state.section[1].cmlist.push("108");
            out = ok(JSON.stringify(state));
          } else out = ok(JSON.stringify(stateJson(base)));
          break;
        }
        case "core_calendar_get_action_events_by_course":
          out = ok(eventsJson(base));
          break;
        case "mod_forum_get_discussion_posts":
          out = ok(postsJson(call.args.discussionid));
          break;
        default:
          out = err("servicenotavailable");
      }
    }
    return { status: 200, ctype: "application/json; charset=utf-8", body: JSON.stringify(out) };
  }
  if (req.method === "GET") {
    const routes: Record<string, string> = {
      "/course/view.php?id=7": "course",
      "/mod/resource/view.php?id=101&forceview=1": "resource",
      "/mod/page/view.php?id=103": "page",
      "/mod/url/view.php?id=104&forceview=1": "url",
      "/mod/assign/view.php?id=105": "assign",
      "/mod/forum/view.php?id=100": "forum",
      "/mod/folder/view.php?id=106": "folder",
    };
    const name = routes[req.target];
    if (name) return page(name);
  }
  return { status: 404, ctype: "text/html", body: "<h1>Not found</h1>" };
}

type Fake = { base: string; log: Seen[]; session: () => Session };

async function fake(b: Behaviour = {}): Promise<Fake> {
  let base = "";
  const site = await serve((_t, req) => route(b, base, req));
  base = site.base;
  sites.push(site);
  return {
    base,
    log: site.log,
    session: () =>
      new Session(Site.forTest("moodle", base), {
        cookies: [
          { name: "MoodleSession", value: "s3ss10n" },
          { name: "BIGipServerMoodle", value: "lb1" },
        ],
        csrf: null,
      }),
  };
}

async function failure(p: Promise<unknown>): Promise<LmsError | string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof LmsError ? e : `thrown: ${String(e)}`;
  }
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  const e = await failure(p);
  return typeof e === "string" ? e : e.kind;
}

const cookie = (name: string, value: string): Cookie => ({ name, value });

describe("moodle sign-in", () => {
  it("login opens the site's own login page", () => {
    expect(moodle.loginUrl(new URL("https://moodle.iu.edu")).href).toBe("https://moodle.iu.edu/login/index.php");
  });

  it("signed in only back on the site past the login pages with a session", () => {
    const base = new URL("https://moodle.iu.edu");
    const session = [cookie("MoodleSession", "abc"), cookie("MOODLEID1_", "x")];
    const at = (u: string, cookies: Cookie[]) => moodle.loginResult(base, { url: new URL(u), cookies });
    expect(at("https://moodle.iu.edu/login/index.php", session)).toBeNull();
    expect(at("https://idp.iu.edu/idp/profile/SAML2/Redirect/SSO?execution=e1s1", session)).toBeNull();
    expect(at("https://moodle.iu.edu/auth/saml2/sp/saml2-acs.php/moodle.iu.edu", session)).toBeNull();
    expect(at("https://moodle.iu.edu/admin/tool/mfa/auth.php", session)).toBeNull();
    expect(at("https://moodle.iu.edu/user/policy.php", session)).toBeNull();
    expect(at("https://evil.example/my/", session)).toBeNull();
    expect(at("https://moodle.iu.edu/my/", [cookie("MOODLEID1_", "x")])).toBeNull();
    expect(at("https://moodle.iu.edu/my/", [cookie("MoodleSession", "")])).toBeNull();
    const got = at("https://moodle.iu.edu/my/", session)!;
    expect(got.cookies).toEqual(session);
    expect(got.csrf).toBeNull();
    expect(at("https://moodle.iu.edu/", [cookie("MoodleSessionprod", "abc")])).not.toBeNull();
  });
});

describe("moodle courses", () => {
  it("courses through the AJAX service with the page's sesskey", async () => {
    const f = await fake();
    const list = await moodle.courses(f.session());
    expect(list.length).toBe(3);
    expect(list[0]).toEqual({ id: "7", name: "C241 Discrete Structures for Computer Science", code: "C241-FA26", term: "Fall 2026", current: true });
    expect(list[1].current).toBe(false);
    expect(list[2].current).toBe(false);
    expect(list[2].name).toBe("Research & Writing");
    expect([list[2].code, list[2].term]).toEqual([null, null]);

    expect([f.log[0].method, f.log[0].target]).toEqual(["GET", "/my/"]);
    const call = f.log[1];
    expect(call.method).toBe("POST");
    expect(call.target).toBe(`/lib/ajax/service.php?sesskey=${SESSKEY}&info=core_course_get_enrolled_courses_by_timeline_classification`);
    const body = JSON.parse(call.body);
    expect(body[0].index).toBe(0);
    expect(body[0].args.classification).toBe("allincludinghidden");
    for (const r of f.log) expect(r.cookie, r.target).toBe("MoodleSession=s3ss10n; BIGipServerMoodle=lb1");
  });

  it("a dashboard that sends you to log in means signed out", async () => {
    const f = await fake({ signedOut: true });
    expect(await kindOf(moodle.courses(f.session()))).toBe("signedOut");
    expect(await kindOf(moodle.content(f.session(), "7"))).toBe("signedOut");
    expect(f.log.every((r) => r.method === "GET")).toBe(true);
  });

  it("AJAX session errors mean signed out, and others say what happened", async () => {
    for (const code of ["servicerequireslogin", "invalidsesskey"]) {
      const f = await fake({ ajaxError: code });
      expect(await kindOf(moodle.courses(f.session())), code).toBe("signedOut");
      expect(await kindOf(moodle.content(f.session(), "7")), code).toBe("signedOut");
    }
    const f = await fake({ ajaxError: "requireloginerror" });
    expect(await kindOf(moodle.courses(f.session()))).toBe("forbidden");
    expect(ajaxError("invalidsesskey", "").kind).toBe("signedOut");
    expect(ajaxError("servicenotavailable", "").kind).toBe("unsupported");
    const e = ajaxError("x", "Can&#39;t do that");
    expect([e.kind, e.message]).toEqual(["other", "Your course site answered with an error: Can't do that"]);
  });

  it("a course id that isn't a number is refused before any request", async () => {
    const f = await fake();
    expect(await kindOf(moodle.content(f.session(), "../admin"))).toBe("notFound");
    expect(f.log).toEqual([]);
  });
});

function checkContent(c: CourseContent, base: string): void {
  expect(c.modules.map((m) => [m.name, m.items])).toEqual([
    ["General", ["Announcements", "Course syllabus"]],
    ["Week 1: Logic & Proofs", ["Reading guide", "Open textbook: Discrete Math", "Homework 1", "Lecture slides"]],
  ]);
  const syllabus = `${base}/pluginfile.php/401/mod_resource/content/3/C241%20Syllabus%20Fall%202026.pdf`;
  const l1 = `${base}/pluginfile.php/406/mod_folder/content/0/Lecture%201%20-%20Propositions.pdf`;
  const l3 = `${base}/pluginfile.php/406/mod_folder/content/0/Week%202/Lecture%203%20-%20Sets.pptx`;
  expect(c.files.map((f) => [f.name, f.folder, f.url.href])).toEqual([
    ["C241 Syllabus Fall 2026.pdf", "General", syllabus],
    ["Lecture 1 - Propositions.pdf", "Week 1: Logic & Proofs/Lecture slides", l1],
    ["Lecture 3 - Sets.pptx", "Week 1: Logic & Proofs/Lecture slides/Week 2", l3],
  ]);
  expect(c.files[0].aliases.map((u) => u.href)).toContain(`${base}/mod/resource/view.php?id=101`);

  expect(c.pages.length).toBe(1);
  const page = c.pages[0];
  expect(page.title).toBe("Reading guide");
  expect(page.url?.href).toBe(`${base}/mod/page/view.php?id=103`);
  expect(page.html.startsWith('<div class="no-overflow"><p>Read <strong>chapters 1&ndash;2</strong>')).toBe(true);
  expect(page.html).toContain("ISBN 978-0-9940479-1-4");
  expect(page.html).toContain("/mod_page/content/2/solutions.pdf");
  expect(page.html).not.toContain("Last modified");

  expect(c.links.length).toBe(1);
  expect(c.links[0].title).toBe("Open textbook: Discrete Math");
  expect(c.links[0].url.href).toBe("https://discrete.openmathbooks.org/pdfs/dmoi4.pdf");

  expect(c.assignments.length).toBe(1);
  const a = c.assignments[0];
  expect([a.title, a.due]).toEqual(["Homework 1", "2026-10-18T03:59:00Z"]);
  expect(a.html).toContain("Problems 1.1–1.12");
  expect(a.html).toContain("Due:");
  expect(a.html).not.toContain("Powered by Moodle");

  expect(c.announcements.map((x) => [x.title, x.posted])).toEqual([
    ["Test 1 moved", "2026-10-09T14:00:00Z"],
    ["Welcome to C241", "2026-08-24T13:00:00Z"],
  ]);
  expect(c.announcements[0].html).toContain("October 16");
  expect(c.syllabus).toBe(`<p><a href="${syllabus}">Course syllabus</a></p>`);
  expect(c.skipped).toEqual([]);
}

describe("moodle content", () => {
  it("content from the course state and activity pages", async () => {
    const f = await fake();
    const c = await moodle.content(f.session(), "7");
    checkContent(c, f.base);
    expect(f.log.some((r) => r.target.startsWith("/course/view.php"))).toBe(false);
    expect(f.log.some((r) => r.target.startsWith("/mod/quiz/"))).toBe(false);
    const posts = f.log.filter((r) => r.target.endsWith("info=mod_forum_get_discussion_posts")).map((r) => JSON.parse(r.body)[0].args.discussionid);
    expect(posts).toEqual([902, 901]);
    expect(f.log.every((r) => r.method === "GET" || r.target.startsWith("/lib/ajax/service.php?sesskey="))).toBe(true);
  });

  it("content from the course page when the state call isn't there", async () => {
    const f = await fake({ noState: true });
    const c = await moodle.content(f.session(), "7");
    checkContent(c, f.base);
    expect(f.log.some((r) => r.target === "/course/view.php?id=7")).toBe(true);
  });

  it("an activity that can't be read is listed as skipped", async () => {
    const f = await fake({ gonePage: true });
    const c = await moodle.content(f.session(), "7");
    expect(c.skipped).toEqual(["“Gone page”: Your course site couldn’t find this."]);
    expect(c.modules[1].items.at(-1)).toBe("Gone page");
    expect(c.pages.length).toBe(1);
  });
});

describe("moodle parsing", () => {
  it("the course page outline", () => {
    const base = new URL("https://moodle.iu.edu");
    const s = parseCoursePage(base, fixture("course", "https://moodle.iu.edu"));
    expect(s.length).toBe(2);
    expect(s[1].name).toBe("Week 1: Logic & Proofs");
    expect(s[1].cms.map((c) => [c.id, c.modname, c.name])).toEqual([
      [103, "page", "Reading guide"],
      [104, "url", "Open textbook: Discrete Math"],
      [105, "assign", "Homework 1"],
      [106, "folder", "Lecture slides"],
    ]);
    expect(s[1].cms[2].url.href).toBe("https://moodle.iu.edu/mod/assign/view.php?id=105");
    expect(s[0].cms[2].modname).toBe("label");
  });

  it("sesskey from M.cfg and not from elsewhere", () => {
    expect(findSesskey(fixture("my", "https://m.example"))).toBe(SESSKEY);
    expect(findSesskey('M.cfg = {"sesskey":""}')).toBeNull();
    expect(findSesskey('M.cfg = {"sesskey":"ab\\"c"}')).toBeNull();
    expect(findSesskey("<html>no config</html>")).toBeNull();
  });

  it("html helpers", () => {
    const tag = `<a class='x  y' data-x=1 href="/mod/page/view.php?id=1&amp;b=2" hidden>`;
    expect(attr(tag, "href")).toBe("/mod/page/view.php?id=1&b=2");
    expect(attr(tag, "data-x")).toBe("1");
    expect(attr(tag, "hidden")).toBe("");
    expect(attr(tag, "title")).toBeNull();
    expect(hasWord(attr(tag, "class")!, "y")).toBe(true);

    const h = `<div a="x>y"><div><br/></div><div class="in">t</div></div><div>after</div>`;
    const [a, b] = openTags(h, "div")[0];
    const [ia, ib] = inner(h, a, b, "div")!;
    expect(h.slice(ia, ib)).toBe(`<div><br/></div><div class="in">t</div>`);
    expect(openTags("<divx><div>", "div").length).toBe(1);

    expect(text("<p>Tom &amp; Jerry&#8217;s&nbsp;<b>show</b></p>\n &#x41; &bogus; & more")).toBe("Tom & Jerry’s show A &bogus; & more");
    expect(percentDecode("Week%202/caf%C3%A9.pdf")).toBe("Week 2/café.pdf");
    expect(rfc3339(0)).toBe("1970-01-01T00:00:00Z");
    expect(rfc3339(1_760_759_940)).toBe("2025-10-18T03:59:00Z");
    expect(rfc3339(951_782_400)).toBe("2000-02-29T00:00:00Z");
  });
});

describe("moodle grades", () => {
  const REPORT = "/moodle/grade/report/user/index.php?id=7";
  const session = (base: string) => new Session(Site.forTest("moodle", `${base}/moodle/`), { cookies: [cookie("MoodleSession", "s3ss10n")], csrf: null });
  const serveFn = async (route: (t: string) => Reply) => {
    const s = await serve(route);
    sites.push(s);
    return s;
  };

  it("the user report with groups, weights and hidden grades absent", async () => {
    const f = await serveFn((t) => (t === REPORT ? html(raw("grades")) : status(404)));
    const g = await moodle.grades(session(f.base), "7");
    expect(g.note).toBeUndefined();
    expect(g.current).toEqual({ percent: 86.4, letter: "B+", points: 86.4, possible: 100 });
    expect(g.groups).toEqual([
      { name: "Homework & problem sets", weight: 40 },
      { name: "Exams", weight: 60 },
    ]);
    expect(g.items.map((i) => i.title)).toEqual(["Homework 1", "Homework 2", "Homework 3", "Midterm", "Participation"]);
    const h1 = g.items[0];
    expect([h1.score, h1.possible, h1.percent]).toEqual([9, 10, 90]);
    expect(h1.group).toBe("Homework & problem sets");
    expect(h1.graded).toBe(true);
    expect(h1.comments).toEqual(["Nice proof. Watch the base case."]);
    const h2 = g.items[1];
    expect(h2.score === undefined && h2.percent === undefined && !h2.graded && h2.comments.length === 0 && h2.possible === 10).toBe(true);
    const h3 = g.items[2];
    expect(h3.submitted && !h3.graded && h3.score === undefined && h3.grade === undefined).toBe(true);
    expect([g.items[3].score, g.items[3].possible, g.items[3].group]).toEqual([42, 50, "Exams"]);
    const p = g.items[4];
    expect([p.grade, p.group, p.graded]).toEqual(["Satisfactory", undefined, true]);
    expect(p.comments).toEqual(["Good contributions in week 3."]);
    assertReadOnlyWithSession(f.log, "MoodleSession=s3ss10n");
  });

  it("refused is empty with a note, and signed out is an error", async () => {
    let f = await serveFn(() => status(403));
    expect((await moodle.grades(session(f.base), "7")).note).toBe(GRADES_HIDDEN);
    f = await serveFn(() =>
      html(
        '<html><body class="path-grade"><div role="main"><p class="errormessage">Sorry, but you do not currently have permissions to do that.</p></div></body></html>',
      ),
    );
    const g = await moodle.grades(session(f.base), "7");
    expect(g.items).toEqual([]);
    expect(g.note).toBeDefined();
    f = await serveFn((t) => (t === REPORT ? redirect("/moodle/login/index.php") : html(raw("login"))));
    expect(await kindOf(moodle.grades(session(f.base), "7"))).toBe("signedOut");
    expect(await kindOf(moodle.grades(session(f.base), "7&x=1"))).toBe("notFound");
  });
});
