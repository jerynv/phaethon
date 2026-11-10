import { spaceDir, vaultName } from "../core/vault.ts";
import { onStart } from "../lifecycle.ts";
import { log } from "../log.ts";
import type { Channel } from "../rpc/channel.ts";
import { commands, Refusal } from "../rpc/registry.ts";
import { allCourses, parsePart, set as setAccess, view as accessView, visible, type Part } from "./access.ts";
import { courseContent } from "./browse.ts";
import { partitionFor, signIn } from "./login.ts";
import { run as migrate } from "./migrate.ts";
import { check as probe } from "./probe.ts";
import {
  cancelImport,
  connections,
  courses,
  disconnect,
  finishSignIn,
  grades,
  gradesRefresh,
  importCourses,
  schools,
  type GradesEvent,
  type ImportEvent,
} from "./service.ts";
import { isKind, Site, type Kind } from "./types.ts";

/** The `lms_*` and `course_access_*` commands, as the Tauri app had them. */

function kindOf(k: unknown): Kind {
  if (!isKind(k)) throw new Refusal("That isn’t a course site Phaethon knows.");
  return k;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Refusal(`${what} is missing.`);
  return v;
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Refusal(`${what} is missing.`);
  return v;
}

commands({
  lms_schools: (a: { kind: unknown; query: unknown }) => schools(kindOf(a.kind), str(a.query, "The search")),

  lms_connect: async (a: { kind: unknown; address: unknown; schoolName?: unknown }) => {
    const site = Site.create(kindOf(a.kind), str(a.address, "The address"));
    const given = typeof a.schoolName === "string" && a.schoolName.trim() ? a.schoolName : null;
    const school = given ?? (site.base.hostname || "your school");
    await probe(site);
    const credential = await signIn(site, `Sign in to ${school}`, partitionFor(vaultName()));
    return finishSignIn(site, credential, given);
  },

  lms_connections: () => connections(),

  lms_courses: (a: { connection: unknown }) => courses(str(a.connection, "The connection")),

  lms_import: async (a: { connection: unknown; courseIds: unknown; spaces: unknown; onEvent?: Channel<ImportEvent> }) => {
    const send = (e: ImportEvent) => a.onEvent?.send(e);
    let connection: string;
    let ids: string[];
    let spaces: string[];
    try {
      connection = str(a.connection, "The connection");
      ids = strings(a.courseIds, "The courses");
      spaces = strings(a.spaces, "The spaces");
    } catch (e) {
      send({ type: "error", message: (e as Error).message });
      send({ type: "done" });
      return null;
    }
    await importCourses(connection, ids, spaces, send);
    return null;
  },

  lms_import_cancel: (a: { connection: unknown }) => cancelImport(str(a.connection, "The connection")),

  lms_course_content: (a: { space: unknown; course: unknown }) => courseContent(str(a.space, "The space"), str(a.course, "The course")),

  lms_disconnect: (a: { connection: unknown }) => {
    disconnect(str(a.connection, "The connection"));
    return null;
  },

  lms_grades: (a: { space: unknown }) => {
    const space = str(a.space, "The space");
    spaceDir(space);
    return grades(visible(space));
  },

  lms_grades_refresh: async (a: { space: unknown; connection: unknown; onEvent?: Channel<GradesEvent> }) => {
    const send = (e: GradesEvent) => a.onEvent?.send(e);
    try {
      spaceDir(a.space);
    } catch (e) {
      send({ type: "error", message: (e as Error).message });
      send({ type: "done" });
      return null;
    }
    await gradesRefresh(visible(a.space as string), str(a.connection, "The connection"), send);
    return null;
  },

  course_access_get: (a: { space?: unknown }) => accessView(typeof a.space === "string" ? a.space : null),

  course_access_set: (a: { space: unknown; course: unknown; parts: unknown }) => {
    const course = str(a.course, "The course");
    if (!allCourses().some((c) => c.key === course)) throw new Refusal("That course isn’t imported.");
    const raw = Array.isArray(a.parts) ? a.parts : [];
    const parts: Part[] = [];
    for (const p of raw) {
      const part = parsePart(p);
      if (!part) throw new Refusal(`${JSON.stringify(p)} isn’t a part of a course.`);
      parts.push(part);
    }
    setAccess(str(a.space, "The space"), course, parts);
    return null;
  },
});

onStart("move course sites to the vault", () => {
  // In the background, as the Rust app did: startup doesn't wait on the keychain.
  setTimeout(() => {
    try {
      const report = migrate();
      for (const line of [...report.moved, ...report.notes]) log.info(`course sites: ${line}`);
    } catch (e) {
      log.warn("course sites: the move to the vault failed", e);
    }
  }, 0);
});
