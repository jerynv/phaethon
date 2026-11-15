import fs from "node:fs";
import { keychainDelete, keychainGet, keychainSet, lmsVaultAccount } from "../core/secrets.ts";
import { spaceDir, vaultRoot } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import type { Channel } from "../rpc/channel.ts";
import { allowAll, can, courseKey, visible, type Visible } from "./access.ts";
import { account, accountFingerprint, content as readContent, courses as readCourses, grades as readGrades } from "./adapters/index.ts";
import { sha256Hex } from "./hash.ts";
import { request } from "./http.ts";
import { defaultOptions, importCourse, writeGrades, type Step } from "./import.ts";
import { summarise, type Summary } from "./material.ts";
import { dirIn } from "./names.ts";
import { Session } from "./session.ts";
import {
  COURSES_DIR,
  courseDir,
  getConn,
  load,
  loadAccounts,
  loadGrades,
  nowMs,
  putGrades,
  save,
  saveAccounts,
  update,
  type Accounts,
  type Conn,
  type GradeRec,
  type Store,
} from "./store.ts";
import { CANCELLED, isCancelled, isLmsError, kindName, oneLine, Site, type CourseGrades, type Credential, type Kind } from "./types.ts";

/**
 * The course-site operations behind the `lms_*` commands: connections, sign-in
 * bookkeeping, imports with cancel and resume, grades from disk and refreshed.
 * Sessions are read from the keychain only here and never leave the core.
 */

export const SIGNED_OUT = "signedOut";

export type ConnectionView = { id: string; kind: Kind; address: string; schoolName?: string; signedIn: boolean; lastSync?: number; courses: string[] };
export type CourseView = { id: string; name: string; code?: string; term?: string; current: boolean; imported: boolean; partial?: true };
export type School = { name: string; address: string };

export type ImportEvent =
  | { type: "progress"; course: string; step: "reading" | Step; done: number; total: number }
  | { type: "course"; course: string; folder: string; files: number; readings: number; links: number; skipped: string[]; material?: Summary }
  | { type: "cancelled" }
  | { type: "done" }
  | { type: "error"; message: string };

export type GradesEvent =
  | { type: "progress"; course: string; step: "grades"; done: number; total: number }
  | { type: "course"; course: string; grades: GradeRec }
  | { type: "done" }
  | { type: "error"; message: string };

const ID_MAX = 100;

function msg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** A connection's id: the kind and the site's host (and port), only letters, digits and `-`, at most 100 characters. */
export function connectionId(site: Site): string {
  const host = site.base.hostname || "site";
  const port = site.base.port ? `-${site.base.port}` : "";
  const raw = `${kindName(site.kind).toLowerCase()}-${host}${port}`;
  const id = [...raw].map((c) => (/^[A-Za-z0-9]$/.test(c) ? c.toLowerCase() : "-")).join("");
  return [...id].slice(0, ID_MAX).join("");
}

/** The id with `suffix`, the id cut short first so the whole stays within the keychain's 100 characters. */
function withSuffix(base: string, suffix: string): string {
  return base.slice(0, ID_MAX - suffix.length) + suffix;
}

function view(c: Conn): ConnectionView {
  const v: ConnectionView = { id: c.id, kind: c.kind, address: c.address } as ConnectionView;
  if (c.schoolName !== undefined) v.schoolName = c.schoolName;
  v.signedIn = c.signedIn;
  if (c.lastSync !== undefined) v.lastSync = c.lastSync;
  v.courses = Object.keys(c.courses).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return v;
}

/** The vault's connections. Reads only lms.json, never the keychain. */
export function connections(): ConnectionView[] {
  return load(vaultRoot()).connections.map(view);
}

function siteAddress(site: Site): string {
  return site.address();
}

/**
 * Which connection a sign-in to `site` as `account` (a fingerprint) belongs to.
 * Only a connection on this same site is ever reused; another site's id is
 * never taken over. A new connection gets the site's id when it's free, else
 * the id plus 8 hex digits of a hash of the site and account, numbered on.
 */
export function chooseConnection(st: Store, accounts: Accounts, site: Site, acct: string | null): string {
  const base = connectionId(site);
  const addr = siteAddress(site);
  const onSite = st.connections.filter((c) => c.kind === site.kind && c.address.replace(/\/+$/, "") === addr).sort((a, b) => Number(a.id !== base) - Number(b.id !== base));
  if (acct !== null) {
    const mine = onSite.find((c) => accounts.connections[c.id] === acct);
    if (mine) return mine.id;
  }
  const unclaimed = onSite.find((c) => !(c.id in accounts.connections));
  if (unclaimed) return unclaimed.id;
  const taken = (id: string) => getConn(st, id) !== undefined || id in accounts.connections;
  if (!taken(base)) return base;
  const tag = sha256Hex(`${kindName(site.kind)}\n${addr}\n${acct ?? ""}`).slice(0, 8);
  const first = withSuffix(base, `-${tag}`);
  if (!taken(first)) return first;
  for (let n = 2; ; n++) {
    const id = withSuffix(base, `-${tag}-${n}`);
    if (!taken(id)) return id;
  }
}

function recordSignIn(st: Store, accounts: Accounts, site: Site, id: string, acct: string | null): void {
  if (acct !== null) accounts.connections[id] = acct;
  const c = getConn(st, id);
  if (c) c.signedIn = true;
  else st.connections.push({ id, kind: site.kind, address: siteAddress(site), signedIn: true, courses: {} });
}

/** Keeps the session under the connection it belongs to; lms.json first, so a failed save leaves no orphan keychain entry. */
function saveSignInAs(site: Site, credential: Credential, acct: string | null): ConnectionView {
  const root = vaultRoot();
  const st = load(root);
  const accounts = loadAccounts(root);
  const id = chooseConnection(st, accounts, site, acct);
  const account = lmsVaultAccount(id);
  recordSignIn(st, accounts, site, id, acct);
  keychainSet(account, JSON.stringify({ cookies: credential.cookies.map((c) => ({ name: c.name, value: c.value })), csrf: credential.csrf ?? null }));
  save(root, st);
  if (acct !== null) saveAccounts(root, accounts);
  return view(getConn(st, id)!);
}

/** Remember a school's name for a connection (from the school search). */
export function setSchoolName(id: string, name: string): void {
  const root = vaultRoot();
  const st = load(root);
  const c = getConn(st, id);
  if (!c) return;
  const n = [...name.trim()].slice(0, 120).join("");
  if (n && c.schoolName !== n) {
    c.schoolName = n;
    save(root, st);
  }
}

function identityFailed(e: unknown): string {
  return `Signed in, but your course site didn’t say which account it is, so nothing was saved. Try signing in again. (${msg(e)})`;
}

/**
 * After signing in: ask the site who is signed in, then keep the session under
 * that account's connection. On a site with an account call a failed call
 * fails the sign-in and nothing is saved.
 */
export async function finishSignIn(site: Site, credential: Credential, schoolName: string | null): Promise<ConnectionView> {
  const session = new Session(site, credential);
  let acct: string | null;
  try {
    const id = await account(session);
    acct = id === null ? null : accountFingerprint(site, id);
  } catch (e) {
    throw new Refusal(identityFailed(e));
  }
  const v = saveSignInAs(site, credential, acct);
  if (schoolName === null) return v;
  setSchoolName(v.id, schoolName);
  const found = connections().find((c) => c.id === v.id);
  if (!found) throw new Refusal("The connection wasn’t saved.");
  return found;
}

function siteOf(c: Conn): Site {
  return Site.create(c.kind, c.address);
}

/** Tests: lets a connection on a local http test server stand for a site. */
let siteFor: (c: Conn) => Site = siteOf;
export function setSiteResolverForTests(f: ((c: Conn) => Site) | null): void {
  siteFor = f ?? siteOf;
}

function parseCredential(s: string | null): Credential | null {
  if (s === null) return null;
  try {
    const v = JSON.parse(s) as { cookies?: unknown; csrf?: unknown };
    if (!Array.isArray(v.cookies)) return null;
    const cookies = v.cookies.map((c) => {
      const o = c as { name?: unknown; value?: unknown };
      if (typeof o.name !== "string" || typeof o.value !== "string") throw new Error("bad cookie");
      return { name: o.name, value: o.value };
    });
    if (v.csrf !== undefined && v.csrf !== null && typeof v.csrf !== "string") return null;
    if (v.csrf === undefined) return null;
    return { cookies, csrf: (v.csrf as string | null) ?? null };
  } catch {
    return null;
  }
}

/** The connection's session from the keychain; `signedOut` when there is none. */
export function session(id: string): Session {
  const root = vaultRoot();
  const c = getConn(load(root), id);
  if (!c) throw new Refusal("That course site isn’t connected.");
  let site: Site;
  try {
    site = siteFor(c);
  } catch (e) {
    throw new Refusal(msg(e));
  }
  const credential = parseCredential(keychainGet(lmsVaultAccount(id)));
  if (!credential) {
    markSignedIn(id, false);
    throw new Refusal(SIGNED_OUT);
  }
  return new Session(site, credential);
}

/** Keep the signed-in hint in lms.json in step with what was found. */
export function markSignedIn(id: string, signedIn: boolean): void {
  const root = vaultRoot();
  try {
    const st = load(root);
    const c = getConn(st, id);
    if (c && c.signedIn !== signedIn) {
      c.signedIn = signedIn;
      save(root, st);
    }
  } catch {
    // A hint only.
  }
}

function lmsError(e: unknown): string {
  if (isLmsError(e, "signedOut")) return SIGNED_OUT;
  return msg(e);
}

function ended(id: string, e: string): string {
  if (e === SIGNED_OUT) markSignedIn(id, false);
  return e;
}

export async function courses(id: string): Promise<CourseView[]> {
  const s = session(id);
  let list;
  try {
    list = await readCourses(s);
  } catch (e) {
    throw new Refusal(ended(id, lmsError(e)));
  }
  const conn = getConn(load(vaultRoot()), id);
  return list.map((c) => {
    const known = conn?.courses[c.id];
    const v: CourseView = { id: c.id, name: c.name, current: c.current, imported: known !== undefined && !known.partial };
    if (c.code !== null && c.code !== undefined) v.code = c.code;
    if (c.term !== null && c.term !== undefined) v.term = c.term;
    if (known?.partial) v.partial = true;
    return { id: v.id, name: v.name, ...(v.code !== undefined ? { code: v.code } : {}), ...(v.term !== undefined ? { term: v.term } : {}), current: v.current, imported: v.imported, ...(v.partial ? { partial: true as const } : {}) };
  });
}

// ---- Imports -------------------------------------------------------------------

const importing = new Set<string>();
const running = new Map<string, AbortController>();

/** Signals a running import for that connection; false when none runs. */
export function cancelImport(connection: string): boolean {
  const c = running.get(connection);
  if (!c) return false;
  c.abort();
  return true;
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(CANCELLED));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(CANCELLED));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Import the chosen courses. Results come as events; always ends with exactly one `done`. */
export async function importCourses(id: string, courseIds: string[], spaces: string[], emit: (e: ImportEvent) => void): Promise<void> {
  try {
    for (const s of spaces) {
      try {
        spaceDir(s);
      } catch {
        throw new Refusal(`There’s no space called “${s}”.`);
      }
    }
    const root = vaultRoot();
    if (importing.has(root)) throw new Refusal("Courses are already being imported. Wait for that to finish.");
    importing.add(root);
    const abort = new AbortController();
    running.set(id, abort);
    try {
      const s = session(id).withSignal(abort.signal);
      await importWith(id, s, courseIds, spaces, abort.signal, emit);
    } finally {
      importing.delete(root);
      if (running.get(id) === abort) running.delete(id);
    }
  } catch (e) {
    const m = isCancelled(e) ? CANCELLED : msg(e);
    if (m === CANCELLED) emit({ type: "cancelled" });
    else emit({ type: "error", message: m });
  }
  emit({ type: "done" });
}

function gradesSkipped(e: unknown): string {
  if (isLmsError(e, "signedOut")) return "Grades: couldn’t be read (sign in again if this keeps happening)";
  return `Grades: couldn’t be read (${msg(e)})`;
}

function gradeRec(connection: string, courseId: string, course: string, folder: string, grades: CourseGrades): GradeRec {
  return { connection, courseId, course, folder: `${COURSES_DIR}/${folder}`, updated: nowMs(), ...grades };
}

async function importWith(id: string, s: Session, courseIds: string[], spaces: string[], signal: AbortSignal, emit: (e: ImportEvent) => void): Promise<void> {
  const root = vaultRoot();
  const wanted = new Set(courseIds);
  let list;
  try {
    list = await raceAbort(readCourses(s), signal);
  } catch (e) {
    if (isCancelled(e) || signal.aborted) throw new Error(CANCELLED);
    throw new Error(ended(id, lmsError(e)));
  }
  const chosen = list.filter((c) => wanted.has(c.id));
  if (chosen.length < wanted.size) emit({ type: "error", message: "Some of the chosen courses aren’t on the course site any more." });
  let coursesRoot: string;
  try {
    coursesRoot = dirIn(realRoot(root), COURSES_DIR);
  } catch (e) {
    throw new Error(`The courses folder couldn’t be made: ${msg(e)}`);
  }
  for (const course of chosen) {
    if (signal.aborted) throw new Error(CANCELLED);
    emit({ type: "progress", course: course.id, step: "reading", done: 0, total: 1 });
    let content;
    try {
      content = await raceAbort(readContent(s, course.id), signal);
    } catch (e) {
      if (isCancelled(e) || signal.aborted) throw new Error(CANCELLED);
      if (isLmsError(e, "signedOut")) throw new Error(ended(id, SIGNED_OUT));
      emit({ type: "error", message: `${course.name}: ${msg(e)}` });
      continue;
    }
    let grades: CourseGrades | null = null;
    try {
      grades = await raceAbort(readGrades(s, course.id), signal);
    } catch (e) {
      if (isCancelled(e) || signal.aborted) throw new Error(CANCELLED);
      content.skipped.push(gradesSkipped(e));
    }
    emit({ type: "progress", course: course.id, step: "reading", done: 1, total: 1 });
    const st = load(root);
    const prev = getConn(st, id)?.courses[course.id];
    const others = st.connections.flatMap((c) => Object.entries(c.courses).flatMap(([cid, cs]) => (c.id === id && cid === course.id ? [] : [cs.folder])));
    const opts = { ...defaultOptions(signal), grades };
    let out;
    try {
      out = await importCourse(s, coursesRoot, course, content, prev ? structuredClone(prev) : undefined, others, opts, (step, done, total) =>
        emit({ type: "progress", course: course.id, step, done, total }),
      );
    } catch (e) {
      emit({ type: "error", message: `${course.name}: ${msg(e)}` });
      continue;
    }
    const folder = out.state.folder;
    const material = out.state.material ? summarise(out.state.material, () => true) : undefined;
    const firstComplete = !out.state.partial && (!prev || prev.partial === true);
    // Load, change and save with nothing in between, so a refresh or sign-in running alongside isn't lost.
    update(root, (store) => {
      const conn = getConn(store, id);
      if (!conn) throw new Refusal("This course site was disconnected while importing.");
      conn.courses[course.id] = out.state;
      if (out.written) conn.lastSync = nowMs();
    });
    if (!out.written) throw new Error(CANCELLED);
    const skipped = [...out.skipped];
    if (firstComplete) {
      try {
        allowAll(spaces, [courseKey(id, course.id)]);
      } catch (e) {
        skipped.push(`Who can see it: ${msg(e)}`);
      }
    }
    if (grades) {
      try {
        putGrades(root, gradeRec(id, course.id, course.name, folder, grades));
      } catch (e) {
        skipped.push(`Grades: ${msg(e)}`);
      }
    }
    const ev: ImportEvent = { type: "course", course: course.id, folder: `${COURSES_DIR}/${folder}`, files: out.files, readings: out.readings, links: out.links, skipped };
    if (material) ev.material = material;
    emit(ev);
    if (out.cancelled) throw new Error(CANCELLED);
  }
}

function realRoot(root: string): string {
  try {
    return fs.realpathSync.native(root);
  } catch {
    return root;
  }
}

// ---- Grades ----------------------------------------------------------------------

/** The grades the space may see, from disk only. */
export function grades(vis: Visible): GradeRec[] {
  const allowed = (key: string) => vis.courses.some((c) => c.key === key && can(c, "grades"));
  const list = Object.entries(loadGrades(vaultRoot()).courses)
    .filter(([k]) => allowed(k))
    .map(([, v]) => v);
  list.sort((a, b) => {
    const x = a.course.toLowerCase();
    const y = b.course.toLowerCase();
    return x < y ? -1 : x > y ? 1 : Buffer.compare(Buffer.from(a.connection), Buffer.from(b.connection));
  });
  return list;
}

/** Read the grades of the courses the space may see on one connection. Always ends with `done`. */
export async function gradesRefresh(vis: Visible, id: string, emit: (e: GradesEvent) => void): Promise<void> {
  try {
    await gradesRefreshInner(vis, id, emit);
  } catch (e) {
    emit({ type: "error", message: msg(e) });
  }
  emit({ type: "done" });
}

async function gradesRefreshInner(vis: Visible, id: string, emit: (e: GradesEvent) => void): Promise<void> {
  if (!vis.courses.some((c) => c.connection === id && can(c, "grades"))) return;
  const allowed = (cid: string) => vis.courses.some((c) => c.connection === id && c.courseId === cid && can(c, "grades"));
  const s = session(id);
  await refreshGradesWith(s, id, allowed, emit);
}

export async function refreshGradesWith(s: Session, id: string, allowed: (cid: string) => boolean, emit: (e: GradesEvent) => void): Promise<void> {
  const root = vaultRoot();
  const conn = getConn(load(root), id);
  const list = conn
    ? Object.entries(conn.courses)
        .filter(([k]) => allowed(k))
        .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    : [];
  const total = list.length;
  for (let n = 0; n < list.length; n++) {
    const [cid, cs] = list[n];
    emit({ type: "progress", course: cid, step: "grades", done: n, total });
    let g: CourseGrades;
    try {
      g = await readGrades(s, cid);
    } catch (e) {
      if (isLmsError(e, "signedOut")) throw new Refusal(ended(id, SIGNED_OUT));
      emit({ type: "error", message: `${cs.name}: ${msg(e)}` });
      continue;
    }
    const dir = courseDir(root, cs.folder);
    if (dir) {
      try {
        writeGrades(dir, cs.name, g);
      } catch (e) {
        emit({ type: "error", message: `${cs.name}: ${msg(e)}` });
      }
    }
    const rec = gradeRec(id, cid, cs.name, cs.folder, g);
    putGrades(root, rec);
    emit({ type: "course", course: cid, grades: rec });
  }
}

export function disconnect(id: string): void {
  if (!getConn(load(vaultRoot()), id)) throw new Refusal("That course site isn’t connected.");
  keychainDelete(lmsVaultAccount(id), "could not remove the sign-in from the keychain");
  cancelImport(id);
  markSignedIn(id, false);
}

// ---- School search ------------------------------------------------------------------

export const CANVAS_SEARCH = "https://canvas.instructure.com/api/v1/accounts/search";

export async function schools(kind: Kind, query: string): Promise<School[]> {
  if (kind !== "canvas") return [];
  return canvasSchools(new URL(CANVAS_SEARCH), query);
}

export async function canvasSchools(endpoint: URL, query: string): Promise<School[]> {
  const q0 = query.trim();
  if ([...q0].length < 2) return [];
  const q = [...q0].slice(0, 100).join("");
  const url = new URL(endpoint.href);
  url.searchParams.append("search_term", q);
  url.searchParams.append("per_page", "50");
  let res;
  let at = url;
  try {
    // Default redirect following (up to 10 hops), no credential.
    for (let hop = 0; ; hop++) {
      res = await request(at, { totalTimeoutMs: 20_000, connectTimeoutMs: 20_000 });
      const loc = res.header("location");
      if (res.status >= 300 && res.status <= 399 && loc !== undefined && hop < 10) {
        res.discard();
        at = new URL(loc, at);
        continue;
      }
      break;
    }
  } catch (e) {
    throw new Refusal(`Couldn’t search for schools: ${msg(e)}`);
  }
  if (!res.ok) {
    res.discard();
    throw new Refusal(`Couldn’t search for schools (the search answered ${res.status}).`);
  }
  let accounts: unknown;
  try {
    accounts = JSON.parse(await res.text());
  } catch (e) {
    throw new Refusal(`Couldn’t search for schools: ${msg(e)}`);
  }
  if (!Array.isArray(accounts)) throw new Refusal("Couldn’t search for schools: invalid type: expected a sequence");
  const seen = new Set<string>();
  const found: School[] = [];
  for (const a of accounts as { name?: unknown; domain?: unknown }[]) {
    if (typeof a?.name !== "string" || typeof a?.domain !== "string") continue;
    const name = oneLine(a.name);
    let site: Site;
    try {
      site = Site.create("canvas", a.domain.trim());
    } catch {
      continue;
    }
    const address = site.address();
    const key = `${name}\0${address}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    found.push({ name, address });
  }
  return rankSchools(found, q);
}

export function rankSchools(found: School[], query: string): School[] {
  const q = oneLine(query).toLowerCase();
  const first = q.split(" ")[0] ?? "";
  const score = (s: School) => {
    const n = s.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.split(/[^\p{Alphabetic}\p{N}]/u).some((w) => w !== "" && w.startsWith(first))) return 2;
    return 3;
  };
  return [...found].sort((a, b) => score(a) - score(b) || Buffer.byteLength(a.name) - Buffer.byteLength(b.name) || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
}

// ---- Commands' helpers -------------------------------------------------------------------

export function visibleFor(space: string): Visible {
  spaceDir(space);
  return visible(space);
}

export function eventSender<T>(ch: Channel<T> | undefined): (e: T) => void {
  return (e) => ch?.send(e);
}

