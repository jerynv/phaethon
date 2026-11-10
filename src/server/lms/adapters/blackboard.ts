/**
 * Blackboard Learn (Original and Ultra), through the person's own session.
 *
 * Learn's Ultra pages call the public REST API (`/learn/api/public/...`) from
 * the browser with nothing but the session cookies, so Phaethon does the same:
 * no REST application key, no OAuth token. Both course views use the same API.
 *
 * Which endpoints give the useful data, how paging, attachments, embedded
 * `/bbcswebdav/` files and "current" courses work, follows blackboard-mcp
 * (https://github.com/alanwtom/blackboard-mcp), MIT licence,
 * Copyright (c) 2026 alanwtom. Ported and reworked here.
 *
 * Every call is a GET. Learn checks its XSRF token (the `xsrf:` field inside
 * the `BbRouter` cookie, sent by Ultra as `X-Blackboard-XSRF`) only on calls
 * that change something, so it is kept in `Credential.csrf` but never needed.
 */

import { scan } from "../html.ts";
import type { Session } from "../session.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  emptyContent,
  formEncode,
  gradeItem,
  gradesRefused,
  isLmsError,
  LmsError,
  percentDecode,
  percentOf,
  rustTrim,
  splitWhitespace,
  type Course,
  type CourseContent,
  type CourseGrades,
  type Credential,
  type GradeSummary,
  type LoginNav,
  type Module,
  type RemoteFile,
} from "../types.ts";
import type { Adapter } from "./adapter.ts";

const API = "/learn/api/public";
/** Stop following `paging.nextPage` after this many pages of one listing. */
const MAX_PAGES = 50;
/** Folders nested deeper than this aren't opened. */
const MAX_DEPTH = 8;
/** Content items read from one course, at most. */
const MAX_ITEMS = 3000;

/** Paths on the site that mean the person is still signing in (or was signed out). */
const LOGIN_PATHS = ["/webapps/login", "/webapps/bb-auth-provider", "/webapps/bb-sso", "/auth-saml", "/auth-oidc", "/login", "/ultra/session-expired", "/ultra/logout"];

function loginUrl(base: URL): URL {
  // Learn sends a visitor without a session to its login page or the school's SSO.
  return new URL("/", base);
}

function loginResult(base: URL, nav: LoginNav): Credential | null {
  if (nav.url.origin !== base.origin) return null;
  const path = nav.url.pathname.replace(/[A-Z]/g, (c) => c.toLowerCase());
  // The root only redirects onwards; the login pages and SSO hand-offs aren't signed in yet.
  if (path === "/" || LOGIN_PATHS.some((p) => path.startsWith(p))) return null;
  const router = nav.cookies.find((c) => c.name === "BbRouter" && rustTrim(c.value) !== "");
  if (!router) return null;
  return { cookies: nav.cookies.map((c) => ({ ...c })), csrf: routerField(router.value, "xsrf") };
}

/** A field of the `BbRouter` cookie (`expires:…,id:…,user:…,xsrf:…`), which may arrive quoted or percent-encoded. */
function routerField(value: string, key: string): string | null {
  const v = percentDecode(rustTrim(value).replace(/^"+|"+$/g, ""));
  for (const kv of v.split(",")) {
    const i = kv.indexOf(":");
    if (i < 0) continue;
    if (rustTrim(kv.slice(0, i)) === key) {
      const x = rustTrim(kv.slice(i + 1));
      return x !== "" ? x : null;
    }
  }
  return null;
}

async function courses(s: Session): Promise<Course[]> {
  const me = await whoami(s);
  const memberships = await paged(s, `${API}/v1/users/${enc(me)}/courses?expand=course&limit=100`);
  const now = nowRfc3339();
  const terms = new Map<string, unknown>();
  const seen = new Set<string>();
  const out: Course[] = [];
  for (const m of memberships) {
    let course: unknown;
    const embedded = field(m, "course");
    if (asObject(embedded)) course = embedded;
    else {
      const cid = text(m, "courseId");
      if (cid === undefined) continue;
      try {
        course = await s.getJson(`${API}/v3/courses/${enc(cid)}`);
      } catch (e) {
        if (isLmsError(e, "signedOut") || !(e instanceof LmsError)) throw e;
        continue;
      }
    }
    const id = text(course, "id");
    if (id === undefined) continue;
    // Organizations (clubs, orientation sites) aren't courses.
    if (field(course, "organization") === true || seen.has(id)) continue;
    seen.add(id);
    let term: unknown = null;
    const tid = text(course, "termId");
    if (tid !== undefined) {
      if (!terms.has(tid)) {
        // A student often can't read terms; the course still lists without one.
        let t: unknown = null;
        try {
          t = await s.getJson(`${API}/v1/terms/${enc(tid)}`);
        } catch (e) {
          if (isLmsError(e, "signedOut") || !(e instanceof LmsError)) throw e;
        }
        terms.set(tid, t);
      }
      term = terms.get(tid);
    }
    const memberAvailable = textAt(m, ["availability", "available"]);
    const available = textAt(course, ["availability", "available"]) === "Yes" && (memberAvailable === undefined || memberAvailable === "Yes");
    const ended = (d: unknown) => {
      const end = text(d, "end");
      return end !== undefined && end.slice(0, 19) < now.slice(0, 19);
    };
    const courseDur = field(field(course, "availability"), "duration");
    const termDur = field(field(term, "availability"), "duration");
    out.push({
      id,
      name: text(course, "name") ?? id,
      code: text(course, "courseId") ?? null,
      term: (term !== null ? text(term, "name") : undefined) ?? null,
      current: available && !ended(courseDur) && !ended(termDur),
    });
  }
  return out
    .map((c, n) => ({ c, n, name: c.name.toLowerCase() }))
    .sort((a, b) => {
      if (a.c.current !== b.c.current) return a.c.current ? -1 : 1;
      if (a.name !== b.name) return a.name < b.name ? -1 : 1;
      return a.n - b.n;
    })
    .map((x) => x.c);
}

type Item = { id: string; parent: string | undefined; title: string; handler: string; path: string[]; raw: unknown };

function bodyOf(it: Item): string {
  const b = text(it.raw, "body") ?? "";
  return rustTrim(b) === "" ? (text(it.raw, "description") ?? "") : b;
}

async function content(s: Session, courseId: string): Promise<CourseContent> {
  // A refusal here (or a login page) means the session ended, not that the course hides something.
  await whoami(s);
  const cid = enc(courseId);
  const out = emptyContent();

  // Gradebook columns give due dates and points; a course may hide them from students.
  let columns: unknown[] = [];
  try {
    columns = await paged(s, `${API}/v2/courses/${cid}/gradebook/columns?limit=100`);
  } catch (e) {
    rethrowFatal(e);
    out.skipped.push(`Due dates from the grade book (${plain(e as LmsError)})`);
  }
  const byContent = new Map<string, unknown>();
  for (const c of columns) {
    const id = text(c, "contentId");
    if (id !== undefined) byContent.set(id, c);
  }

  // Walk the content tree, folders breadth-first so the order follows the course outline.
  const items: Item[] = [];
  const roots = await paged(s, `${API}/v1/courses/${cid}/contents?limit=200`);
  const queue: [unknown[], string[], number][] = [[roots, [], 0]];
  let truncated = false;
  while (queue.length) {
    const [list, path, depth] = queue.shift()!;
    for (const v of list) {
      if (items.length >= MAX_ITEMS) {
        truncated = true;
        break;
      }
      const id = text(v, "id");
      if (id === undefined) continue;
      const title = text(v, "title") ?? "Untitled";
      const handler = textAt(v, ["contentHandler", "id"]) ?? "";
      const container = isContainer(handler);
      const hc = field(v, "hasChildren");
      const hasChildren = typeof hc === "boolean" ? hc : container;
      if (container && hasChildren) {
        if (depth + 1 > MAX_DEPTH) truncated = true;
        else {
          try {
            const children = await paged(s, `${API}/v1/courses/${cid}/contents/${enc(id)}/children?limit=200`);
            queue.push([children, [...path, title.replace(/\//g, "-")], depth + 1]);
          } catch (e) {
            rethrowFatal(e);
            out.skipped.push(`The folder “${title}” (${plain(e as LmsError)})`);
          }
        }
      }
      items.push({ id, parent: text(v, "parentId"), title, handler, path: [...path], raw: v });
    }
  }
  if (truncated) out.skipped.push("Part of the course content (it is nested too deeply or is too large to read in full)");

  const base = s.site.base;
  const seenFiles = new Set<string>();
  const assigned = new Set<string>();
  const modules: Module[] = [];
  const moduleOf = new Map<string, number>();
  const loose: Module = { name: "Course content", items: [] };

  for (const it of items) {
    const body = fixBody(base, bodyOf(it));
    const folder = it.path.length ? it.path.join("/") : null;
    const entries: string[] = [];
    const filesBefore = out.files.length;
    const pageUrl = itemUrl(base, courseId, it.id);
    const hasBody = rustTrim(body) !== "";

    if (isContainer(it.handler)) {
      moduleOf.set(it.id, modules.length);
      modules.push({ name: [...it.path, it.title].join(" / "), items: [] });
      if (hasBody) out.pages.push({ title: it.title, html: body, url: pageUrl });
    } else if (it.handler === "resource/x-bb-externallink") {
      const target = parseUrl(textAt(it.raw, ["contentHandler", "url"]));
      // Only web links: a `javascript:` or `file:` address isn't one.
      if (target && (target.protocol === "https:" || target.protocol === "http:")) out.links.push({ title: it.title, url: target });
      if (hasBody) out.pages.push({ title: it.title, html: body, url: pageUrl });
      entries.push(it.title);
    } else if (isGradable(it.handler) || byContent.has(it.id)) {
      const col = byContent.get(it.id);
      assigned.add(it.id);
      out.assignments.push({
        title: it.title,
        due: (col !== undefined ? textAt(col, ["grading", "due"]) : undefined) ?? null,
        points: asNumber(field(field(col, "score"), "possible")) ?? null,
        html: body,
        url: pageUrl,
      });
      entries.push(it.title);
    } else if (it.handler !== "resource/x-bb-file" && hasBody) {
      // Documents, blank pages, the Original syllabus tool and anything else that carries text.
      out.pages.push({ title: it.title, html: body, url: pageUrl });
      entries.push(it.title);
    } else if (it.handler !== "resource/x-bb-file") {
      // A tool link (test, discussion, LTI tool) with nothing to save: named in the outline only.
      entries.push(it.title);
    }

    // Files attached to the item (an uploaded file, a document's attachments, an assignment's handout).
    if (hasAttachments(it.handler)) {
      const path = `${API}/v1/courses/${enc(courseId)}/contents/${enc(it.id)}/attachments`;
      try {
        const list = await paged(s, path);
        for (const a of list) {
          const aid = text(a, "id");
          if (aid === undefined) continue;
          const name = text(a, "fileName") ?? textAt(it.raw, ["contentHandler", "file", "fileName"]) ?? it.title;
          let url: URL;
          try {
            url = new URL(`${path}/${enc(aid)}/download`, base);
          } catch {
            continue;
          }
          if (seenFiles.has(url.href)) continue;
          seenFiles.add(url.href);
          const aliases: URL[] = [];
          try {
            aliases.push(new URL(`${path}/${enc(aid)}`, base));
          } catch {
            // no alias
          }
          aliases.push(nautilus(base, courseId, it.id, it.parent));
          entries.push(name);
          out.files.push({ name, folder, url, size: null, mime: text(a, "mimeType") ?? null, aliases, version: null });
        }
      } catch (e) {
        rethrowFatal(e);
        if (!isLmsError(e, "notFound")) out.skipped.push(`The files in “${it.title}” (${plain(e as LmsError)})`);
      }
    }

    // Files embedded in the item's text by Learn's editor (`/bbcswebdav/...`).
    for (const [url, name] of webdavLinks(base, body)) {
      if (!seenFiles.has(url.href)) {
        seenFiles.add(url.href);
        out.files.push(file(name, url, folder));
      }
    }

    // Syllabus: Learn has no single syllabus field; it's an item titled so (or the Original syllabus tool).
    if (out.syllabus === null && (it.handler === "resource/x-bb-syllabus" || it.title.toLowerCase().includes("syllabus"))) {
      const files = out.files
        .slice(filesBefore)
        .map((f) => `<p><a href="${escape(f.url.href)}">${escape(f.name)}</a></p>`)
        .join("");
      if (hasBody || files) out.syllabus = `${body}${files}`;
    }

    const module = it.parent !== undefined ? moduleOf.get(it.parent) : undefined;
    if (module !== undefined) modules[module].items.push(...entries);
    else loose.items.push(...entries);
  }
  if (loose.items.length) modules.unshift(loose);
  out.modules = modules;

  // Grade book columns that aren't course items (an in-class exam, a participation grade) still have due dates.
  for (const c of columns) {
    const contentId = text(c, "contentId");
    if ((contentId !== undefined && assigned.has(contentId)) || textAt(c, ["grading", "type"]) === "Calculated") continue;
    const due = textAt(c, ["grading", "due"]);
    if (due === undefined) continue;
    out.assignments.push({
      title: text(c, "name") ?? "Untitled",
      due,
      points: asNumber(field(field(c, "score"), "possible")) ?? null,
      html: text(c, "description") ?? "",
      url: null,
    });
  }

  try {
    const list = await paged(s, `${API}/v1/courses/${cid}/announcements?limit=100`);
    for (const a of list) {
      out.announcements.push({
        title: text(a, "title") ?? "Announcement",
        posted: textAt(a, ["availability", "duration", "start"]) ?? text(a, "created") ?? null,
        html: fixBody(base, text(a, "body") ?? ""),
      });
    }
    out.announcements = out.announcements
      .map((a, n) => ({ a, n }))
      .sort((x, y) => {
        const p = x.a.posted;
        const q = y.a.posted;
        if (p !== q) {
          if (p === null) return 1;
          if (q === null) return -1;
          return p < q ? 1 : -1;
        }
        return x.n - y.n;
      })
      .map((x) => x.a);
  } catch (e) {
    rethrowFatal(e);
    out.skipped.push(`Announcements (${plain(e as LmsError)})`);
  }
  return out;
}

/**
 * Signed out, cancelled, or a listing that couldn't be read in full: the whole
 * course stops (a partial listing would look complete).
 */
function rethrowFatal(e: unknown): void {
  if (!(e instanceof LmsError) || e.kind === "signedOut" || e.kind === "incomplete") throw e;
}

function file(name: string, url: URL, folder: string | null): RemoteFile {
  return { name, folder, url, size: null, mime: null, aliases: [], version: null };
}

/** Folders, learning modules and lesson plans: they hold other items. */
function isContainer(handler: string): boolean {
  return ["resource/x-bb-folder", "resource/x-bb-lesson", "resource/x-bb-learnmodule", "resource/x-bb-module-page", "resource/x-bb-lessonplan"].includes(handler);
}

/** Items the grade book tracks: assignments, tests and surveys. */
function isGradable(handler: string): boolean {
  return ["resource/x-bb-assignment", "resource/x-bb-asmt-test-link", "resource/x-bb-asmt-survey-link"].includes(handler);
}

function hasAttachments(handler: string): boolean {
  return ["resource/x-bb-file", "resource/x-bb-document", "resource/x-bb-assignment", "resource/x-bb-syllabus"].includes(handler);
}

/** The signed-in user's id (`GET /learn/api/public/v1/users/me`). */
function account(s: Session): Promise<string> {
  return whoami(s);
}

/** The person's user id. 401/403 or a login page from this call: signed out. */
async function whoami(s: Session): Promise<string> {
  let me: unknown;
  try {
    me = await s.getJson(`${API}/v1/users/me`);
  } catch (e) {
    if (isLmsError(e, "forbidden") || isLmsError(e, "notFound")) throw LmsError.signedOut();
    throw e;
  }
  const id = text(me, "id");
  if (id === undefined) throw LmsError.signedOut();
  return id;
}

/** Every result of a listing, following `paging.nextPage` (a path on the site). */
async function paged(s: Session, first: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let next: string | undefined = first;
  let pages = 0;
  const seen = new Set<string>();
  while (next !== undefined) {
    const path: string = next;
    next = undefined;
    let canonical: URL;
    try {
      canonical = new URL(path, s.site.base);
    } catch {
      throw LmsError.incomplete("Blackboard returned an invalid next page.");
    }
    if (!s.site.owns(canonical)) throw LmsError.incomplete("Blackboard pointed the remaining list at another site. The list is incomplete.");
    if (seen.has(canonical.href)) throw LmsError.incomplete("Blackboard repeated a list page. The list is incomplete; try importing again.");
    seen.add(canonical.href);
    const v = await s.getJson(path);
    if (Array.isArray(v)) out.push(...v);
    else out.push(...(asArray(field(v, "results")) ?? []));
    pages++;
    next = textAt(v, ["paging", "nextPage"]);
    if (next !== undefined && pages >= MAX_PAGES) {
      throw LmsError.incomplete(`Blackboard has more than ${MAX_PAGES} list pages. The list is incomplete; narrow the selection before retrying.`);
    }
  }
  return out;
}

function field(v: unknown, k: string): unknown {
  return asObject(v)?.[k];
}

function text(v: unknown, key: string): string | undefined {
  const t = asString(field(v, key));
  return t !== undefined && t !== "" ? t : undefined;
}

function textAt(v: unknown, keys: string[]): string | undefined {
  let at = v;
  for (const k of keys) {
    at = field(at, k);
    if (at === undefined) return undefined;
  }
  return typeof at === "string" && at !== "" ? at : undefined;
}

function parseUrl(raw: string | undefined): URL | null {
  if (raw === undefined) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The item as the person sees it on the site (the Ultra outline opens it; Original redirects there too). */
function itemUrl(base: URL, course: string, contentId: string): URL {
  return new URL(`/ultra/courses/${enc(course)}/outline/edit/document/${enc(contentId)}?courseId=${enc(course)}`, base);
}

/** The address Ultra uses to open a file item; it redirects to the file. */
function nautilus(base: URL, course: string, contentId: string, parent: string | undefined): URL {
  const pairs: [string, string][] = [
    ["redirectType", "nautilus"],
    ["courseId", course],
    ["contentId", contentId],
  ];
  if (parent !== undefined) pairs.push(["parentId", parent]);
  return new URL(`/ultra/redirect?${pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&")}`, base);
}

/** Learn's editor stores embedded files with a placeholder instead of the site address. */
function fixBody(base: URL, html: string): string {
  const root = base.href.replace(/\/+$/, "");
  return html.split("@X@EmbeddedFile.requestUrlStub@X@").join(`${root}/`).split("@X@EmbeddedFile.location@X@").join(`${root}/`);
}

/** `/bbcswebdav/` files linked or embedded in an HTML body, with the name the editor gave them. */
function webdavLinks(base: URL, html: string): [URL, string][] {
  const out: [URL, string][] = [];
  for (const attr of ['href="', 'src="', "href='", "src='"]) {
    const quote = attr[attr.length - 1];
    let rest = html;
    for (;;) {
      const i = rest.indexOf(attr);
      if (i < 0) break;
      const after = rest.slice(i + attr.length);
      const end = after.indexOf(quote);
      if (end < 0) break;
      const raw = after.slice(0, end).replace(/&amp;/g, "&");
      rest = after.slice(end);
      if (!raw.includes("/bbcswebdav/")) continue;
      let url: URL;
      try {
        url = new URL(raw, base);
      } catch {
        continue;
      }
      if (url.origin !== base.origin || out.some(([u]) => u.href === url.href)) continue;
      // The link's own words name the file when they look like a file name ("Week 1 slides.pdf").
      const words = attr.startsWith("href") ? anchorText(rest) : null;
      const textName = words !== null && words.includes(".") && Buffer.byteLength(words) < 200 ? words : null;
      const last = percentDecode(url.pathname.split("/").pop() ?? "");
      out.push([url, textName ?? (last === "" ? "file" : last)]);
    }
  }
  return out;
}

/** The words inside an `<a>` tag, given the HTML just after its `href` value. */
function anchorText(afterHref: string): string | null {
  const gt = afterHref.indexOf(">");
  if (gt < 0) return null;
  const start = gt + 1;
  const close = afterHref.indexOf("</a", start);
  if (close < 0) return null;
  let t = "";
  let inTag = false;
  for (const c of afterHref.slice(start, close)) {
    if (c === "<") inTag = true;
    else if (c === ">") inTag = false;
    else if (!inTag) t += c;
  }
  const words = splitWhitespace(t.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")).join(" ");
  return words !== "" ? words : null;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function plain(e: LmsError): string {
  if (e.kind === "forbidden") return "the course site didn’t allow reading it";
  if (e.kind === "notFound") return "the course site couldn’t find it";
  return e.message;
}

/** One path segment: Learn ids (`_123_1`) pass as they are; anything else is percent-encoded. */
function enc(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_.~-]/.test(c)) out += c;
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Now in UTC as `YYYY-MM-DDTHH:MM:SSZ`, to compare with Learn's dates (also UTC, `Z`). */
function nowRfc3339(): string {
  return rfc3339(Math.floor(Date.now() / 1000));
}

function rfc3339(secs: number): string {
  return new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Rust's `str::parse::<f64>` succeeds. */
function parsesAsF64(s: string): boolean {
  return /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i.test(s);
}

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ---- Grades ----------------------------------------------------------------
//
// The grade book's columns (`/v2/courses/{id}/gradebook/columns`: name, points
// possible, due date, category; the "external grade" column is the course's
// overall grade) and the person's own grades (`/v2/courses/{id}/gradebook/users/{me}`,
// or one column at a time where that list is refused). A column hidden from
// students, or a grade not released, isn't there: simply absent.

async function grades(s: Session, courseId: string): Promise<CourseGrades> {
  const me = await whoami(s);
  const cid = enc(courseId);
  let columns: unknown[];
  try {
    columns = await paged(s, `${API}/v2/courses/${cid}/gradebook/columns?limit=100`);
  } catch (e) {
    return gradesRefused(e);
  }
  const mine = new Map<string, unknown>();
  try {
    for (const g of await paged(s, `${API}/v2/courses/${cid}/gradebook/users/${enc(me)}?limit=100`)) {
      const c = text(g, "columnId");
      if (c !== undefined) mine.set(c, g);
    }
  } catch (e) {
    if (!(e instanceof LmsError) || e.kind === "signedOut" || e.kind === "network") throw e;
    // Some sites refuse the list but let a student read each of their own grades.
    for (const c of columns) {
      const col = text(c, "id");
      if (col === undefined) continue;
      try {
        mine.set(col, await s.getJson(`${API}/v2/courses/${cid}/gradebook/columns/${enc(col)}/users/${enc(me)}`));
      } catch (e2) {
        if (!(e2 instanceof LmsError) || e2.kind === "signedOut" || e2.kind === "network") throw e2;
      }
    }
  }
  const categories = new Map<string, string>();
  try {
    for (const c of await paged(s, `${API}/v1/courses/${cid}/gradebook/categories`)) {
      const id = text(c, "id");
      const title = text(c, "title");
      if (id !== undefined && title !== undefined) categories.set(id, title);
    }
  } catch (e) {
    if (!(e instanceof LmsError) || e.kind === "signedOut") throw e;
  }

  const out: CourseGrades = { current: {}, groups: [], items: [] };
  const groups: string[] = [];
  for (const c of columns) {
    const col = text(c, "id");
    if (col === undefined) continue;
    if (textAt(c, ["availability", "available"]) === "No") continue;
    const name = rustTrim(text(c, "displayName") ?? text(c, "name") ?? "");
    const possible = asNumber(field(field(c, "score"), "possible"));
    const g = mine.get(col);
    const score = g !== undefined ? (asNumber(field(g, "score")) ?? asNumber(field(field(g, "displayGrade"), "score"))) : undefined;
    let shown = g !== undefined ? (textAt(g, ["displayGrade", "text"]) ?? text(g, "text")) : undefined;
    if (shown !== undefined) shown = rustTrim(shown);
    if (shown === "" || (shown !== undefined && parsesAsF64(rustTrim(shown.replace(/%+$/, ""))))) shown = undefined;
    const status = (g !== undefined ? text(g, "status") : undefined) ?? "";
    const excused = field(g, "exempt") === true;
    if (field(c, "externalGrade") === true) {
      const scale = (g !== undefined ? textAt(g, ["displayGrade", "scaleType"]) : undefined) ?? "";
      const percent = scale === "Percent" ? asNumber(field(field(g, "displayGrade"), "score")) : undefined;
      out.current = compact<GradeSummary>({
        percent: percent ?? percentOf(score, possible),
        letter: shown,
        points: score,
        possible: score !== undefined ? possible : undefined,
      });
      continue;
    }
    if (!name) continue;
    const catId = text(c, "gradebookCategoryId");
    const group = catId !== undefined ? categories.get(catId) : undefined;
    if (group !== undefined && !groups.includes(group)) groups.push(group);
    const fb = g !== undefined ? text(g, "feedback") : undefined;
    const feedback = fb !== undefined ? splitWhitespace(scan(fb, null).text).join(" ") : "";
    out.items.push(
      compact(
        gradeItem(name, {
          group,
          score,
          possible,
          percent: percentOf(score, possible),
          grade: shown,
          due: textAt(c, ["grading", "due"]),
          submitted: status === "NeedsGrading" || status === "Graded",
          graded: (status === "Graded" && score !== undefined) || excused,
          excused,
          comments: feedback !== "" ? [feedback] : [],
        }),
      ),
    );
  }
  out.groups = groups.map((name) => ({ name }));
  return out;
}

export const blackboard: Adapter = { loginUrl, loginResult, courses, content, grades, account };

/** Tests only. */
export const blackboardInternals = { paged, rfc3339, enc, routerField, MAX_PAGES };
