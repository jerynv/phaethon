import { sha256Hex } from "../hash.ts";
import type { Session } from "../session.ts";
import { kindName, type Course, type CourseContent, type CourseGrades, type Credential, type Kind, type LoginNav, type Site } from "../types.ts";
import type { Adapter } from "./adapter.ts";
import { blackboard } from "./blackboard.ts";
import { brightspace } from "./brightspace.ts";
import { canvas } from "./canvas.ts";
import { moodle } from "./moodle.ts";

const ADAPTERS: Record<Kind, Adapter> = { canvas, brightspace, moodle, blackboard };

export function adapterFor(kind: Kind): Adapter {
  return ADAPTERS[kind];
}

export function loginUrl(site: Site): URL {
  return ADAPTERS[site.kind].loginUrl(site.base);
}

export function loginResult(site: Site, nav: LoginNav): Credential | null {
  return ADAPTERS[site.kind].loginResult(site.base, nav);
}

export function courses(s: Session): Promise<Course[]> {
  return ADAPTERS[s.site.kind].courses(s);
}

export function content(s: Session, courseId: string): Promise<CourseContent> {
  return ADAPTERS[s.site.kind].content(s, courseId);
}

export function grades(s: Session, courseId: string): Promise<CourseGrades> {
  return ADAPTERS[s.site.kind].grades(s, courseId);
}

/** The account id, or null where the site has no "who am I" call Phaethon may use (Moodle). */
export async function account(s: Session): Promise<string | null> {
  const a = ADAPTERS[s.site.kind];
  return a.account ? a.account(s) : null;
}

/** A SHA-256 of the kind, the site and the account id (32 hex digits), never the id itself. */
export function accountFingerprint(site: Site, accountId: string): string {
  const raw = `phaethon-lms-account\n${kindName(site.kind)}\n${site.address()}\n${accountId.trim()}`;
  return sha256Hex(raw).slice(0, 32);
}
