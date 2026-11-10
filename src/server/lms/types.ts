/**
 * Course sites (Canvas, Brightspace, Moodle, Blackboard): the shapes every site
 * adapter fills in and the rest of the LMS core relies on.
 *
 * Signing in is the person's own, in the school's own page; Phaethon keeps the
 * session it leaves (cookies, plus the CSRF token), never an API token.
 * Credentials stay in the core and the keychain: never in the vault (it syncs),
 * never sent to the renderer, and only ever sent to the site's own origin.
 */

export type Kind = "canvas" | "brightspace" | "moodle" | "blackboard";

export const KINDS: readonly Kind[] = ["canvas", "brightspace", "moodle", "blackboard"];

export function isKind(k: unknown): k is Kind {
  return typeof k === "string" && (KINDS as readonly string[]).includes(k);
}

/** "Canvas" | "Brightspace" | "Moodle" | "Blackboard": used in fingerprints, hashes and messages. */
export function kindName(kind: Kind): string {
  switch (kind) {
    case "canvas":
      return "Canvas";
    case "brightspace":
      return "Brightspace";
    case "moodle":
      return "Moodle";
    case "blackboard":
      return "Blackboard";
  }
}

export type LmsErrorKind = "signedOut" | "forbidden" | "notFound" | "network" | "unsupported" | "other" | "incomplete";

export const SIGNED_OUT_TEXT = "You’ve been signed out of your course site. Sign in again.";

/**
 * What can go wrong talking to a course site. `message` is what the person
 * reads (Rust's `Display`); `kind` is what code matches on.
 */
export class LmsError extends Error {
  /** For a 403: whether the site said it was throttling (Canvas's "Rate Limit Exceeded"); undefined when unknown. */
  rateLimited?: boolean;
  constructor(
    readonly kind: LmsErrorKind,
    /** The detail without any prefix (`Network` displays as "Couldn’t reach your course site: {detail}"). */
    readonly detail = "",
  ) {
    super(kind === "signedOut" ? SIGNED_OUT_TEXT : kind === "network" ? `Couldn’t reach your course site: ${detail}` : detail);
    this.name = "LmsError";
  }
  static signedOut(): LmsError {
    return new LmsError("signedOut");
  }
  static forbidden(s = "Your course site didn’t allow this."): LmsError {
    return new LmsError("forbidden", s);
  }
  static notFound(s = "Your course site couldn’t find this."): LmsError {
    return new LmsError("notFound", s);
  }
  static network(s: string): LmsError {
    return new LmsError("network", s);
  }
  static unsupported(s: string): LmsError {
    return new LmsError("unsupported", s);
  }
  static other(s: string): LmsError {
    return new LmsError("other", s);
  }
  static incomplete(s: string): LmsError {
    return new LmsError("incomplete", s);
  }
}

export function isLmsError(e: unknown, kind?: LmsErrorKind): e is LmsError {
  return e instanceof LmsError && (kind === undefined || e.kind === kind);
}

/** An import or request that was cancelled. Its message is the "cancelled" the UI matches. */
export const CANCELLED = "cancelled";

export class Cancelled extends Error {
  constructor() {
    super(CANCELLED);
    this.name = "Cancelled";
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Cancelled || (e instanceof Error && e.message === CANCELLED);
}

/** The first part of a Moodle address that names one of its pages, not the folder it's in. */
const MOODLE_PAGES = ["my", "login", "course", "mod", "admin", "user", "auth", "lib", "pluginfile.php", "calendar", "grade", "message", "blocks", "theme", "local"];

/** A school's course site: `base` is its https origin (Moodle: plus its install folder). */
export class Site {
  private constructor(
    readonly kind: Kind,
    readonly base: URL,
  ) {}

  /** Only https origins: no path (except Moodle's folder), query, credentials or fragment survive. */
  static create(kind: Kind, address: string): Site {
    const trimmed = rustTrim(address);
    const raw = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw LmsError.other("That isn’t a web address.");
    }
    if (u.protocol !== "https:" || !u.hostname || u.username !== "" || u.password !== "") {
      throw LmsError.other("Use the https address you see when you open your course site.");
    }
    const base = new URL(u.origin + "/");
    if (kind === "moodle") {
      let dir = "/";
      for (const seg of u.pathname.split("/").filter((s) => s !== "")) {
        if (MOODLE_PAGES.includes(seg) || seg.endsWith(".php")) break;
        dir += `${seg}/`;
      }
      base.pathname = dir;
    }
    return new Site(kind, base);
  }

  /** A site on a local test server (plain http allowed). Tests only. */
  static forTest(kind: Kind, base: string): Site {
    return new Site(kind, new URL(base));
  }

  /** True when `u` is on this site's origin (scheme, host and port all match). */
  owns(u: URL): boolean {
    return u.origin === this.base.origin && u.origin !== "null";
  }

  /** The base without its trailing `/` (`https://x.edu/moodle`). */
  address(): string {
    return this.base.href.replace(/\/+$/, "");
  }

  join(path: string): URL {
    return new URL(path, this.base);
  }
}

/** One cookie the login window holds for the site. */
export type Cookie = { name: string; value: string };

/** What signing in produced. Serialized only into the keychain (`csrf: null` is written, never skipped). */
export type Credential = { cookies: Cookie[]; csrf: string | null };

/** Where the login window just went and the cookies it holds for the site. */
export type LoginNav = { url: URL; cookies: Cookie[] };

export type Course = { id: string; name: string; code?: string | null; term?: string | null; current: boolean };

export type Module = { name: string; items: string[] };
export type Page = { title: string; html: string; url: URL | null };
export type Assignment = { title: string; due: string | null; points: number | null; html: string; url: URL | null };
export type Announcement = { title: string; posted: string | null; html: string };
export type Link = { title: string; url: URL };

export type RemoteFile = {
  name: string;
  /** `A/B`, below the course's files. */
  folder: string | null;
  /** On the site's origin (or a redirect from it). */
  url: URL;
  size: number | null;
  mime: string | null;
  /** Other URLs that mean the same file (so links to them are rewritten too). */
  aliases: URL[];
  /** The site's listing stamp; the importer skips the request when it equals the last import's. */
  version: string | null;
};

export type CourseContent = {
  syllabus: string | null;
  modules: Module[];
  pages: Page[];
  assignments: Assignment[];
  announcements: Announcement[];
  files: RemoteFile[];
  links: Link[];
  /** Plain-language notes about what wasn't imported. */
  skipped: string[];
};

export function emptyContent(): CourseContent {
  return { syllabus: null, modules: [], pages: [], assignments: [], announcements: [], files: [], links: [], skipped: [] };
}

export function remoteFile(name: string, url: URL, extra: Partial<Omit<RemoteFile, "name" | "url">> = {}): RemoteFile {
  return { name, url, folder: null, size: null, mime: null, aliases: [], version: null, ...extra };
}

/** Each field optional and skipped when absent. */
export type GradeSummary = { percent?: number; letter?: string; points?: number; possible?: number };

export function summaryIsEmpty(s: GradeSummary | undefined): boolean {
  return !s || (s.percent === undefined && s.letter === undefined && s.points === undefined);
}

export type GradeGroup = { name: string; weight?: number };

export type GradeItem = {
  title: string;
  group?: string;
  score?: number;
  possible?: number;
  percent?: number;
  /** A display grade that isn't a number ("A-", "Satisfactory"). */
  grade?: string;
  due?: string;
  submitted: boolean;
  graded: boolean;
  late: boolean;
  missing: boolean;
  excused: boolean;
  comments: string[];
};

export function gradeItem(title: string, extra: Partial<GradeItem> = {}): GradeItem {
  return { title, submitted: false, graded: false, late: false, missing: false, excused: false, comments: [], ...extra };
}

export type CourseGrades = {
  current: GradeSummary;
  final?: GradeSummary;
  groups: GradeGroup[];
  items: GradeItem[];
  note?: string;
};

export function emptyGrades(note?: string): CourseGrades {
  const g: CourseGrades = { current: {}, groups: [], items: [] };
  if (note !== undefined) g.note = note;
  return g;
}

/** `round(score / possible * 10000) / 100`, only when `possible > 0`. */
export function percentOf(score: number | undefined | null, possible: number | undefined | null): number | undefined {
  if (score === undefined || score === null || possible === undefined || possible === null || !(possible > 0)) return undefined;
  return rustRound((score / possible) * 10000) / 100;
}

export const GRADES_HIDDEN = "Your course site doesn’t show you grades for this course.";

/** Forbidden, NotFound or Unsupported → an empty grade book with a note; anything else passes through. */
export function gradesRefused(e: unknown): CourseGrades {
  if (isLmsError(e, "forbidden") || isLmsError(e, "notFound") || isLmsError(e, "unsupported")) return emptyGrades(GRADES_HIDDEN);
  throw e;
}

/** Rust's `f64::round`: half away from zero. */
export function rustRound(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/** Rust `char::is_whitespace` (Unicode White_Space). */
export const RUST_WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const LEADING_WS = new RegExp(`^[${RUST_WS}]+`);
const TRAILING_WS = new RegExp(`[${RUST_WS}]+$`);
const WS_RUN = new RegExp(`[${RUST_WS}]+`);

export function isRustWhitespace(ch: string): boolean {
  return new RegExp(`^[${RUST_WS}]$`).test(ch);
}

/** Rust `str::trim`. */
export function rustTrim(s: string): string {
  return s.replace(LEADING_WS, "").replace(TRAILING_WS, "");
}

export function rustTrimEnd(s: string): string {
  return s.replace(TRAILING_WS, "");
}

export function rustTrimStart(s: string): string {
  return s.replace(LEADING_WS, "");
}

/** Rust `split_whitespace()` joined with single spaces. */
export function oneLine(s: string): string {
  return s
    .split(WS_RUN)
    .filter((w) => w !== "")
    .join(" ");
}

export function splitWhitespace(s: string): string[] {
  return s.split(WS_RUN).filter((w) => w !== "");
}

/** Percent-decodes `%XX` pairs; invalid escapes stay literal; lossy UTF-8; `+` stays `+`. */
export function percentDecode(s: string): string {
  const bytes: number[] = [];
  const src = Buffer.from(s, "utf8");
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 0x25 && isHex(src[i + 1]) && isHex(src[i + 2])) {
      bytes.push(parseInt(String.fromCharCode(src[i + 1], src[i + 2]), 16));
      i += 2;
    } else bytes.push(b);
  }
  return Buffer.from(bytes).toString("utf8");
}

function isHex(b: number | undefined): boolean {
  return b !== undefined && ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66));
}

/** Percent-decodes strictly: null when the result isn't valid UTF-8. */
export function percentDecodeStrict(s: string): string | null {
  const bytes: number[] = [];
  const src = Buffer.from(s, "utf8");
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 0x25 && isHex(src[i + 1]) && isHex(src[i + 2])) {
      bytes.push(parseInt(String.fromCharCode(src[i + 1], src[i + 2]), 16));
      i += 2;
    } else bytes.push(b);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** `application/x-www-form-urlencoded` encoding of one value (url crate's form serializer). */
export function formEncode(s: string): string {
  let out = "";
  for (const b of Buffer.from(s, "utf8")) {
    if ((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2a || b === 0x2d || b === 0x2e || b === 0x5f) out += String.fromCharCode(b);
    else if (b === 0x20) out += "+";
    else out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The JSON value as a number when it is one (serde `as_f64`). */
export function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asObject(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}
