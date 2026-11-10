/**
 * Moodle, through the person's own signed-in session: no web service token.
 *
 * Which data to ask for follows the open-source Moodle MCP servers, which use a
 * web service token instead:
 * - moodle-mcp-server, https://github.com/peancor/moodle-mcp-server, MIT,
 *   Copyright (c) 2025 peancor (courses, assignments, forums).
 * - moodle-mcp, https://github.com/linomck/moodle-mcp (no licence file: function
 *   names only, nothing copied).
 *
 * Their functions are token-only. Moodle's own pages call functions marked
 * `'ajax' => true` through `lib/ajax/service.php`, with the session cookie and
 * the page's `sesskey`; this module does the same with those (checked against
 * Moodle 4.5): `core_course_get_enrolled_courses_by_timeline_classification`
 * (the course list), `core_courseformat_get_state` (sections and activities,
 * Moodle 4.0+), `core_calendar_get_action_events_by_course` (due dates) and
 * `mod_forum_get_discussion_posts` (announcements). Everything else is read
 * from the course's own pages. Read-only throughout. Grades come from the
 * person's own user report page.
 */
import type { Session } from "../session.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  emptyContent,
  emptyGrades,
  GRADES_HIDDEN,
  gradeItem,
  gradesRefused,
  isLmsError,
  LmsError,
  percentDecode,
  percentOf,
  remoteFile,
  splitWhitespace,
  type Announcement,
  type Course,
  type CourseContent,
  type CourseGrades,
  type Credential,
  type GradeSummary,
  type LoginNav,
  type RemoteFile,
} from "../types.ts";
import type { Adapter } from "./adapter.ts";

/** Newest discussions read from the announcements forum. */
const MAX_ANNOUNCEMENTS = 30;

function loginUrl(base: URL): URL {
  try {
    return new URL("login/index.php", base);
  } catch {
    return new URL(base.href);
  }
}

/** Pages on the site where the person isn't through signing in yet. */
const SIGNING_IN = ["/login/", "/auth/", "/admin/tool/mfa/", "/admin/tool/policy/", "/user/policy.php"];

/**
 * Signed in once the window is back on the site, past the sign-in pages, with
 * a `MoodleSession…` cookie. The sesskey lives in the page, so it's read later.
 */
function loginResult(base: URL, nav: LoginNav): Credential | null {
  if (nav.url.origin !== base.origin) return null;
  const path = nav.url.pathname;
  if (SIGNING_IN.some((p) => path.includes(p))) return null;
  if (!nav.cookies.some((c) => c.name.startsWith("MoodleSession") && c.value !== "")) return null;
  return { cookies: nav.cookies.map((c) => ({ ...c })), csrf: null };
}

/** A course id as Rust's `u64` parse reads it (a leading `+` allowed), or null. */
function parseId(id: string): string | null {
  if (!/^\+?[0-9]+$/.test(id)) return null;
  const n = BigInt(id.replace(/^\+/, ""));
  return n <= 18446744073709551615n ? n.toString() : null;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

async function courses(s: Session): Promise<Course[]> {
  const key = await sesskey(s);
  const now = nowSecs();
  return (await enrolled(s, key)).map((c) => {
    const code = text(c.shortname);
    const term = c.coursecategory !== null ? text(c.coursecategory) : "";
    return {
      id: String(c.id),
      name: text(c.fullname),
      code: code || null,
      term: term || null,
      current: c.startdate <= now && (c.enddate === 0 || c.enddate > now),
    };
  });
}

function join(base: URL, path: string): URL {
  try {
    return new URL(path, base);
  } catch (e) {
    throw LmsError.other((e as Error).message);
  }
}

/** `url` with `name=value` appended to its query, as the url crate's `append_pair` does. */
function withPair(url: URL, pair: string): URL {
  const u = new URL(url.href);
  u.search = u.search && u.search !== "?" ? `${u.search}&${pair}` : `?${pair}`;
  return u;
}

function rethrowUnlessLms(e: unknown): void {
  if (!(e instanceof LmsError)) throw e;
}

async function content(s: Session, courseId: string): Promise<CourseContent> {
  const id = parseId(courseId);
  if (id === null) throw LmsError.notFound("That course isn’t on your course site.");
  const key = await sesskey(s);
  const base = s.site.base;
  const out = emptyContent();

  let state: Section[] | null = null;
  try {
    const raw = await ajax(s, key, "core_courseformat_get_state", { courseid: Number(id) });
    state = typeof raw === "string" ? parseState(base, raw) : null;
  } catch (e) {
    rethrowUnlessLms(e);
    if (isLmsError(e, "signedOut")) throw e;
  }
  const outline = state ?? parseCoursePage(base, await page(s, join(base, `course/view.php?id=${id}`)));

  let summary: string | null = null;
  try {
    const found = (await enrolled(s, key)).find((c) => String(c.id) === id);
    if (found && text(found.summary)) summary = found.summary;
  } catch (e) {
    rethrowUnlessLms(e);
    if (isLmsError(e, "signedOut")) throw e;
  }
  let dues = new Map<number, number>();
  try {
    dues = await dueDates(s, key, Number(id));
  } catch (e) {
    rethrowUnlessLms(e);
    if (isLmsError(e, "signedOut")) throw e;
  }

  // The announcements forum: one named so, else the first forum in the top section.
  const forums = outline.flatMap((sec) => sec.cms).filter((c) => c.modname === "forum");
  let news = forums.filter((c) => isNewsName(c.name)).map((c) => c.id);
  if (news.length === 0) {
    const first = outline[0]?.cms.find((c) => c.modname === "forum");
    news = first ? [first.id] : [];
  }

  const seenFiles = new Set<string>();
  let syllabusFile: [string, URL] | null = null;
  for (const sec of outline) {
    const items: string[] = [];
    for (const cm of sec.cms) {
      if (cm.modname !== "label") items.push(cm.name);
      try {
        switch (cm.modname) {
          case "resource": {
            const f = await resource(s, cm, sec.name);
            if (syllabusFile === null && cm.name.toLowerCase().includes("syllabus")) syllabusFile = [cm.name, f.url];
            if (!seenFiles.has(f.url.href)) {
              seenFiles.add(f.url.href);
              out.files.push(f);
            }
            break;
          }
          case "folder":
            for (const f of await folder(s, cm, sec.name)) {
              if (!seenFiles.has(f.url.href)) {
                seenFiles.add(f.url.href);
                out.files.push(f);
              }
            }
            break;
          case "page":
            out.pages.push({ title: cm.name, html: await activityPage(s, cm), url: cm.url });
            break;
          case "url": {
            const u = await urlTarget(s, cm);
            if (u) out.links.push({ title: cm.name, url: u });
            break;
          }
          case "assign": {
            const html = await page(s, cm.url);
            const t = dues.get(cm.id);
            out.assignments.push({ title: cm.name, due: t !== undefined ? rfc3339(t) : null, points: null, html: mainRegion(html), url: cm.url });
            break;
          }
          case "forum":
            if (news.includes(cm.id)) out.announcements.push(...(await announcements(s, key, cm)));
            break;
        }
      } catch (e) {
        rethrowUnlessLms(e);
        if (isLmsError(e, "signedOut")) throw e;
        out.skipped.push(`“${cm.name}”: ${(e as Error).message}`);
      }
    }
    out.modules.push({ name: sec.name, items });
  }

  const syllabusPage = out.pages.find((p) => p.title.toLowerCase().includes("syllabus"));
  const file = syllabusFile as [string, URL] | null;
  out.syllabus = syllabusPage ? syllabusPage.html : file ? `<p><a href="${escape(file[1].href)}">${escape(file[0])}</a></p>` : summary;
  return out;
}

// ---------------------------------------------------------------------------
// Talking to the site

/** GET a page as text. Landing on the login page, or a page for someone not signed in, means signed out. */
async function page(s: Session, url: URL): Promise<string> {
  const res = await s.get(url);
  if (res.url.pathname.includes("/login/")) {
    res.discard();
    throw LmsError.signedOut();
  }
  let html: string;
  try {
    html = await res.text();
  } catch (e) {
    if (e instanceof LmsError || (e instanceof Error && e.name === "Cancelled")) throw e;
    throw LmsError.network((e as Error).message);
  }
  const body = openTags(html, "body")[0];
  if (body) {
    const cls = attr(html.slice(body[0], body[1]), "class");
    if (cls !== null && hasWord(cls, "notloggedin")) throw LmsError.signedOut();
  }
  return html;
}

/** The session's `sesskey`, from `M.cfg` on the person's dashboard. */
async function sesskey(s: Session): Promise<string> {
  const html = await page(s, join(s.site.base, "my/"));
  const key = findSesskey(html);
  if (key === null) throw LmsError.signedOut();
  return key;
}

export function findSesskey(html: string): string | null {
  const marker = '"sesskey":"';
  const p = html.indexOf(marker);
  if (p < 0) return null;
  const at = p + marker.length;
  const m = /^[A-Za-z0-9]*/.exec(html.slice(at))![0];
  return m && html.startsWith('"', at + m.length) ? m : null;
}

/** Call one AJAX-enabled function the way Moodle's own pages do. Returns its `data`. */
async function ajax(s: Session, key: string, method: string, args: unknown): Promise<unknown> {
  const path = `lib/ajax/service.php?sesskey=${key}&info=${method}`;
  const body = [{ index: 0, methodname: method, args }];
  const v = await s.postJson<unknown>(path, body);
  let one: Record<string, unknown>;
  if (Array.isArray(v) && v.length > 0) one = asObject(v[0]) ?? {};
  else if (asObject(v)) {
    // The whole request failed before any function ran.
    const o = asObject(v)!;
    throw ajaxError(asString(o.errorcode) ?? "", asString(o.error) ?? "");
  } else throw LmsError.other("Your course site sent something unexpected.");
  if (one.error === true) {
    const ex = asObject(one.exception);
    throw ajaxError(asString(ex?.errorcode) ?? "", asString(ex?.message) ?? "");
  }
  return one.data ?? null;
}

export function ajaxError(code: string, message: string): LmsError {
  switch (code) {
    case "servicerequireslogin":
    case "invalidsesskey":
    case "sessionerroruser":
    case "sessiontimedout":
      return LmsError.signedOut();
    case "requireloginerror":
    case "nopermissions":
    case "accessdenied":
    case "notenrolled":
      return LmsError.forbidden("Your course site didn’t allow this.");
    case "servicenotavailable":
      return LmsError.unsupported("Your course site doesn’t offer this.");
  }
  if (message === "") return LmsError.other(`Your course site answered with an error (${code}).`);
  return LmsError.other(`Your course site answered with an error: ${text(message)}`);
}

function unexpected(what: string): LmsError {
  return LmsError.other(`Your course site sent something unexpected: ${what}`);
}

type MoodleCourse = { id: number; fullname: string; shortname: string; summary: string; startdate: number; enddate: number; coursecategory: string | null };

function readCourses(data: unknown): MoodleCourse[] {
  const list = asArray(asObject(data)?.courses);
  if (!list) throw unexpected("missing field `courses`");
  return list.map((x) => {
    const c = asObject(x);
    const id = asNumber(c?.id);
    if (!c || id === undefined || typeof c.fullname !== "string") throw unexpected("a course without its id or name");
    return {
      id,
      fullname: c.fullname,
      shortname: asString(c.shortname) ?? "",
      summary: asString(c.summary) ?? "",
      startdate: asNumber(c.startdate) ?? 0,
      enddate: asNumber(c.enddate) ?? 0,
      coursecategory: asString(c.coursecategory) ?? null,
    };
  });
}

/** Every course the person is enrolled in, including hidden ones (`allincludinghidden`, 3.9+; older sites: `all`). */
async function enrolled(s: Session, key: string): Promise<MoodleCourse[]> {
  const F = "core_course_get_enrolled_courses_by_timeline_classification";
  try {
    return readCourses(await ajax(s, key, F, { classification: "allincludinghidden", limit: 0, offset: 0 }));
  } catch (e) {
    rethrowUnlessLms(e);
    if (isLmsError(e, "signedOut")) throw e;
    return readCourses(await ajax(s, key, F, { classification: "all", limit: 0, offset: 0 }));
  }
}

/** Due dates by activity id, from the course's action events (things still to do). */
async function dueDates(s: Session, key: string, course: number): Promise<Map<number, number>> {
  const PAGE = 50;
  const out = new Map<number, number>();
  let after = 0;
  for (let i = 0; i < 10; i++) {
    const got = asObject(await ajax(s, key, "core_calendar_get_action_events_by_course", { courseid: course, aftereventid: after, limitnum: PAGE }));
    if (!got) throw unexpected("invalid type: expected events");
    const events = (asArray(got.events) ?? []).map((e) => asObject(e) ?? {});
    for (const e of events) {
      const type = asString(e.eventtype) ?? "";
      const url = asString(e.url) ?? "";
      if (type !== "due" && type !== "duedate" && !url.includes("/mod/assign/")) continue;
      let u: URL | null = null;
      try {
        u = new URL(decodeEntities(url));
      } catch {
        u = null;
      }
      const cm = u ? queryId(u, "id") : null;
      if (cm !== null && !out.has(cm)) out.set(cm, asNumber(e.timesort) ?? 0);
    }
    const last = events[events.length - 1];
    if (last && events.length >= PAGE) after = asNumber(last.id) ?? 0;
    else break;
  }
  return out;
}

/** The forum's newest discussions (listed on its page), each with its opening post. */
async function announcements(s: Session, key: string, cm: Cm): Promise<Announcement[]> {
  const html = await page(s, cm.url);
  const ids: number[] = [];
  for (const [a, b] of openTags(html, "a")) {
    const href = attr(html.slice(a, b), "href");
    if (href === null) continue;
    let u: URL;
    try {
      u = new URL(href, cm.url);
    } catch {
      continue;
    }
    if (!u.pathname.endsWith("/mod/forum/discuss.php")) continue;
    const d = queryId(u, "d");
    if (d !== null && !ids.includes(d)) ids.push(d);
  }
  const out: Announcement[] = [];
  for (const d of ids.slice(0, MAX_ANNOUNCEMENTS)) {
    const got = asObject(await ajax(s, key, "mod_forum_get_discussion_posts", { discussionid: d, sortby: "created", sortdirection: "ASC" }));
    if (!got) throw unexpected("invalid type: expected posts");
    const posts = (asArray(got.posts) ?? []).map((p) => asObject(p) ?? {});
    const p = posts.find((p) => p.hasparent !== true) ?? posts[0];
    if (p) {
      const t = asNumber(p.timecreated) ?? 0;
      out.push({ title: text(asString(p.subject) ?? ""), posted: t > 0 ? rfc3339(t) : null, html: asString(p.message) ?? "" });
    }
  }
  return out;
}

/** A file activity: its view page (`forceview`) names the file at `pluginfile.php`; else `redirect=1` still leads there. */
async function resource(s: Session, cm: Cm, section: string): Promise<RemoteFile> {
  const html = await page(s, withPair(cm.url, "forceview=1"));
  const folder = section !== "" ? section : null;
  const redirect = withPair(cm.url, "redirect=1");
  const found = pluginFiles(html, cm.url, "/mod_resource/content/")[0];
  if (found) return remoteFile(found[2], found[0], { folder, aliases: [cm.url, redirect] });
  return remoteFile(cm.name, redirect, { folder, aliases: [cm.url] });
}

/** A folder activity: every file it lists, keeping its subfolders. */
async function folder(s: Session, cm: Cm, section: string): Promise<RemoteFile[]> {
  const html = await page(s, cm.url);
  return pluginFiles(html, cm.url, "/mod_folder/content/").map(([url, sub, name]) => {
    const parts = [section, cm.name, ...sub].filter((p) => p !== "");
    return remoteFile(name, url, { folder: parts.join("/") });
  });
}

/** A page activity's own text (the box under its title), else the page's main region. */
async function activityPage(s: Session, cm: Cm): Promise<string> {
  const html = await page(s, cm.url);
  const main = mainRegion(html);
  const tag = openTags(main, "div").find(([a, b]) => hasWord(attr(main.slice(a, b), "class") ?? "", "generalbox"));
  const boxed = tag ? inner(main, tag[0], tag[1], "div") : null;
  return (boxed ? main.slice(boxed[0], boxed[1]) : main).trim();
}

/** A link activity's target from its view page; null when it points back into the site. */
async function urlTarget(s: Session, cm: Cm): Promise<URL | null> {
  const html = await page(s, withPair(cm.url, "forceview=1"));
  const external = (raw: string | null): URL | null => {
    if (raw === null) return null;
    try {
      const u = new URL(raw, cm.url);
      return u.protocol === "http:" || u.protocol === "https:" ? u : null;
    } catch {
      return null;
    }
  };
  // "Click <a>…</a> link to open resource."
  const work = openTags(html, "div").find(([a, b]) => hasWord(attr(html.slice(a, b), "class") ?? "", "urlworkaround"));
  const region = work ? inner(html, work[0], work[1], "div") : null;
  if (region) {
    const r = html.slice(region[0], region[1]);
    for (const [x, y] of openTags(r, "a")) {
      const u = external(attr(r.slice(x, y), "href"));
      if (u) return s.site.owns(u) ? null : u;
    }
  }
  // Embedded or framed: the first address off the site.
  const main = mainRegion(html);
  const places: [string, string, string][] = [
    [main, "a", "href"],
    [main, "iframe", "src"],
    [main, "object", "data"],
    [html, "frame", "src"],
  ];
  for (const [r, tag, name] of places) {
    for (const [x, y] of openTags(r, tag)) {
      const u = external(attr(r.slice(x, y), name));
      if (u && !s.site.owns(u)) return u;
    }
  }
  throw LmsError.notFound("Couldn’t find where this link goes.");
}

// ---------------------------------------------------------------------------
// The course outline: sections and their activities

export type Cm = { id: number; modname: string; name: string; url: URL };
export type Section = { name: string; cms: Cm[] };

function idOf(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^\+?[0-9]+$/.test(v)) return Number(v.replace(/^\+/, ""));
  return null;
}

/** `core_courseformat_get_state`'s JSON: sections in order, each listing its activities by id. */
export function parseState(base: URL, raw: string): Section[] | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = asObject(v);
  const cmList = asArray(o?.cm);
  if (!cmList) return null;
  const cms = new Map<number, Cm>();
  for (const x of cmList) {
    const c = asObject(x);
    const id = idOf(c?.id);
    if (!c || id === null) continue;
    if (c.uservisible === false) continue;
    const modname = asString(c.module) ?? "";
    let url: URL | null = null;
    const u = asString(c.url);
    if (u !== undefined) {
      try {
        url = new URL(decodeEntities(u), base);
      } catch {
        url = null;
      }
    }
    if (!url) {
      try {
        url = new URL(`mod/${modname}/view.php?id=${id}`, base);
      } catch {
        return null;
      }
    }
    cms.set(id, { id, name: text(asString(c.name) ?? ""), modname, url });
  }
  const sections = asArray(o?.section);
  if (!sections) return null;
  return sections.map((x) => {
    const sec = asObject(x);
    const name = text(asString(sec?.title) ?? "");
    const list = (asArray(sec?.cmlist) ?? [])
      .map(idOf)
      .filter((id): id is number => id !== null)
      .map((id) => cms.get(id))
      .filter((c): c is Cm => !!c)
      .map((c) => ({ ...c }));
    return { name, cms: list };
  });
}

/** The course page itself (`course/view.php`), for sites without the state call. */
export function parseCoursePage(base: URL, html: string): Section[] {
  const out: Section[] = [];
  for (const [a, b] of openTags(html, "li")) {
    const tag = html.slice(a, b);
    const idAttr = attr(tag, "id");
    if (idAttr === null || !idAttr.startsWith("section-")) continue;
    const n = idAttr.slice("section-".length);
    if (parseId(n) === null) continue;
    const span = inner(html, a, b, "li");
    if (!span) continue;
    const body = html.slice(span[0], span[1]);
    let heading: string | null = null;
    for (const h of ["h3", "h2", "h4"]) {
      const t = openTags(body, h).find(([x, y]) => hasWord(attr(body.slice(x, y), "class") ?? "", "sectionname"));
      const i = t ? inner(body, t[0], t[1], h) : null;
      if (i) {
        heading = text(body.slice(i[0], i[1]));
        break;
      }
    }
    const name = heading ? heading : (attr(tag, "aria-label") ?? `Section ${n}`);
    const cms: Cm[] = [];
    for (const [x, y] of openTags(body, "li")) {
      const mtag = body.slice(x, y);
      const mid = attr(mtag, "id");
      const id = mid !== null && mid.startsWith("module-") ? idOf(mid.slice("module-".length)) : null;
      if (id === null) continue;
      const cls = attr(mtag, "class");
      const word = cls !== null ? splitAsciiWs(cls).find((w) => w.startsWith("modtype_")) : undefined;
      if (word === undefined) continue;
      const modname = word.slice("modtype_".length);
      const span2 = inner(body, x, y, "li");
      if (!span2) continue;
      const item = body.slice(span2[0], span2[1]);
      let url: URL | null = null;
      for (const [p, q] of openTags(item, "a")) {
        const h = attr(item.slice(p, q), "href");
        if (h === null) continue;
        try {
          const u = new URL(h, base);
          if (u.pathname.includes(`/mod/${modname}/view.php`)) {
            url = u;
            break;
          }
        } catch {
          // not an address
        }
      }
      if (!url) {
        try {
          url = new URL(`mod/${modname}/view.php?id=${id}`, base);
        } catch {
          continue;
        }
      }
      const iname = instanceName(item) ?? "";
      if (iname === "" && modname !== "label") continue;
      cms.push({ id, modname, name: iname, url });
    }
    out.push({ name, cms });
  }
  return out;
}

/** `<span class="instancename">Name<span class="accesshide"> File</span></span>`. */
function instanceName(item: string): string | null {
  const t = openTags(item, "span").find(([a, b]) => hasWord(attr(item.slice(a, b), "class") ?? "", "instancename"));
  if (!t) return null;
  const i = inner(item, t[0], t[1], "span");
  if (!i) return null;
  let s = item.slice(i[0], i[1]);
  for (;;) {
    const h = openTags(s, "span").find(([x, y]) => hasWord(attr(s.slice(x, y), "class") ?? "", "accesshide"));
    if (!h) break;
    const e = inner(s, h[0], h[1], "span");
    const end = e ? e[1] + "</span>".length : h[1];
    s = s.slice(0, h[0]) + s.slice(Math.min(end, s.length));
  }
  return text(s);
}

function isNewsName(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes("announcement") || n.includes("news");
}

/** Files at `pluginfile.php/<context>/<area>/<revision or item>/<path…>/<name>`: (address without query, subfolders, name). */
function pluginFiles(html: string, pageUrl: URL, area: string): [URL, string[], string][] {
  const out: [URL, string[], string][] = [];
  for (const tag of ["a", "img", "object", "iframe", "frame", "embed", "source"]) {
    for (const [a, b] of openTags(html, tag)) {
      for (const name of ["href", "src", "data"]) {
        const h = attr(html.slice(a, b), name);
        if (h === null) continue;
        let u: URL;
        try {
          u = new URL(h, pageUrl);
        } catch {
          continue;
        }
        const path = u.pathname;
        const at = path.indexOf(area);
        if (at < 0 || !path.includes("/pluginfile.php/")) continue;
        const segs = path
          .slice(at + area.length)
          .split("/")
          .slice(1)
          .filter((p) => p !== "")
          .map(percentDecode);
        const file = segs.pop();
        if (file === undefined) continue;
        u.search = "";
        u.hash = "";
        if (!out.some(([o]) => o.href === u.href)) out.push([u, segs, file]);
      }
    }
  }
  return out;
}

/** The page's main content: `<div role="main">`, else `#region-main`, else the body, else everything. */
export function mainRegion(html: string): string {
  const pick = (): [number, number] | null => {
    const d = openTags(html, "div").find(([a, b]) => attr(html.slice(a, b), "role") === "main");
    const di = d ? inner(html, d[0], d[1], "div") : null;
    if (di) return di;
    const sec = openTags(html, "section").find(([a, b]) => attr(html.slice(a, b), "id") === "region-main");
    const si = sec ? inner(html, sec[0], sec[1], "section") : null;
    if (si) return si;
    const body = openTags(html, "body")[0];
    return body ? inner(html, body[0], body[1], "body") : null;
  };
  const r = pick();
  return r ? html.slice(r[0], r[1]) : html;
}

// ---------------------------------------------------------------------------
// Small helpers: just enough HTML reading for Moodle's own markup.

const ASCII_WS = /[\t\n\f\r ]/;

function splitAsciiWs(s: string): string[] {
  return s.split(/[\t\n\f\r ]+/).filter((w) => w !== "");
}

/** Every opening `<name …>` tag: [start, index after its `>`]. */
export function openTags(html: string, name: string): [number, number][] {
  const pat = `<${name}`;
  const out: [number, number][] = [];
  let i = 0;
  for (;;) {
    const start = html.indexOf(pat, i);
    if (start < 0) break;
    const after = start + pat.length;
    const c = html[after];
    if (c !== undefined && (ASCII_WS.test(c) || c === ">" || c === "/")) {
      const end = tagEnd(html, after);
      if (end === null) break;
      out.push([start, end]);
      i = end;
    } else i = after;
  }
  return out;
}

/** Index just past the `>` that closes a tag, skipping quoted attribute values. */
function tagEnd(html: string, from: number): number | null {
  let quote: string | null = null;
  for (let i = from; i < html.length; i++) {
    const c = html[i];
    if (quote !== null) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ">") return i + 1;
  }
  return null;
}

/** The content between an opening tag (start `a`, end `b`) and its matching close. */
export function inner(html: string, a: number, b: number, name: string): [number, number] | null {
  if (html.slice(a, b).endsWith("/>")) return null;
  const open = `<${name}`;
  const close = `</${name}`;
  let depth = 1;
  let i = b;
  for (;;) {
    const nextClose = html.indexOf(close, i);
    if (nextClose < 0) return null;
    // Only the first `<name` before the close is considered, as in the original.
    const p = html.indexOf(open, i);
    const c = p >= 0 && p < nextClose ? html[p + open.length] : undefined;
    const nextOpen = c !== undefined && (ASCII_WS.test(c) || c === ">") ? p : -1;
    if (nextOpen >= 0) {
      const end = tagEnd(html, nextOpen + open.length);
      if (end === null) return null;
      if (!html.slice(nextOpen, end).endsWith("/>")) depth++;
      i = end;
    } else {
      depth--;
      if (depth === 0) return [b, nextClose];
      i = nextClose + close.length;
    }
  }
}

/** An attribute's value from an opening tag, entities decoded. */
export function attr(tag: string, name: string): string | null {
  const first = tag.search(/[\t\n\f\r ]/);
  if (first < 0) return null;
  let i = first;
  const n = tag.length;
  while (i < n) {
    while (i < n && (ASCII_WS.test(tag[i]) || tag[i] === "/")) i++;
    const ns = i;
    while (i < n && !ASCII_WS.test(tag[i]) && tag[i] !== "=" && tag[i] !== ">" && tag[i] !== "/") i++;
    const key = tag.slice(ns, i);
    if (key === "") return null;
    while (i < n && ASCII_WS.test(tag[i])) i++;
    let value = "";
    if (tag[i] === "=") {
      i++;
      while (i < n && ASCII_WS.test(tag[i])) i++;
      const q = tag[i];
      if (q === '"' || q === "'") {
        let end = tag.indexOf(q, i + 1);
        if (end < 0) end = n;
        value = tag.slice(i + 1, end);
        i = end + 1;
      } else {
        const vs = i;
        while (i < n && !ASCII_WS.test(tag[i]) && tag[i] !== ">") i++;
        value = tag.slice(vs, i);
      }
    }
    if (key.toLowerCase() === name.toLowerCase()) return decodeEntities(value);
  }
  return null;
}

/** `word` is one of the whitespace-separated tokens of `list`. */
export function hasWord(list: string, word: string): boolean {
  return splitWhitespace(list).includes(word);
}

/** Plain text from HTML: tags dropped (each a space), entities decoded, whitespace collapsed. */
export function text(html: string): string {
  let out = "";
  let inTag = false;
  for (const c of html) {
    if (c === "<") inTag = true;
    else if (c === ">" && inTag) {
      inTag = false;
      out += " ";
    } else if (!inTag) out += c;
  }
  return splitWhitespace(decodeEntities(out)).join(" ");
}

/** Moodle's own small entity table (`&nbsp;` is U+00A0); the `;` must come within 12 bytes. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  let rest = s;
  for (;;) {
    const p = rest.indexOf("&");
    if (p < 0) break;
    out += rest.slice(0, p);
    rest = rest.slice(p);
    const head = Buffer.from(rest, "utf8").subarray(0, 12).toString("utf8");
    const e = head.indexOf(";");
    let decoded: [string, number] | null = null;
    if (e >= 0) {
      const ent = rest.slice(1, e);
      const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—" };
      let ch: string | null = Object.prototype.hasOwnProperty.call(named, ent) ? named[ent] : null;
      if (ch === null) {
        let cp: number | null = null;
        if (ent.startsWith("#x") || ent.startsWith("#X")) cp = /^\+?[0-9A-Fa-f]+$/.test(ent.slice(2)) ? parseInt(ent.slice(2), 16) : null;
        else if (ent.startsWith("#")) cp = /^\+?[0-9]+$/.test(ent.slice(1)) ? parseInt(ent.slice(1), 10) : null;
        if (cp !== null && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) ch = String.fromCodePoint(cp);
      }
      if (ch !== null) decoded = [ch, e + 1];
    }
    if (decoded) {
      out += decoded[0];
      rest = rest.slice(decoded[1]);
    } else {
      out += "&";
      rest = rest.slice(1);
    }
  }
  return out + rest;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function queryId(u: URL, key: string): number | null {
  for (const [k, v] of u.searchParams) {
    if (k === key) return /^\+?[0-9]+$/.test(v) ? Number(v.replace(/^\+/, "")) : null;
  }
  return null;
}

/** Unix seconds as RFC 3339 in UTC. */
export function rfc3339(t: number): string {
  return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Grades
//
// Moodle's grade functions are open to the mobile app's token only, not to
// AJAX, so the person's own user report page is read instead:
// `grade/report/user/index.php?id=<course>`. Each cell carries `column-<name>`
// and `headers` naming its category; a category's header cell has the id
// `cat_<id>_<user>`. Grades hidden from the person show as "-" and stay absent.

async function grades(s: Session, courseId: string): Promise<CourseGrades> {
  const id = parseId(courseId);
  if (id === null) throw LmsError.notFound("That course isn’t on your course site.");
  let html: string;
  try {
    html = await page(s, join(s.site.base, `grade/report/user/index.php?id=${id}`));
  } catch (e) {
    return gradesRefused(e);
  }
  return parseUserReport(html);
}

type Cell = { class: string; id: string; headers: string; html: string };

const isCol = (c: Cell, column: string) => hasWord(c.class, `column-${column}`);

export function parseUserReport(html: string): CourseGrades {
  const t = openTags(html, "table").find(([a, b]) => hasWord(attr(html.slice(a, b), "class") ?? "", "user-grade"));
  const ti = t ? inner(html, t[0], t[1], "table") : null;
  if (!ti) return emptyGrades(GRADES_HIDDEN);
  const table = html.slice(ti[0], ti[1]);
  const out: CourseGrades = { current: {}, groups: [], items: [] };
  // Category id → name (the course's own top category isn't a group).
  const cats: [string, string][] = [];
  let top: string | null = null;
  const weights = new Map<string, number>();
  for (const [a, b] of openTags(table, "tr")) {
    const ri = inner(table, a, b, "tr");
    if (!ri) continue;
    const row = table.slice(ri[0], ri[1]);
    const found: [number, Cell][] = [];
    for (const name of ["th", "td"]) {
      for (const [ca, cb] of openTags(row, name)) {
        const tag = row.slice(ca, cb);
        const ci = inner(row, ca, cb, name);
        if (!ci) continue;
        found.push([ca, { class: attr(tag, "class") ?? "", id: attr(tag, "id") ?? "", headers: attr(tag, "headers") ?? "", html: row.slice(ci[0], ci[1]) }]);
      }
    }
    found.sort((x, y) => x[0] - y[0]);
    const cells = found.map(([, c]) => c);
    const nameCell = cells.find((c) => isCol(c, "itemname") && !hasWord(c.class, "header"));
    if (!nameCell) continue;
    const catOf = (c: Cell): string | null => {
      const h = splitWhitespace(c.headers).find((h) => h.startsWith("cat_"));
      return h !== undefined ? (h.split("_")[1] ?? "") : null;
    };
    const col = (n: string): string | null => {
      const c = cells.find((c) => isCol(c, n));
      if (!c) return null;
      const t = text(c.html);
      return t !== "" && t !== "-" ? t : null;
    };

    if (hasWord(nameCell.class, "category")) {
      const cid = nameCell.id.split("_")[1] ?? "";
      const title = text(nameCell.html);
      if (top === null) top = cid;
      else if (title !== "") cats.push([cid, title]);
      continue;
    }
    const kind = nameCell.html.includes("courseitem")
      ? "course"
      : nameCell.html.includes("categoryitem") || ["baggt", "baggb"].some((w) => hasWord(nameCell.class, w))
        ? "category"
        : "item";
    let headerCat: string | null = null;
    for (const c of cells) {
      headerCat = catOf(c);
      if (headerCat !== null) break;
    }
    const gradeText = col("grade");
    const score = gradeText !== null ? number(gradeText) : null;
    const range = col("range");
    let possible: number | null = null;
    if (range !== null) {
      const nums = range
        .split(/[–\-—]/)
        .map(number)
        .filter((x): x is number => x !== null);
      possible = nums.length ? nums[nums.length - 1] : null;
    }
    const pcText = col("percentage");
    const percent = (pcText !== null ? number(pcText) : null) ?? percentOf(score, possible) ?? null;
    const letter = col("lettergrade");
    if (kind === "course") {
      const cur: GradeSummary = {};
      if (percent !== null) cur.percent = percent;
      if (letter !== null) cur.letter = letter;
      if (score !== null) cur.points = score;
      if (possible !== null && score !== null) cur.possible = possible;
      out.current = cur;
    } else if (kind === "category") {
      // A category's total row: its weight in the course is the group's weight.
      const w = col("weight");
      const wn = w !== null ? number(w) : null;
      if (headerCat !== null && wn !== null) weights.set(headerCat, wn);
    } else {
      const title = rowTitle(nameCell.html);
      if (title === "") continue;
      const submittedOnly = gradeText !== null && score === null && gradeText.toLowerCase().startsWith("submitted");
      const shown = gradeText !== null && score === null && !submittedOnly && gradeText.toLowerCase() !== "error" ? gradeText : null;
      const fb = cells.find((c) => isCol(c, "feedback"));
      const feedback = fb ? text(fb.html) : "";
      const item = gradeItem(title, { submitted: submittedOnly, graded: score !== null || shown !== null, comments: feedback ? [feedback] : [] });
      const hc = headerCat;
      if (hc !== null && hc !== top) {
        const g = cats.find(([cid]) => cid === hc);
        if (g) item.group = g[1];
      }
      if (score !== null) item.score = score;
      if (possible !== null) item.possible = possible;
      if (score !== null && percent !== null) item.percent = percent;
      if (shown !== null) item.grade = shown;
      out.items.push(item);
    }
  }
  out.groups = cats.map(([cid, name]) => {
    const w = weights.get(cid);
    return w !== undefined ? { name, weight: w } : { name };
  });
  return out;
}

/** The item's name: Moodle 4's `rowtitle`, else the grade item link (3.x), else the cell's text. */
function rowTitle(cell: string): string {
  const byClass = (tag: string, cls: string): string | null => {
    const t = openTags(cell, tag).find(([a, b]) => hasWord(attr(cell.slice(a, b), "class") ?? "", cls));
    const i = t ? inner(cell, t[0], t[1], tag) : null;
    return i ? text(cell.slice(i[0], i[1])) : null;
  };
  return byClass("div", "rowtitle") ?? byClass("a", "gradeitemheader") ?? byClass("span", "gradeitemheader") ?? text(cell);
}

/** A number as Moodle prints it ("85.00", "85,00 %", "1,234.5"), or null. */
export function number(s: string): number | null {
  let t = s.trim().replace(/%+$/, "").trim();
  t = [...t].filter((c) => !/^\s$/u.test(c)).join("");
  if (t === "" || !/^[0-9.,-]+$/.test(t)) return null;
  t = t.includes(".") ? t.replace(/,/g, "") : t.replace(/,/g, ".");
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export const moodle: Adapter = { loginUrl, loginResult, courses, content, grades };
