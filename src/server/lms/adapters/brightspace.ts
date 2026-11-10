/**
 * Brightspace (D2L), read through its Valence API (`/d2l/api/...`) with the
 * person's own browser session: the `d2lSessionVal` and `d2lSecureSessionVal`
 * cookies their sign-in leaves. No OAuth app, no API token.
 *
 * Which endpoints give the useful data, their shapes, bookmark paging and how a
 * dead session shows itself are adapted from brightspace-mcp-server
 * (https://github.com/RohanMuppa/brightspace-mcp-server), MIT licence,
 * Copyright (c) 2026 Rohan Muppa. That server trades the session for a Bearer
 * token at `/d2l/lp/auth/oauth2/token`; Phaethon doesn't, and sends the session
 * cookies on GETs only. Endpoint details: the Valence docs
 * (https://docs.valence.desire2learn.com).
 *
 * CSRF: D2L's web UI reads its XSRF token from `GET /d2l/lp/auth/xsrf-tokens`
 * and sends it as `X-Csrf-Token`. Writes need it; every call here is a GET,
 * which the session cookies alone allow, so `Credential.csrf` stays null.
 *
 * A session that has ended shows up as 401, a redirect to `/d2l/login`, a 200
 * HTML page (the `/d2l/login?sessionExpired=1` stub) where JSON was asked for,
 * or 403 from `whoami`: all of them are signed out.
 */
import { scan } from "../html.ts";
import type { Session } from "../session.ts";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  formEncode,
  gradeItem,
  gradesRefused,
  isLmsError,
  LmsError,
  oneLine,
  percentDecodeStrict,
  percentOf,
  remoteFile,
  rustTrim,
  emptyContent,
  type Course,
  type CourseContent,
  type CourseGrades,
  type Credential,
  type GradeSummary,
  type LoginNav,
  type RemoteFile,
} from "../types.ts";
import type { Adapter } from "./adapter.ts";

const SESSION_COOKIES = ["d2lSessionVal", "d2lSecureSessionVal"];
/** Bookmark pages followed at most (a server repeating "more" can't loop us). */
export const MAX_PAGES = 200;
/** Largest HTML topic read into a page. */
const MAX_HTML = 5 * 1024 * 1024;

type Json = Record<string, unknown>;

function loginUrl(base: URL): URL {
  return new URL("/d2l/login", base);
}

/**
 * Signed in once the window is back on the site past the login and auth pages
 * and both session cookies hold a value.
 */
function loginResult(base: URL, nav: LoginNav): Credential | null {
  const u = nav.url;
  if (u.origin !== base.origin) return null;
  const path = u.pathname.toLowerCase();
  if (!path.startsWith("/d2l/") || path.startsWith("/d2l/login") || path.startsWith("/d2l/logout") || path.startsWith("/d2l/lp/auth/")) return null;
  const has = (name: string) => nav.cookies.some((c) => c.name === name && c.value !== "");
  if (!SESSION_COOKIES.every(has)) return null;
  return { cookies: nav.cookies.filter((c) => c.value !== "").map((c) => ({ ...c })), csrf: null };
}

// ---- Valence shapes (only the fields read) ----

function str(o: Json | undefined, k: string): string {
  return asString(o?.[k]) ?? "";
}

function optStr(o: Json | undefined, k: string): string | null {
  return asString(o?.[k]) ?? null;
}

function bool(o: Json | undefined, k: string): boolean | null {
  const v = o?.[k];
  return typeof v === "boolean" ? v : null;
}

function int(o: Json | undefined, k: string): number | null {
  const v = asNumber(o?.[k]);
  return v === undefined ? null : v;
}

/** `RichText::to_html`: Html if non-blank, else escaped Text in a paragraph, else null. */
function richHtml(v: unknown): string | null {
  const r = asObject(v);
  if (!r) return null;
  const html = str(r, "Html");
  const text = str(r, "Text");
  if (rustTrim(html)) return html;
  if (rustTrim(text)) return `<p>${escape(text)}</p>`;
  return null;
}

function richPlain(v: unknown): string | null {
  const r = asObject(v);
  if (!r) return null;
  const text = str(r, "Text");
  const t = oneLine(rustTrim(text) ? text : scan(str(r, "Html"), null).text);
  return t || null;
}

/** The lp and le API versions this site offers (its latest of each). */
type Api = { lp: string; le: string };

async function discover(s: Session): Promise<Api> {
  let list: unknown;
  try {
    list = await s.getJson("/d2l/api/versions/");
  } catch (e) {
    if (isLmsError(e, "signedOut") || isLmsError(e, "network") || !(e instanceof LmsError)) throw e;
    throw LmsError.unsupported("This Brightspace site didn’t say which versions of its API it offers.");
  }
  const arr = asArray(list);
  if (!arr) throw LmsError.unsupported("This Brightspace site didn’t say which versions of its API it offers.");
  const pick = (code: string) => {
    for (const v of arr) {
      const o = asObject(v);
      if (o && str(o, "ProductCode").toLowerCase() === code) return asString(o.LatestVersion) ?? null;
    }
    return null;
  };
  const ok = (v: string | null): v is string => !!v && /^[0-9.]+$/.test(v);
  const lp = pick("lp");
  const le = pick("le");
  if (ok(lp) && ok(le)) return { lp, le };
  throw LmsError.unsupported("This Brightspace site doesn’t offer the parts of its API Phaethon reads.");
}

const lpPath = (api: Api, path: string) => `/d2l/api/lp/${api.lp}${path}`;
const lePath = (api: Api, ou: string, path: string) => `/d2l/api/le/${api.le}/${ou}${path}`;

/** `whoami` is open to every signed-in user, so any refusal here means the session ended. */
async function whoami(s: Session, api: Api): Promise<void> {
  try {
    await s.getJson(lpPath(api, "/users/whoami"));
  } catch (e) {
    if (isLmsError(e, "forbidden") || isLmsError(e, "notFound") || isLmsError(e, "signedOut")) throw LmsError.signedOut();
    throw e;
  }
}

/** The signed-in user's `Identifier` from `GET /d2l/api/lp/(version)/users/whoami`. */
async function account(s: Session): Promise<string> {
  const api = await discover(s);
  let me: unknown;
  try {
    me = await s.getJson(lpPath(api, "/users/whoami"));
  } catch (e) {
    if (isLmsError(e, "forbidden") || isLmsError(e, "notFound")) throw LmsError.signedOut();
    throw e;
  }
  const id = asObject(me)?.Identifier;
  if (typeof id === "string" && rustTrim(id)) return rustTrim(id);
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  throw LmsError.other("Your course site didn’t say who is signed in.");
}

/** Up to four at a time, results in order. */
async function buffered<T, R>(items: T[], f: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  return out;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p };
  } catch (error) {
    return { ok: false, error };
  }
}

async function courses(s: Session): Promise<Course[]> {
  const api = await discover(s);
  await whoami(s, api);

  // orgUnitTypeId=3: course offerings (not departments or semesters).
  const first = lpPath(api, "/enrollments/myenrollments/?orgUnitTypeId=3");
  let enrollments: Json[] = [];
  const seen = new Set<string>();
  let path = first;
  let complete = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = asObject(await s.getJson(path));
    for (const it of asArray(page?.Items) ?? []) {
      const e = asObject(it);
      const ou = asObject(e?.OrgUnit);
      if (e && ou && asNumber(ou.Id) !== undefined && typeof ou.Name === "string") enrollments.push(e);
    }
    const info = asObject(page?.PagingInfo);
    if (!info) throw LmsError.incomplete("Brightspace omitted course pagination information. The course list is incomplete.");
    const more = bool(info, "HasMoreItems");
    if (more === false) {
      complete = true;
      break;
    }
    if (more === null) throw LmsError.incomplete("Brightspace omitted whether more courses remain. The course list is incomplete.");
    const bookmark = asString(info.Bookmark);
    if (bookmark === undefined || !rustTrim(bookmark)) throw LmsError.incomplete("Brightspace reported more courses without a bookmark. The course list is incomplete.");
    if (seen.has(bookmark)) throw LmsError.incomplete("Brightspace repeated a course bookmark. The course list is incomplete.");
    seen.add(bookmark);
    path = `${first}&bookmark=${formEncode(bookmark)}`;
  }
  if (!complete) throw LmsError.incomplete(`Brightspace exceeded ${MAX_PAGES} course pages. The course list is incomplete.`);

  const ids = new Set<number>();
  enrollments = enrollments.filter((e) => {
    const id = asNumber(asObject(e.OrgUnit)!.Id)!;
    if (bool(asObject(e.Access), "CanAccess") === false || ids.has(id)) return false;
    ids.add(id);
    return true;
  });

  // The course offering has the semester and its own dates; students can be
  // refused it, and then the enrollment's dates stand.
  const offerings = await buffered(enrollments, (e) => settle(s.getJson(lpPath(api, `/courses/${asNumber(asObject(e.OrgUnit)!.Id)}`))));

  const now = nowIso();
  const out: Course[] = [];
  enrollments.forEach((e, i) => {
    const r = offerings[i];
    let off: Json | undefined;
    if (r.ok) off = asObject(r.value) ?? {};
    else if (isLmsError(r.error, "signedOut") || !(r.error instanceof LmsError)) throw r.error;
    const access = asObject(e.Access);
    const ou = asObject(e.OrgUnit)!;
    const start = optStr(off, "StartDate") ?? optStr(access, "StartDate");
    const end = optStr(off, "EndDate") ?? optStr(access, "EndDate");
    const active = (bool(access, "IsActive") ?? true) && (bool(off, "IsActive") ?? true);
    const current = active && (start === null || !after(start, now)) && (end === null || after(end, now));
    const semester = str(asObject(off?.Semester), "Name");
    const code = asString(ou.Code);
    out.push({
      id: String(asNumber(ou.Id)),
      name: asString(ou.Name)!,
      code: code !== undefined && rustTrim(code) ? code : null,
      term: rustTrim(semester) ? semester : null,
      current,
    });
  });
  return out;
}

const digitsOnly = (id: string) => id !== "" && /^[0-9]+$/.test(id);

async function content(s: Session, courseId: string): Promise<CourseContent> {
  // The id goes into paths: digits only.
  if (!digitsOnly(courseId)) throw LmsError.notFound("Your course site couldn’t find this course.");
  const ou = courseId;
  const api = await discover(s);
  await whoami(s, api);
  const base = s.site.base;
  const c = emptyContent();
  const fileUrls = new Set<string>();

  // Content: modules and their topics.
  let toc: Json = {};
  try {
    toc = asObject(await s.getJson(lePath(api, ou, "/content/toc"))) ?? {};
  } catch (e) {
    fatal(e);
    c.skipped.push("The course’s content (modules and their files) couldn’t be read.");
  }
  const htmlTopics: [string, URL][] = [];
  const syl: { topic: string | null } = { topic: null };
  walk(s, api, ou, (asArray(toc.Modules) ?? []).map((m) => asObject(m) ?? {}), [], c, fileUrls, htmlTopics, syl);

  // HTML topics become pages, read as the browser would show them so their
  // relative links resolve against the page's own address.
  const fetched = await buffered(htmlTopics, async ([title, url]) => ({ title, url, r: await settle(fetchHtml(s, url)) }));
  for (const { title, url, r } of fetched) {
    if (r.ok) {
      if (syl.topic === null && isSyllabus(title)) syl.topic = r.value;
      c.pages.push({ title, html: r.value, url });
    } else {
      fatal(r.error);
      c.skipped.push(`The page “${title}” couldn’t be read.`);
    }
  }

  // Syllabus: the course overview (and its attachment), else a content topic called Syllabus.
  let overview: Json | null = null;
  try {
    overview = asObject(await s.getJson(lePath(api, ou, "/overview"))) ?? {};
  } catch (e) {
    fatal(e);
  }
  if (overview) {
    c.syllabus = richHtml(overview.Description);
    if (overview.HasAttachment === true) {
      const url = new URL(lePath(api, ou, "/overview/attachment"), base);
      const name = (await attachmentName(s, url)) ?? "Syllabus";
      const link = `<p>Syllabus: <a href="${escape(url.href)}">${escape(name)}</a></p>`;
      c.syllabus = c.syllabus !== null ? `${c.syllabus}\n${link}` : link;
      pushFile(c, fileUrls, remoteFile(name, url));
    }
  }
  if (c.syllabus === null) c.syllabus = syl.topic;

  // Assignments (dropbox folders). One unreadable list or page only skips them.
  try {
    const first = lePath(api, ou, "/dropbox/folders/");
    const folders = await folderList(s, first, await s.getJson(first));
    for (const f of folders.filter((f) => f.IsHidden !== true)) {
      const id = asNumber(f.Id) ?? 0;
      const name = str(f, "Name");
      let html = richHtml(f.CustomInstructions) ?? "";
      for (const a of (asArray(f.Attachments) ?? []).map((x) => asObject(x) ?? {})) {
        const url = new URL(lePath(api, ou, `/dropbox/folders/${id}/attachments/${asNumber(a.FileId) ?? 0}`), base);
        const fileName = str(a, "FileName");
        html += `\n<p><a href="${escape(url.href)}">${escape(fileName)}</a></p>`;
        pushFile(c, fileUrls, remoteFile(clean(fileName), url, { folder: `Assignments/${clean(name)}`, size: asNumber(a.Size) ?? null }));
      }
      c.assignments.push({
        title: name,
        due: optStr(f, "DueDate"),
        points: asNumber(asObject(f.Assessment)?.ScoreDenominator) ?? null,
        html,
        url: new URL(`/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${id}&ou=${ou}`, base),
      });
    }
  } catch (e) {
    fatal(e);
    c.skipped.push("Assignments couldn’t be read.");
  }

  // Quizzes, for their due dates.
  try {
    const qs = await objects(s, lePath(api, ou, "/quizzes/"));
    for (const q of qs.filter((q) => q.IsActive !== false)) {
      c.assignments.push({
        title: str(q, "Name"),
        due: optStr(q, "DueDate"),
        points: null,
        html: richHtml(asObject(q.Description)?.Text) ?? "",
        url: new URL(`/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${asNumber(q.QuizId) ?? 0}&ou=${ou}`, base),
      });
    }
  } catch (e) {
    fatal(e);
    c.skipped.push("Quizzes couldn’t be read.");
  }

  // Announcements (news).
  try {
    const items = asArray(await s.getJson(lePath(api, ou, "/news/")));
    if (!items) throw LmsError.other("Your course site sent something unexpected: a list was expected");
    for (const n of items.map((x) => asObject(x) ?? {}).filter((n) => n.IsPublished !== false)) {
      let html = richHtml(n.Body) ?? "";
      for (const a of (asArray(n.Attachments) ?? []).map((x) => asObject(x) ?? {})) {
        const url = new URL(lePath(api, ou, `/news/${asNumber(n.Id) ?? 0}/attachments/${asNumber(a.FileId) ?? 0}`), base);
        const fileName = str(a, "FileName");
        html += `\n<p><a href="${escape(url.href)}">${escape(fileName)}</a></p>`;
        pushFile(c, fileUrls, remoteFile(clean(fileName), url, { folder: "Announcements", size: asNumber(a.Size) ?? null }));
      }
      c.announcements.push({ title: str(n, "Title"), posted: optStr(n, "StartDate") ?? optStr(n, "CreatedDate"), html });
    }
  } catch (e) {
    fatal(e);
    c.skipped.push("Announcements couldn’t be read.");
  }

  return c;
}

/**
 * Dropbox folders come as a bare list, or as `{Objects, Next}` on some
 * versions. A paged envelope continues from its own `Next` (page one isn't
 * asked for again).
 */
async function folderList(s: Session, first: string, value: unknown): Promise<Json[]> {
  const list = asArray(value);
  if (list) return list.map((x) => asObject(x) ?? {});
  const page = asObject(value);
  if (!page) throw LmsError.other("Brightspace content couldn’t be read: unexpected shape");
  if (page.Next === null || page.Next === undefined) return (asArray(page.Objects) ?? []).map((x) => asObject(x) ?? {});
  return objects(s, first, value);
}

/**
 * Every object of an `{Objects, Next}` endpoint. `Next` is a full address or a
 * bookmark; only addresses back into `/d2l/api/` on this site are followed.
 * `firstValue` is page one when it was already read.
 */
export async function objects(s: Session, first: string, firstValue?: unknown): Promise<Json[]> {
  const out: Json[] = [];
  const seen = new Set<string>();
  let path = first;
  let pending = firstValue;
  for (let i = 0; i < MAX_PAGES; i++) {
    if (seen.has(path)) throw LmsError.incomplete("Brightspace repeated a content page. The content list is incomplete.");
    seen.add(path);
    const value = pending !== undefined ? pending : await s.getJson(path);
    pending = undefined;
    const o = asObject(value);
    const rawNext = o ? o.Next : undefined;
    let next: string | null;
    if (rawNext === null && o && "Next" in o) next = null;
    else if (typeof rawNext === "string" && rustTrim(rawNext)) next = rawNext;
    else throw LmsError.incomplete("Brightspace omitted a valid content continuation. The content list is incomplete.");
    const objs = o!.Objects === undefined ? [] : asArray(o!.Objects);
    if (!objs) throw LmsError.other("Brightspace content couldn’t be read: Objects isn’t a list");
    out.push(...objs.map((x) => asObject(x) ?? {}));
    if (next === null) return out;
    if (next.startsWith("/") || next.includes("://")) {
      let u: URL | null = null;
      try {
        u = new URL(next, s.site.base);
      } catch {
        u = null;
      }
      if (!u || !s.site.owns(u) || !u.pathname.startsWith("/d2l/api/")) {
        throw LmsError.incomplete("Brightspace returned an invalid content continuation. The content list is incomplete.");
      }
      path = u.pathname + u.search;
    } else {
      const sep = first.includes("?") ? "&" : "?";
      path = `${first}${sep}bookmark=${formEncode(next)}`;
    }
  }
  throw LmsError.incomplete(`Brightspace exceeded ${MAX_PAGES} content pages. The content list is incomplete.`);
}

const sortOrder = (o: Json) => asNumber(o.SortOrder) ?? 0;

/**
 * Walks the table of contents: each module with topics becomes a module named
 * by its path ("Week 1 / Readings"), its file topics files in that folder, its
 * link topics links, its HTML topics pages (fetched afterwards).
 */
function walk(
  s: Session,
  api: Api,
  ou: string,
  modules: Json[],
  parents: string[],
  c: CourseContent,
  fileUrls: Set<string>,
  htmlTopics: [string, URL][],
  syllabus: { topic: string | null },
): void {
  const base = s.site.base;
  const sorted = [...modules].sort((a, b) => sortOrder(a) - sortOrder(b));
  for (const m of sorted.filter((m) => m.IsHidden !== true)) {
    const trail = [...parents, clean(str(m, "Title"))];
    const folder = trail.join("/");
    const items: string[] = [];
    const topics = (asArray(m.Topics) ?? []).map((t) => asObject(t) ?? {}).sort((a, b) => sortOrder(a) - sortOrder(b));
    for (const t of topics.filter((t) => t.IsHidden !== true && t.IsBroken !== true)) {
      const kind = topicKind(t);
      const title = str(t, "Title");
      const raw = asString(t.Url);
      let at: URL | null = null;
      if (raw !== undefined) {
        try {
          at = new URL(raw, base);
        } catch {
          at = null;
        }
      }
      if (kind === "file" && at && s.site.owns(at)) {
        if (isHtml(at)) {
          htmlTopics.push([title, at]);
          items.push(title);
          continue;
        }
        const topicId = asNumber(t.TopicId) ?? 0;
        const url = new URL(lePath(api, ou, `/content/topics/${topicId}/file`), base);
        const name = fileName(title, at);
        const aliases = [at, new URL(`/d2l/le/content/${ou}/viewContent/${topicId}/View`, base)];
        if (syllabus.topic === null && isSyllabus(title)) {
          syllabus.topic = `<p>The syllabus is the file <a href="${escape(url.href)}">${escape(name)}</a>.</p>`;
        }
        items.push(name);
        pushFile(c, fileUrls, remoteFile(name, url, { folder, aliases }));
      } else if (kind === "link" && at && !s.site.owns(at) && (at.protocol === "https:" || at.protocol === "http:")) {
        if (syllabus.topic === null && isSyllabus(title)) {
          syllabus.topic = `<p>The syllabus is at <a href="${escape(at.href)}">${escape(title)}</a>.</p>`;
        }
        items.push(title);
        c.links.push({ title, url: at });
      } else {
        // Assignments, quizzes, discussions, tools and links within the site: listed in order only.
        items.push(title);
      }
    }
    const subs = (asArray(m.Modules) ?? []).map((x) => asObject(x) ?? {});
    if (items.length > 0 || subs.length === 0) c.modules.push({ name: trail.join(" / "), items });
    walk(s, api, ou, subs, trail, c, fileUrls, htmlTopics, syllabus);
  }
}

function topicKind(t: Json): "file" | "link" | "other" {
  const activity = int(t, "ActivityType");
  const type = str(t, "TypeIdentifier").toLowerCase();
  if (activity === 1 || (activity === null && type === "file")) return "file";
  if (activity === 2 || (activity === null && type === "link")) return "link";
  return "other";
}

function pushFile(c: CourseContent, seen: Set<string>, f: RemoteFile): void {
  if (seen.has(f.url.href)) return;
  seen.add(f.url.href);
  c.files.push(f);
}

/** SignedOut, network failures and incomplete lists stop the whole read; anything else only skips a part. */
function fatal(e: unknown): void {
  if (!(e instanceof LmsError) || e.kind === "signedOut" || e.kind === "network" || e.kind === "incomplete") throw e;
}

async function fetchHtml(s: Session, url: URL): Promise<string> {
  const res = await s.get(url);
  if (res.url.pathname.toLowerCase().startsWith("/d2l/login")) {
    res.discard();
    throw LmsError.signedOut();
  }
  const len = res.contentLength();
  if (len !== null && len > MAX_HTML) {
    res.discard();
    throw LmsError.other("Too large.");
  }
  let body: Buffer;
  try {
    body = await res.bytes(MAX_HTML);
  } catch (e) {
    if (e instanceof LmsError) throw e;
    if (e instanceof Error && e.name === "Cancelled") throw e;
    throw LmsError.network((e as Error).message);
  }
  if (body.length > MAX_HTML) throw LmsError.other("Too large.");
  const text = body.toString("utf8");
  if (Buffer.byteLength(text) < 4096 && text.includes("/d2l/login?sessionExpired=1")) throw LmsError.signedOut();
  return text;
}

/** The name a download from the site carries (`Content-Disposition`), read from its headers only. */
async function attachmentName(s: Session, url: URL): Promise<string | null> {
  try {
    const res = await s.get(url);
    const v = res.header("content-disposition");
    res.discard();
    const name = v !== undefined ? dispositionName(v) : null;
    return name !== null ? clean(name) : null;
  } catch (e) {
    fatal(e);
    return null;
  }
}

export function dispositionName(v: string): string | null {
  let plain: string | null = null;
  for (const part of v.split(";").map((p) => rustTrim(p))) {
    if (part.startsWith("filename*=")) {
      const enc = part.slice("filename*=".length);
      const pieces = enc.split("''");
      const raw = pieces.length > 1 ? pieces[1] : enc;
      const d = percentDecodeStrict(raw);
      if (d !== null) return d;
    } else if (part.startsWith("filename=")) {
      plain = part.slice("filename=".length).replace(/^"+|"+$/g, "");
    }
  }
  return plain !== null && plain !== "" ? plain : null;
}

/** A file topic's name: its title, with the file's extension when the title lacks it. */
export function fileName(title: string, at: URL): string {
  const segs = at.pathname.split("/");
  const lastRaw = segs[segs.length - 1] ?? "";
  const last = percentDecodeStrict(lastRaw) ?? lastRaw;
  const dot = last.lastIndexOf(".");
  const ext = dot >= 0 ? last.slice(dot + 1) : "";
  const hasExt = dot >= 0 && ext !== "" && Buffer.byteLength(ext) <= 5;
  let t = clean(title);
  if (!t) t = clean(last);
  if (hasExt && !t.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return `${t}.${ext}`;
  return t;
}

function isHtml(u: URL): boolean {
  const p = u.pathname.toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm");
}

function isSyllabus(title: string): boolean {
  return title.toLowerCase().includes("syllab");
}

/** No path separators or control characters in a name used as a file or folder. */
function clean(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    out += ch === "/" || ch === "\\" || c <= 0x1f || (c >= 0x7f && c <= 0x9f) ? "-" : ch;
  }
  return rustTrim(out);
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `a` is later than `b`; both ISO 8601 in UTC as D2L gives them ("2026-12-20T04:59:00.000Z"). */
export function after(a: string, b: string): boolean {
  const cut = (s: string) => (s.length >= 19 ? s.slice(0, 19) : s);
  return cut(a) > cut(b);
}

/** Current time as "2026-10-10T14:03:00Z". */
function nowIso(): string {
  return new Date().toISOString().slice(0, 19) + "Z";
}

// ---- Grades ----------------------------------------------------------------
//
// Valence grade routes, the ones brightspace-mcp-server's grade tool reads: the
// person's own released grade values, the final grade value, and the grade
// objects and categories for names, maximum points and weights. Grades not
// released to the person aren't in `myGradeValues` at all.

/** GradeObjectType: 7 final calculated, 8 final adjusted, 9 category (a subtotal, not an item). */
const NOT_ITEMS = [7, 8, 9];

/** "87 %", "8.5 / 10": a number as Brightspace shows it, not a letter or scheme symbol. */
function looksNumeric(d: string): boolean {
  return /^[0-9.,%/ -]*$/.test(d);
}

async function soft<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    fatal(e);
    return null;
  }
}

function idOf(v: unknown): number | null {
  const n = asNumber(v);
  return n === undefined ? null : n;
}

async function grades(s: Session, courseId: string): Promise<CourseGrades> {
  if (!digitsOnly(courseId)) throw LmsError.notFound("Your course site couldn’t find this course.");
  const ou = courseId;
  const api = await discover(s);
  await whoami(s, api);
  let values: Json[];
  try {
    values = (asArray(await s.getJson(lePath(api, ou, "/grades/values/myGradeValues/"))) ?? []).map((x) => asObject(x) ?? {});
  } catch (e) {
    return gradesRefused(e);
  }
  // The rest only adds names, maximums and weights: a refusal there isn't a failure.
  const fin = asObject(await soft(s.getJson(lePath(api, ou, "/grades/final/values/myGradeValue")))) ?? null;
  const objectsList = (asArray(await soft(s.getJson(lePath(api, ou, "/grades/")))) ?? []).map((x) => asObject(x) ?? {});
  const cats = (asArray(await soft(s.getJson(lePath(api, ou, "/grades/categories/")))) ?? []).map((x) => asObject(x) ?? {});
  const setup = asObject(await soft(s.getJson(lePath(api, ou, "/grades/setup/"))));
  const system = setup ? asString(setup.GradingSystem) : undefined;
  const weighted = system !== undefined ? system.toLowerCase() === "weighted" : cats.some((c) => (asNumber(c.Weight) ?? 0) > 0);

  const out: CourseGrades = { current: {}, groups: [], items: [] };
  const catOf = new Map<number, string>();
  for (const c of cats.filter((c) => rustTrim(str(c, "Name")))) {
    const name = rustTrim(str(c, "Name"));
    const g: { name: string; weight?: number } = { name };
    const w = asNumber(c.Weight);
    if (weighted && w !== undefined) g.weight = w;
    out.groups.push(g);
    const id = idOf(c.Id);
    if (id !== null && !catOf.has(id)) catOf.set(id, name);
  }
  const catGrades = (c: Json) => (asArray(c.Grades) ?? []).map((x) => asObject(x) ?? {});
  const all: Json[] = [...objectsList];
  for (const c of cats) for (const g of catGrades(c)) if (!all.some((o) => idOf(o.Id) === idOf(g.Id))) all.push(g);
  const groupOf = (o: Json): string | undefined => {
    const cid = idOf(o.CategoryId);
    if (cid !== null && catOf.has(cid)) return catOf.get(cid);
    const c = cats.find((c) => catGrades(c).some((g) => idOf(g.Id) === idOf(o.Id)));
    return c ? rustTrim(str(c, "Name")) : undefined;
  };

  const placed = new Set<number>();
  for (const v of values) {
    const type = int(v, "GradeObjectType");
    const title = rustTrim(str(v, "GradeObjectName"));
    if ((type !== null && NOT_ITEMS.includes(type)) || !title) continue;
    const ident = asString(v.GradeObjectIdentifier);
    const oid = ident !== undefined && /^\+?[0-9]+$/.test(ident) ? Number(ident) : null;
    const obj = oid !== null ? all.find((o) => idOf(o.Id) === oid) : undefined;
    if (obj) placed.add(idOf(obj.Id)!);
    const score = asNumber(v.PointsNumerator);
    const possible = asNumber(v.PointsDenominator) ?? (obj ? asNumber(obj.MaxPoints) : undefined);
    const displayed = asString(v.DisplayedGrade);
    const comment = richPlain(v.Comments);
    const item = gradeItem(title, {
      graded: score !== undefined || (displayed !== undefined && rustTrim(displayed) !== ""),
      comments: comment !== null ? [comment] : [],
    });
    const group = obj ? groupOf(obj) : undefined;
    if (group !== undefined) item.group = group;
    if (score !== undefined) item.score = score;
    if (possible !== undefined) item.possible = possible;
    const pc = percentOf(score, possible);
    if (pc !== undefined) item.percent = pc;
    const shown = displayed !== undefined ? rustTrim(displayed) : "";
    if (shown && !looksNumeric(shown)) item.grade = shown;
    out.items.push(item);
  }
  // Grade items with nothing released yet: listed, ungraded.
  for (const o of all) {
    const kind = (asString(o.GradeType) ?? "").toLowerCase();
    const id = idOf(o.Id);
    const name = rustTrim(str(o, "Name"));
    if ((id !== null && placed.has(id)) || o.IsHidden === true || !name || kind === "category" || kind === "formula" || kind === "calculated") continue;
    const item = gradeItem(name);
    const group = groupOf(o);
    if (group !== undefined) item.group = group;
    const max = asNumber(o.MaxPoints);
    if (max !== undefined) item.possible = max;
    out.items.push(item);
  }

  // The final grade value is the course's final grade (D2L's final calculated
  // or adjusted grade), not a running current grade.
  if (fin) {
    const num = asNumber(fin.PointsNumerator);
    const den = asNumber(fin.PointsDenominator);
    const displayed = asString(fin.DisplayedGrade);
    const shown = displayed !== undefined ? rustTrim(displayed) : "";
    let percent = percentOf(num, den);
    if (percent === undefined && shown) {
      const n = Number(rustTrim(shown.replace(/%+$/, "")));
      if (rustTrim(shown.replace(/%+$/, "")) !== "" && Number.isFinite(n)) percent = n;
    }
    const f: GradeSummary = {};
    if (percent !== undefined) f.percent = percent;
    if (shown && !looksNumeric(shown)) f.letter = shown;
    if (num !== undefined) f.points = num;
    if (den !== undefined) f.possible = den;
    if (f.percent !== undefined || f.letter !== undefined || f.points !== undefined) out.final = f;
  }
  return out;
}

export const brightspace: Adapter = { loginUrl, loginResult, courses, content, grades, account };
