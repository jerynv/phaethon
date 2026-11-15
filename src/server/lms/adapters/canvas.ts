/**
 * Canvas. The person signs in on the school's own login page; Phaethon then
 * reads the Canvas REST API (`/api/v1`) with the session that sign-in left,
 * the way Canvas's own web pages do. GETs only: nothing on the site changes.
 *
 * Which endpoints carry the useful data, their parameters and their shapes
 * follow two Canvas MCP servers, ported from API tokens to the person's session:
 * - canvas-mcp, https://github.com/vishalsachdev/canvas-mcp, MIT License,
 *   Copyright (c) 2025 Vishal Sachdev
 * - canvas-mcp, https://github.com/r-huijts/canvas-mcp, MIT License,
 *   Copyright (c) 2024 R.Huijts
 *
 * Grades (`grades`) follow the Canvas REST API docs (enrollments, submissions,
 * assignment groups) and the grade tools of vishalsachdev/canvas-mcp above.
 */

import { HttpError, type HttpResponse } from "../http.ts";
import { resourceUrls } from "../html.ts";
import type { Session } from "../session.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  Cancelled,
  emptyContent,
  formEncode,
  GRADES_HIDDEN,
  gradeItem,
  isLmsError,
  LmsError,
  percentDecode,
  percentOf,
  rustTrim,
  rustTrimStart,
  splitWhitespace,
  summaryIsEmpty,
  type Announcement,
  type Assignment,
  type Course,
  type CourseContent,
  type CourseGrades,
  type Credential,
  type GradeItem,
  type GradeSummary,
  type Link,
  type LoginNav,
  type Page,
  type RemoteFile,
} from "../types.ts";
import type { Adapter } from "./adapter.ts";


/** Canvas's session cookie (older and self-hosted sites use the second name). */
const SESSION_COOKIES = ["_normandy_session", "canvas_session"];
/** Pages of results followed for one list, at 100 a page. */
const MAX_PAGES = 100;
/** Same order of work as a complete 100-page list, not a silent 300-file prefix. */
const MAX_REFERENCED = MAX_PAGES * 100;

/**
 * Canvas throttles with a 403 ("403 Forbidden (Rate Limit Exceeded)"), which
 * would otherwise read as "not open to you". A part that answers 403 is asked
 * again after these pauses before it counts as closed. If the session layer
 * marks a 403 with `rateLimited: false`, it counts as closed at once.
 */
let retryDelaysMs = [250, 1000, 2000];

/** Tests only: shorter pauses before a 403 counts as closed. */
export function setForbiddenRetryDelaysForTests(delays: number[]): void {
  retryDelaysMs = delays;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Cancelled());
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function loginUrl(base: URL): URL {
  return new URL("/login", base);
}

/**
 * Signed in once the window is back on the site, past the login pages, holding
 * Canvas's session cookie. (The cookie alone isn't enough: Canvas sets it on
 * the login page too.)
 */
function loginResult(base: URL, nav: LoginNav): Credential | null {
  if (nav.url.origin !== base.origin) return null;
  const path = nav.url.pathname;
  if (["/login", "/logout", "/register"].some((p) => path.startsWith(p))) return null;
  if (!nav.cookies.some((c) => SESSION_COOKIES.includes(c.name) && c.value !== "")) return null;
  const token = nav.cookies.find((c) => c.name === "_csrf_token");
  const csrf = token ? percentDecode(token.value) : "";
  return { cookies: nav.cookies.map((c) => ({ ...c })), csrf: csrf !== "" ? csrf : null };
}

/** The person's courses: those running now, then past ones (concluded enrollments). */
async function courses(s: Session): Promise<Course[]> {
  const now = nowSecs();
  const list = (state: string) =>
    api(s, ["courses"], [
      ["enrollment_state", state],
      ["include[]", "term"],
      ["per_page", "100"],
    ]);
  const active = await getAll(s, list("active"));
  let past: unknown[] = [];
  try {
    past = await getAll(s, list("completed"));
  } catch (e) {
    if (isLmsError(e, "signedOut") || isLmsError(e, "network") || isLmsError(e, "incomplete") || !(e instanceof LmsError)) throw e;
  }
  const seen = new Set<string>();
  const out: Course[] = [];
  for (const [v, concluded] of [...active.map((v) => [v, false] as const), ...past.map((v) => [v, true] as const)]) {
    const c = courseFrom(v, concluded, now);
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

/** The signed-in user's id: `GET /api/v1/users/self` (Canvas Users API, "Show user details"). */
async function account(s: Session): Promise<string> {
  const me = await getOne(s, api(s, ["users", "self"], []));
  const id = idStr(field(me, "id"));
  if (id === undefined) throw unexpected("no user id");
  return id;
}

function courseFrom(v: unknown, concluded: boolean, now: number): Course | null {
  const id = idStr(field(v, "id"));
  if (id === undefined) return null;
  const rawName = asString(field(v, "name"));
  if (rawName === undefined) return null;
  const name = rustTrim(rawName);
  if (!name) return null;
  const codeRaw = asString(field(v, "course_code"));
  const codeT = codeRaw !== undefined ? rustTrim(codeRaw) : undefined;
  const code = codeT && codeT !== name ? codeT : null;
  const term = field(v, "term");
  const termRaw = asString(field(term, "name"));
  const termT = termRaw !== undefined ? rustTrim(termRaw) : undefined;
  const termName = termT && termT !== "Default Term" ? termT : null;
  // The course's own dates win only when it's set to override the term's.
  const dates = field(v, "restrict_enrollments_to_course_dates") === true ? v : term;
  const end = unixOf(asString(field(dates, "end_at")));
  const start = unixOf(asString(field(dates, "start_at")));
  const ended = end !== null && end < now;
  const notStarted = start !== null && start > now;
  const current = !concluded && asString(field(v, "workflow_state")) !== "completed" && !ended && !notStarted;
  return { id, name, code, term: termName, current };
}

type Item =
  | { kind: "file"; id: string; title: string }
  | { kind: "page"; slug: string; title: string }
  | { kind: "assignment"; id: string; title: string }
  | { kind: "other"; title: string };

async function content(s: Session, courseId: string): Promise<CourseContent> {
  if (!/^[0-9]+$/.test(courseId)) throw LmsError.notFound("Your course site couldn’t find this course.");
  const cid = courseId;
  const course = await getOne(s, api(s, ["courses", cid], [["include[]", "syllabus_body"]]));
  const c = emptyContent();
  const syl = asString(field(course, "syllabus_body"));
  c.syllabus = syl !== undefined && rustTrim(syl) !== "" ? syl : null;

  const ignore: string[] = [];
  const tabs = new Tabs((await part(s, () => getAll(s, api(s, ["courses", cid, "tabs"], [["per_page", "100"]])), "", ignore)) ?? null);
  if (c.syllabus === null && !tabs.open("syllabus")) tabs.note(c.skipped, "syllabus", "Syllabus");
  for (const t of tabs.external()) c.skipped.push(`${t}: an outside tool, open it on the course site`);

  // Files, with their folder paths.
  let folders = new Map<string, string | null>();
  try {
    folders = folderPaths(await getAll(s, api(s, ["courses", cid, "folders"], [["per_page", "100"]])));
  } catch (e) {
    if (isLmsError(e, "incomplete") || !(e instanceof LmsError)) throw e;
  }
  const files = new Files();
  if (tabs.open("files")) {
    const list = await part(s, () => getAll(s, api(s, ["courses", cid, "files"], [["per_page", "100"]])), "Files", c.skipped);
    if (list) for (const v of list) files.add(s, cid, v, folders, c.skipped);
  } else tabs.note(c.skipped, "files", "Files");

  // Pages: the list has no bodies, so each is fetched.
  const pages: [string, Page][] = [];
  if (tabs.open("pages")) {
    const list = await part(s, () => getAll(s, api(s, ["courses", cid, "pages"], [["per_page", "100"]])), "Pages", c.skipped);
    if (list) {
      const slugs = list.map((p) => asString(field(p, "url"))).filter((x): x is string => x !== undefined);
      const got = await buffered(
        slugs.map((slug) => () => attempt(() => getOne(s, api(s, ["courses", cid, "pages", slug], [])))),
        4,
      );
      for (let i = 0; i < slugs.length; i++) {
        const v = await partOf(s, got[i], `Page “${slugs[i]}”`, c.skipped);
        if (v !== undefined) pageInto(s, cid, slugs[i], v, pages, c.skipped);
      }
    }
  } else tabs.note(c.skipped, "pages", "Pages");

  const assignments: [string, Assignment][] = [];
  if (tabs.open("assignments")) {
    const url = api(s, ["courses", cid, "assignments"], [
      ["order_by", "due_at"],
      ["per_page", "100"],
    ]);
    const list = await part(s, () => getAll(s, url), "Assignments", c.skipped);
    if (list)
      for (const v of list) {
        const a = assignmentFrom(s, v);
        if (a) assignments.push(a);
      }
  } else tabs.note(c.skipped, "assignments", "Assignments");

  if (tabs.open("announcements")) {
    const url = api(s, ["courses", cid, "discussion_topics"], [
      ["only_announcements", "true"],
      ["per_page", "100"],
    ]);
    const list = await part(s, () => getAll(s, url), "Announcements", c.skipped);
    if (list) c.announcements = list.map(announcementFrom).filter((a): a is Announcement => a !== null);
  } else tabs.note(c.skipped, "announcements", "Announcements");

  // Modules, in order. Their items name files, pages and assignments that the
  // lists above may not have (a tab hidden from students still lets a module link its pages).
  const modules: [string, Item[]][] = [];
  const links: Link[] = [];
  if (tabs.open("modules")) {
    const url = api(s, ["courses", cid, "modules"], [
      ["include[]", "items"],
      ["include[]", "content_details"],
      ["per_page", "100"],
    ]);
    const list = await part(s, () => getAll(s, url), "Modules", c.skipped);
    if (list) {
      for (const m of list) {
        const name = rustTrim(asString(field(m, "name")) ?? "Module");
        let raw: unknown[];
        const items = asArray(field(m, "items"));
        if (items) raw = items;
        else {
          // Canvas leaves the items out of a long module.
          const itemsUrl = parseAbsolute(asString(field(m, "items_url")));
          if (itemsUrl) {
            const u = appendQuery(itemsUrl, [
              ["include[]", "content_details"],
              ["per_page", "100"],
            ]);
            raw = (await part(s, () => getAll(s, u), `Module “${name}”`, c.skipped)) ?? [];
          } else raw = [];
        }
        const out: Item[] = [];
        for (const it of raw) {
          const item = itemFrom(it, links);
          if (item) out.push(item);
        }
        modules.push([name, out]);
      }
    }
  } else tabs.note(c.skipped, "modules", "Modules");

  for (const [, items] of modules) {
    for (const item of items) {
      if (item.kind === "file") {
        if (!files.request(item.id)) continue;
        const v = await part(s, () => getOne(s, api(s, ["courses", cid, "files", item.id], [])), `File “${item.title}”`, c.skipped);
        if (v !== undefined) files.add(s, cid, v, folders, c.skipped);
      } else if (item.kind === "page") {
        if (pages.some(([slug]) => slug === item.slug)) continue;
        const v = await part(s, () => getOne(s, api(s, ["courses", cid, "pages", item.slug], [])), `Page “${item.title}”`, c.skipped);
        if (v !== undefined) pageInto(s, cid, item.slug, v, pages, c.skipped);
      } else if (item.kind === "assignment") {
        if (assignments.some(([id]) => id === item.id)) continue;
        const v = await part(s, () => getOne(s, api(s, ["courses", cid, "assignments", item.id], [])), `Assignment “${item.title}”`, c.skipped);
        if (v !== undefined) {
          const a = assignmentFrom(s, v);
          if (a) assignments.push(a);
        }
      }
    }
  }

  // The page index can be hidden or refused while the home page stays open.
  // Follow only this course's published page references, with a finite budget
  // and a visited set that also remembers refused/missing pages.
  const front = await part(s, () => getOne(s, api(s, ["courses", cid, "front_page"], [])), "", []);
  const frontSlug = asString(field(front, "url"));
  if (frontSlug && !pages.some(([key]) => key === frontSlug)) pageInto(s, cid, frontSlug, front, pages, c.skipped);
  const visitedPages = new Set(pages.map(([slug]) => slug));
  const pageUrls = links.map((l) => l.url);
  const queuePages = (html: string, base: URL) => {
    for (const url of resourceUrls(html, base)) pageUrls.push(url);
  };
  if (c.syllabus !== null) queuePages(c.syllabus, site(s, ["courses", cid, "assignments", "syllabus"]));
  for (const [, a] of assignments) queuePages(a.html, a.url ?? s.site.base);
  for (const a of c.announcements) queuePages(a.html, s.site.base);
  let scannedPages = 0;
  for (let i = 0; ; i++) {
    while (scannedPages < pages.length) {
      const [, p] = pages[scannedPages++];
      queuePages(p.html, p.url ?? s.site.base);
    }
    if (i >= pageUrls.length) break;
    const slug = pageRef(s, cid, pageUrls[i]);
    if (slug === null || visitedPages.has(slug)) continue;
    if (visitedPages.size >= MAX_REFERENCED) throw LmsError.incomplete(`Canvas references more than ${MAX_REFERENCED} distinct pages. The page list is incomplete; the import was not marked complete.`);
    visitedPages.add(slug);
    const v = await part(s, () => getOne(s, api(s, ["courses", cid, "pages", slug], [])), `Page “${slug}”`, c.skipped);
    if (v !== undefined) pageInto(s, cid, slug, v, pages, c.skipped);
  }

  // Files the course's own text links to (a syllabus pointing at the schedule PDF),
  // fetched one by one when the file list didn't have them or wasn't open.
  const html: string[] = [];
  if (c.syllabus !== null) html.push(c.syllabus);
  html.push(...pages.map(([, p]) => p.html), ...assignments.map(([, a]) => a.html), ...c.announcements.map((a) => a.html));
  const wanted = new Map<string, [boolean, string]>();
  for (const u of [...links.map((l) => l.url), ...html.flatMap((h) => resourceUrls(h, s.site.base))]) {
    const r = fileRef(s, cid, u);
    if (r && !files.has(r[1]) && !wanted.has(r[1])) wanted.set(r[1], r);
  }
  for (const [inCourse, id] of wanted.values()) {
    if (!files.request(id)) continue;
    const url = inCourse ? api(s, ["courses", cid, "files", id], []) : api(s, ["files", id], []);
    const v = await part(s, () => getOne(s, url), `A linked file (number ${id})`, c.skipped);
    if (v !== undefined) files.add(s, cid, v, folders, c.skipped);
  }

  c.modules = modules.map(([name, items]) => ({
    name,
    items: items.map((item) => {
      switch (item.kind) {
        case "file":
          return files.name(item.id) ?? item.title;
        case "page":
          return pages.find(([slug]) => slug === item.slug)?.[1].title ?? item.title;
        default:
          return item.title;
      }
    }),
  }));
  c.files = files.list;
  c.pages = pages.map(([, p]) => p);
  c.assignments = assignments.map(([, a]) => a);
  c.links = links;
  return c;
}

/** The course menu, as Canvas shows it to this person (null: couldn't be read, so every part is tried). */
class Tabs {
  constructor(private readonly tabs: unknown[] | null) {}

  private find(id: string): unknown {
    return this.tabs?.find((t) => asString(field(t, "id")) === id);
  }

  /** Students don't get hidden tabs at all; teachers get them marked hidden. */
  open(id: string): boolean {
    if (this.tabs === null) return true;
    const t = this.find(id);
    return t !== undefined && field(t, "hidden") !== true;
  }

  note(skipped: string[], id: string, fallback: string): void {
    const label = asString(field(this.find(id), "label")) ?? fallback;
    skipped.push(`${label}: hidden in this course`);
  }

  /** Outside tools in the menu (a publisher's homework site): only reachable on the site. */
  external(): string[] {
    if (!this.tabs) return [];
    return this.tabs
      .filter((t) => (asString(field(t, "id")) ?? "").startsWith("context_external_tool_") && field(t, "hidden") !== true)
      .map((t) => asString(field(t, "label")))
      .filter((l): l is string => l !== undefined);
  }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Runs `run`, asking again (after short pauses) when Canvas answers 403, which may be its rate limit. */
async function attempt<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<Attempt<T>> {
  for (let i = 0; ; i++) {
    try {
      return { ok: true, value: await run() };
    } catch (e) {
      const rateLimited = (e as { rateLimited?: boolean }).rateLimited;
      if (isLmsError(e, "forbidden") && rateLimited !== false && i < retryDelaysMs.length) {
        await sleep(retryDelaysMs[i], signal);
        continue;
      }
      return { ok: false, error: e };
    }
  }
}

type PartOutcome<T> = { kind: "ok"; value: T } | { kind: "closed" } | { kind: "error"; message: string };

/**
 * A part of the course that may be closed to this person. Canvas answers 401
 * both when the session has ended and when the person may not see this part,
 * so a 401 is checked against their own profile before it counts as signed out.
 */
async function outcome<T>(s: Session, r: Attempt<T>): Promise<PartOutcome<T>> {
  if (r.ok) return { kind: "ok", value: r.value };
  const e = r.error;
  if (!(e instanceof LmsError)) throw e;
  switch (e.kind) {
    case "signedOut":
      try {
        await getOne(s, api(s, ["users", "self"], []));
      } catch (check) {
        if (isLmsError(check, "signedOut") || isLmsError(check, "network") || !(check instanceof LmsError)) throw check;
      }
      return { kind: "closed" };
    case "network":
    case "incomplete":
      throw e;
    case "forbidden":
    case "notFound":
      return { kind: "closed" };
    default:
      return { kind: "error", message: e.message };
  }
}

async function partOf<T>(s: Session, r: Attempt<T>, what: string, skipped: string[]): Promise<T | undefined> {
  const o = await outcome(s, r);
  if (o.kind === "ok") return o.value;
  if (what !== "") skipped.push(o.kind === "closed" ? `${what}: not open to you in this course` : `${what}: ${o.message}`);
  return undefined;
}

async function part<T>(s: Session, run: () => Promise<T>, what: string, skipped: string[]): Promise<T | undefined> {
  return partOf(s, await attempt(run, s.signal), what, skipped);
}

/** One module item; external ones also go to `links`. Headings inside a module are left out. */
function itemFrom(v: unknown, links: Link[]): Item | null {
  const rawTitle = asString(field(v, "title"));
  if (rawTitle === undefined) return null;
  const title = rustTrim(rawTitle);
  const type = asString(field(v, "type"));
  if (type === undefined) return null;
  switch (type) {
    case "SubHeader":
      return null;
    case "File": {
      const id = idStr(field(v, "content_id"));
      return id === undefined ? null : { kind: "file", id, title };
    }
    case "Page": {
      const slug = asString(field(v, "page_url"));
      return slug === undefined ? null : { kind: "page", slug, title };
    }
    case "Assignment": {
      const id = idStr(field(v, "content_id"));
      return id === undefined ? null : { kind: "assignment", id, title };
    }
    case "ExternalUrl":
    case "ExternalTool": {
      const u = parseAbsolute(asString(field(v, "external_url")));
      if (u && (u.protocol === "https:" || u.protocol === "http:") && !links.some((l) => l.url.href === u.href)) links.push({ title, url: u });
      return { kind: "other", title };
    }
    default:
      return { kind: "other", title };
  }
}

function pageInto(s: Session, cid: string, slug: string, v: unknown, pages: [string, Page][], skipped: string[]): void {
  const title = rustTrim(asString(field(v, "title")) ?? slug);
  const html = asString(field(v, "body"));
  if (html === undefined) {
    skipped.push(`Page “${title}”: locked for now`);
    return;
  }
  const url = onSite(s, asString(field(v, "html_url"))) ?? site(s, ["courses", cid, "pages", slug]);
  pages.push([slug, { title, html, url }]);
}

function assignmentFrom(s: Session, v: unknown): [string, Assignment] | null {
  const id = idStr(field(v, "id"));
  if (id === undefined) return null;
  const name = asString(field(v, "name"));
  if (name === undefined) return null;
  return [
    id,
    {
      title: rustTrim(name),
      due: asString(field(v, "due_at")) ?? null,
      points: asNumber(field(v, "points_possible")) ?? null,
      html: asString(field(v, "description")) ?? "",
      url: onSite(s, asString(field(v, "html_url"))),
    },
  ];
}

function announcementFrom(v: unknown): Announcement | null {
  const title = asString(field(v, "title"));
  if (title === undefined) return null;
  let posted: string | null = null;
  for (const k of ["posted_at", "delayed_post_at", "created_at"]) {
    const p = asString(field(v, k));
    if (p !== undefined) {
      posted = p;
      break;
    }
  }
  return { title: rustTrim(title), posted, html: asString(field(v, "message")) ?? "" };
}

class Files {
  readonly list: RemoteFile[] = [];
  readonly ids = new Map<string, number>();
  readonly requested = new Set<string>();

  /** Whether `id` still needs fetching by itself; past the budget, the list is incomplete. */
  request(id: string): boolean {
    if (this.has(id) || this.requested.has(id)) return false;
    if (this.requested.size >= MAX_REFERENCED) {
      throw LmsError.incomplete(`Canvas references more than ${MAX_REFERENCED} distinct files. The file list is incomplete; the import was not marked complete.`);
    }
    this.requested.add(id);
    return true;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  name(id: string): string | undefined {
    const n = this.ids.get(id);
    return n === undefined ? undefined : this.list[n].name;
  }

  add(s: Session, cid: string, v: unknown, folders: Map<string, string | null>, skipped: string[]): void {
    const id = idStr(field(v, "id"));
    if (id === undefined) return;
    const nameRaw = asString(field(v, "display_name")) ?? asString(field(v, "filename"));
    const name = nameRaw !== undefined ? rustTrim(nameRaw) : "";
    if (!name) return;
    if (this.has(id)) return;
    // `hidden_for_user` means "only available with a link", not locked.
    // Canvas returns these files from published pages/modules with a usable
    // download URL. Only its actual lock decision (or empty URL) bars access.
    if (field(v, "locked_for_user") === true || asString(field(v, "url")) === "") {
      skipped.push(`File “${name}”: locked for now`);
      return;
    }
    const url = onSite(s, asString(field(v, "url"))) ?? appendQuery(site(s, ["courses", cid, "files", id, "download"]), [["download_frd", "1"]]);
    const aliases: URL[] = [
      site(s, ["courses", cid, "files", id]),
      site(s, ["courses", cid, "files", id, "download"]),
      site(s, ["courses", cid, "files", id, "preview"]),
      site(s, ["files", id]),
      site(s, ["files", id, "download"]),
      api(s, ["courses", cid, "files", id], []),
      api(s, ["files", id], []),
    ];
    const preview = onSite(s, asString(field(v, "preview_url")));
    if (preview) aliases.push(preview);
    const folderId = idStr(field(v, "folder_id"));
    const folder = folderId !== undefined ? (folders.get(folderId) ?? null) : null;
    const size = asU64(field(v, "size"));
    // The File object's `updated_at` (with its size): the same stamp means the same bytes.
    const stamp = asString(field(v, "updated_at")) ?? asString(field(v, "modified_at"));
    this.ids.set(id, this.list.length);
    this.list.push({
      name,
      folder,
      url,
      size,
      mime: asString(field(v, "content-type")) ?? null,
      aliases,
      version: stamp !== undefined && stamp !== "" ? `${stamp}/${size !== null ? String(size) : ""}` : null,
    });
  }
}

/** Folder id → its path below the course's top folder ("course files/Lectures/Week 1" → "Lectures/Week 1"; the top folder → none). */
function folderPaths(list: unknown[]): Map<string, string | null> {
  const roots = list
    .filter((f) => field(f, "parent_folder_id") === null || field(f, "parent_folder_id") === undefined)
    .map((f) => asString(field(f, "full_name")))
    .filter((x): x is string => x !== undefined);
  const out = new Map<string, string | null>();
  for (const f of list) {
    const id = idStr(field(f, "id"));
    const full = asString(field(f, "full_name"));
    if (id === undefined || full === undefined) continue;
    let below: string | undefined;
    for (const r of roots) {
      if (full === r) {
        below = "";
        break;
      }
      if (full.startsWith(r) && full.slice(r.length).startsWith("/")) {
        below = full.slice(r.length + 1);
        break;
      }
    }
    if (below === undefined) {
      const i = full.indexOf("/");
      below = i < 0 ? "" : full.slice(i + 1);
    }
    out.set(id, below !== "" ? below : null);
  }
  return out;
}

/** A file reference on this site: `[in this course, id]`. */
function fileRef(s: Session, cid: string, u: URL): [boolean, string] | null {
  if (!s.site.owns(u)) return null;
  const segs = u.pathname.split("/").slice(1);
  let found: [boolean, string] | null = null;
  if (segs.length >= 6 && segs[0] === "api" && segs[1] === "v1" && segs[2] === "courses" && segs[4] === "files") found = [segs[3] === cid, segs[5]];
  else if (segs.length >= 4 && segs[0] === "courses" && segs[2] === "files") found = [segs[1] === cid, segs[3]];
  else if (segs.length >= 4 && segs[0] === "api" && segs[1] === "v1" && segs[2] === "files") found = [false, segs[3]];
  else if (segs.length >= 2 && segs[0] === "files") found = [false, segs[1]];
  else if (segs.length >= 4 && segs[0] === "users" && segs[2] === "files") found = [false, segs[3]];
  return found && /^[0-9]+$/.test(found[1]) ? found : null;
}

/** A page on this course; other courses and origins are never traversed. */
function pageRef(s: Session, cid: string, u: URL): string | null {
  if (!s.site.owns(u)) return null;
  const match = /^\/(?:api\/v1\/)?courses\/([^/]+)\/pages\/([^/]+)\/?$/.exec(u.pathname);
  return match?.[1] === cid ? percentDecode(match[2]) : null;
}

/** Characters the url crate percent-encodes in a path segment. */
function encodeSegment(seg: string): string {
  let out = "";
  for (const b of Buffer.from(seg, "utf8")) {
    if (b < 0x21 || b > 0x7e || ' "#<>?`{}/%'.includes(String.fromCharCode(b))) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

/** `/api/v1/<segments>?<query>` on the site. */
function api(s: Session, segs: string[], query: [string, string][]): URL {
  const u = site(s, ["api", "v1", ...segs]);
  return query.length ? appendQuery(u, query) : u;
}

function site(s: Session, segs: string[]): URL {
  return new URL(`${s.site.base.origin}/${segs.map(encodeSegment).join("/")}`);
}

/** `u` with these pairs form-encoded onto its query (after any it has). */
function appendQuery(u: URL, pairs: [string, string][]): URL {
  const extra = pairs.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join("&");
  const base = u.href.replace(/#.*$/, "");
  const q = u.search ? `${base}&${extra}` : `${base.replace(/\?$/, "")}?${extra}`;
  return new URL(q + u.hash);
}

/** An address the site gave, kept only when it's on the site. */
function onSite(s: Session, raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, s.site.base);
    return s.site.owns(u) ? u : null;
  } catch {
    return null;
  }
}

function parseAbsolute(raw: string | undefined): URL | null {
  if (raw === undefined) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

async function getOne(s: Session, url: URL): Promise<unknown> {
  return (await getPage(s, url))[0];
}

/** Every page of a list, following `Link: <…>; rel="next"` while it stays on the site. */
async function getAll(s: Session, url: URL): Promise<unknown[]> {
  const out: unknown[] = [];
  const seen = new Set<string>();
  let next: URL | null = url;
  while (next) {
    if (!s.site.owns(next)) throw LmsError.other("Your course site pointed the rest of a list at another site, so Phaethon stopped there.");
    if (seen.has(next.href)) throw LmsError.incomplete("Canvas repeated a list page. The list is incomplete; try importing again.");
    seen.add(next.href);
    if (seen.size > MAX_PAGES) throw LmsError.incomplete(`Canvas has more than ${MAX_PAGES} list pages. The list is incomplete; narrow the selection before retrying.`);
    const [v, n]: [unknown, URL | null] = await getPage(s, next);
    if (!Array.isArray(v)) throw unexpected("a list was expected");
    out.push(...v);
    next = n;
  }
  return out;
}

/**
 * One API response: its JSON (minus the `while(1);` guard Canvas puts in front
 * of JSON for a browser session) and the next page's address. Landing on the
 * login page, or getting HTML back, means the session has ended.
 */
async function getPage(s: Session, url: URL): Promise<[unknown, URL | null]> {
  const res = await s.get(url);
  const at = res.url;
  if (!s.site.owns(at)) {
    res.discard();
    throw unexpected("it answered from another site");
  }
  if (at.pathname.startsWith("/login")) {
    res.discard();
    throw LmsError.signedOut();
  }
  if ((res.header("content-type") ?? "").startsWith("text/html")) {
    res.discard();
    throw LmsError.signedOut();
  }
  let next: URL | null = null;
  for (const h of res.headerAll("link")) {
    const l = nextLink(h);
    if (l !== null) {
      try {
        next = new URL(l, at);
      } catch {
        next = null;
      }
      break;
    }
  }
  let body = rustTrimStart(await readText(res));
  if (body.startsWith("while(1);")) body = body.slice("while(1);".length);
  try {
    return [JSON.parse(body), next];
  } catch (e) {
    throw unexpected((e as Error).message);
  }
}

async function readText(res: HttpResponse): Promise<string> {
  try {
    return await res.text();
  } catch (e) {
    if (e instanceof HttpError) throw LmsError.network(e.message);
    throw e;
  }
}

function unexpected(why: string): LmsError {
  return LmsError.other(`Your course site sent something unexpected: ${why}`);
}

/** The `rel="next"` target of a Link header. */
function nextLink(header: string): string | null {
  let rest = header;
  for (;;) {
    const start = rest.indexOf("<");
    if (start < 0) return null;
    const after = rest.slice(start + 1);
    const end = after.indexOf(">");
    if (end < 0) return null;
    const tail = after.slice(end + 1);
    const lt = tail.indexOf("<");
    const params = tail.slice(0, lt < 0 ? tail.length : lt);
    const isNext = params.split(/[;,]/).some((p) => {
      const eq = p.indexOf("=");
      if (eq < 0) return false;
      const k = p.slice(0, eq);
      const v = p.slice(eq + 1);
      return (
        rustTrim(k).toLowerCase() === "rel" &&
        splitWhitespace(rustTrim(v).replace(/^"+|"+$/g, "")).some((r) => r.toLowerCase() === "next")
      );
    });
    if (isNext) return after.slice(0, end);
    rest = tail;
  }
}

function field(v: unknown, k: string): unknown {
  return asObject(v)?.[k];
}

function idStr(v: unknown): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v !== "") return v;
  return undefined;
}

function asU64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

function intOf(s: string): number | null {
  return /^[+-]?\d+$/.test(s) ? Number(s) : null;
}

function unixOf(s: string | undefined): number | null {
  return s === undefined ? null : unix(s);
}

/** Seconds since 1970 for an ISO 8601 time as Canvas writes it (fractions and ±hh:mm offsets allowed). */
function unix(s: string): number | null {
  if (s.length < 19) return null;
  const y = intOf(s.slice(0, 4));
  const mo = intOf(s.slice(5, 7));
  const d = intOf(s.slice(8, 10));
  const h = intOf(s.slice(11, 13));
  const mi = intOf(s.slice(14, 16));
  const se = intOf(s.slice(17, 19));
  if (y === null || mo === null || d === null || h === null || mi === null || se === null) return null;
  let rest = s.slice(19);
  if (rest.startsWith(".")) rest = rest.replace(/^[.0-9]+/, "");
  let offset: number;
  if (rest === "" || rest === "Z" || rest === "z") offset = 0;
  else if (rest.length === 6) {
    const sign = rest[0] === "+" ? 1 : rest[0] === "-" ? -1 : 0;
    if (!sign) return null;
    const oh = intOf(rest.slice(1, 3));
    const om = intOf(rest.slice(4, 6));
    if (oh === null || om === null) return null;
    offset = sign * (oh * 3600 + om * 60);
  } else return null;
  // Days from civil date (Howard Hinnant's algorithm).
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.trunc((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const days = era * 146_097 + yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy - 719_468;
  return days * 86_400 + h * 3600 + mi * 60 + se - offset;
}

/** Rust's `str::parse::<f64>` succeeds. */
function parsesAsF64(s: string): boolean {
  return /^[+-]?(\d+\.?\d*([eE][+-]?\d+)?|\.\d+([eE][+-]?\d+)?|inf|infinity|nan)$/i.test(s);
}

/** Runs the tasks at most `n` at a time, results in order. */
async function buffered<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
  return out;
}

function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

// ---- Grades ----------------------------------------------------------------

/**
 * A grade read where Canvas may refuse: undefined when the person may not see
 * it (Canvas answers 401 for that too, so a 401 is checked against their profile).
 */
async function gradePart<T>(s: Session, run: () => Promise<T>): Promise<T | undefined> {
  const o = await outcome(s, await attempt(run, s.signal));
  if (o.kind === "ok") return o.value;
  if (o.kind === "closed") return undefined;
  throw LmsError.other(o.message);
}

/**
 * The person's grades in a course: the course grade from their own enrollment
 * (`grades.current_score` / `final_score`, as Canvas computes them), every
 * assignment's submission with its score, flags and comments, and the
 * assignment groups with their weights when the course weights them.
 */
async function grades(s: Session, courseId: string): Promise<CourseGrades> {
  if (!/^[0-9]+$/.test(courseId)) throw LmsError.notFound("Your course site couldn’t find this course.");
  const cid = courseId;
  const enrollmentsUrl = api(s, ["courses", cid, "enrollments"], [
    ["user_id", "self"],
    ["type[]", "StudentEnrollment"],
    ["include[]", "current_points"],
    ["per_page", "100"],
  ]);
  const enrollments = await gradePart(s, () => getAll(s, enrollmentsUrl));
  if (enrollments === undefined) return { current: {}, groups: [], items: [], note: GRADES_HIDDEN };
  const course = await gradePart(s, () => getOne(s, api(s, ["courses", cid], [])));
  const weighted = field(course, "apply_assignment_group_weights") === true;
  const groups = (await gradePart(s, () => getAll(s, api(s, ["courses", cid, "assignment_groups"], [["per_page", "100"]])))) ?? [];
  const subsUrl = api(s, ["courses", cid, "students", "submissions"], [
    ["student_ids[]", "self"],
    ["include[]", "assignment"],
    ["include[]", "submission_comments"],
    ["per_page", "100"],
  ]);
  const subs = (await gradePart(s, () => getAll(s, subsUrl))) ?? [];

  const out: CourseGrades = { current: {}, groups: [], items: [] };
  const groupNames = new Map<string, string>();
  for (const g of groups) {
    const id = idStr(field(g, "id"));
    const nameRaw = asString(field(g, "name"));
    const name = nameRaw !== undefined ? rustTrim(nameRaw) : "";
    if (id === undefined || !name) continue;
    groupNames.set(id, name);
    out.groups.push(compact({ name, weight: weighted ? asNumber(field(g, "group_weight")) : undefined }));
  }
  out.items = subs.map((v) => gradeItemFrom(v, groupNames)).filter((i): i is GradeItem => i !== null);
  const key = (i: GradeItem) => (i.due !== undefined ? unix(i.due) : null);
  out.items = out.items
    .map((item, n) => ({ item, n, t: key(item) }))
    .sort((a, b) => {
      if ((a.t === null) !== (b.t === null)) return a.t === null ? 1 : -1;
      if (a.t !== null && b.t !== null && a.t !== b.t) return a.t - b.t;
      return a.n - b.n;
    })
    .map((x) => x.item);

  const e = enrollments.find((e) => {
    const t = asString(field(e, "type"));
    return t === undefined || t === "StudentEnrollment";
  });
  if (e !== undefined) {
    const g = field(e, "grades");
    const num = (k: string) => asNumber(field(g, k)) ?? asNumber(field(e, `computed_${k}`));
    const letter = (k: string) => {
      const raw = asString(field(g, k)) ?? asString(field(e, `computed_${k}`));
      const t = raw !== undefined ? rustTrim(raw) : "";
      return t !== "" ? t : undefined;
    };
    out.current = compact<GradeSummary>({ percent: num("current_score"), letter: letter("current_grade"), points: asNumber(field(g, "current_points")) });
    // Points out of what's been graded, when the course grade is plain points (unweighted).
    if (out.current.points !== undefined && !weighted) {
      const possible = out.items.filter((i) => i.score !== undefined && !i.excused).reduce((sum, i) => sum + (i.possible ?? 0), 0);
      if (possible > 0) out.current.possible = possible;
    }
    const fin = compact<GradeSummary>({ percent: num("final_score"), letter: letter("final_grade") });
    // Only worth saying when it differs from the grade so far (work still ungraded counts as zero).
    if (!summaryIsEmpty(fin) && (fin.percent !== out.current.percent || fin.letter !== out.current.letter)) out.final = fin;
  }
  return out;
}

function gradeItemFrom(v: unknown, groups: Map<string, string>): GradeItem | null {
  const a = field(v, "assignment");
  const nameRaw = asString(field(a, "name"));
  if (nameRaw === undefined) return null;
  const title = rustTrim(nameRaw);
  if (!title || field(a, "published") === false) return null;
  const state = asString(field(v, "workflow_state")) ?? "";
  const score = asNumber(field(v, "score"));
  const possible = asNumber(field(a, "points_possible"));
  const excused = field(v, "excused") === true;
  // "A-", "complete": the grade as shown, when it isn't just the score.
  const gradeRaw = asString(field(v, "grade"));
  const gradeT = gradeRaw !== undefined ? rustTrim(gradeRaw) : "";
  const grade = gradeT !== "" && !parsesAsF64(gradeT) ? gradeT : undefined;
  const comments = (asArray(field(v, "submission_comments")) ?? [])
    .map((c) => asString(field(c, "comment")))
    .filter((t): t is string => t !== undefined)
    .map((t) => splitWhitespace(t).join(" "))
    .filter((t) => t !== "");
  const groupId = idStr(field(a, "assignment_group_id"));
  return compact(
    gradeItem(title, {
      group: groupId !== undefined ? groups.get(groupId) : undefined,
      score,
      possible,
      percent: percentOf(score, possible),
      grade: excused ? undefined : grade,
      due: asString(field(a, "due_at")),
      submitted: asString(field(v, "submitted_at")) !== undefined || state === "submitted" || state === "pending_review",
      // Graded but not posted: Canvas leaves the score out, so it doesn't count as graded here.
      graded: (state === "graded" && (score !== undefined || asString(field(v, "grade")) !== undefined)) || excused,
      late: field(v, "late") === true,
      missing: field(v, "missing") === true,
      excused,
      comments,
    }),
  );
}

export const canvas: Adapter = { loginUrl, loginResult, courses, content, grades, account };

/** Tests only. */
export const canvasInternals = { getAll, nextLink, unix, folderPaths, Files, MAX_PAGES, MAX_REFERENCED };
