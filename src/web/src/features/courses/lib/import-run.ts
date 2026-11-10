/**
 * An import run: one row per course, moved along by the ImportEvent channel.
 * Pure (import-run.test.ts); the store in ../import-store.ts wires it to the
 * core.
 *
 * The run ends on the channel's terminal event (`done`, `cancelled`), never on
 * the command's return alone: a big `course` event (a long list of flagged
 * files) may arrive after `lms_import` resolves, and ending on the return
 * marked such a course "It wasn’t imported." while it had been. The store
 * waits for the terminal event, with a grace period if none ever comes.
 */
import { isSignedOut } from "./sites";
import type { LmsCourse, LmsImportEvent, LmsImportStep, MaterialSummary } from "./types";

export type CourseRun = {
  id: string;
  name: string;
  step?: LmsImportStep;
  done: number;
  total: number;
  result?: { folder: string; files: number; readings: number; links: number; skipped: string[]; material?: MaterialSummary };
  failed?: string;
};

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export type Run = {
  key: number;
  space: string;
  spaces: string[];
  connection: string;
  school: string;
  courses: CourseRun[];
  status: RunStatus;
  cancelling?: boolean;
  cancelError?: string;
  error?: string;
  notes?: string[];
};

export const SIGNED_OUT_DURING_IMPORT =
  "You were signed out of your course site partway through. Sign in again, then import again: what’s already here stays, and only what changed is downloaded.";

export function newRun(key: number, space: string, spaces: string[], connection: string, school: string, courses: Pick<LmsCourse, "id" | "name">[]): Run {
  return { key, space, spaces, connection, school, status: "running", courses: courses.map((c) => ({ id: c.id, name: c.name, done: 0, total: 0 })) };
}

const patch = (r: Run, id: string, f: (c: CourseRun) => CourseRun): Run => ({ ...r, courses: r.courses.map((c) => (c.id === id ? f(c) : c)) });

/** The course an event without an id is about: the one being worked on. */
const working = (r: Run) => r.courses.find((c) => !c.result && !c.failed && (c.step || c.done > 0)) ?? null;

/** End the run (once): a course that never reported back gets a reason. */
export function finishRun(r: Run, status: Exclude<RunStatus, "running">, error?: string, courseWhy?: string): Run {
  if (r.status !== "running") return r;
  return {
    ...r,
    status,
    error,
    cancelling: false,
    courses: r.courses.map((c) => (c.result || c.failed ? c : { ...c, step: undefined, failed: courseWhy ?? error ?? "It wasn’t imported." })),
  };
}

/** The run after one event; `course` is the row that just finished (imported or failed), if any. */
export function applyImportEvent(r: Run, e: LmsImportEvent): { run: Run; course?: CourseRun } {
  if (r.status !== "running") return { run: r };
  switch (e.type) {
    case "progress":
      return { run: patch(r, e.course, (c) => ({ ...c, step: e.step, done: e.done, total: e.total })) };
    case "course": {
      const run = patch(r, e.course, (c) => ({
        ...c,
        step: undefined,
        failed: undefined,
        done: Math.max(c.total, 1),
        total: Math.max(c.total, 1),
        result: { folder: e.folder, files: e.files, readings: e.readings, links: e.links, skipped: e.skipped, material: e.material },
      }));
      return { run, course: run.courses.find((x) => x.id === e.course) };
    }
    case "error": {
      if (isSignedOut(e.message)) return { run: finishRun(r, "failed", SIGNED_OUT_DURING_IMPORT, "You were signed out before this one.") };
      const at = working(r);
      if (!at) return { run: { ...r, notes: [...(r.notes ?? []), e.message] } };
      const rest = e.message.startsWith(`${at.name}: `) ? e.message.slice(at.name.length + 2) : e.message;
      const why = rest.charAt(0).toUpperCase() + rest.slice(1);
      const run = patch(r, at.id, (c) => ({ ...c, step: undefined, failed: why }));
      return { run, course: run.courses.find((x) => x.id === at.id) };
    }
    case "cancelled":
      return { run: finishRun(r, "cancelled", undefined, "Stopped") };
    case "done":
      return { run: finishRun(r, "done") };
  }
}

/** How a run ended, in a line. */
export function endText(r: Run): string {
  const saved = r.courses.filter((c) => c.result).length;
  const n = r.courses.length;
  if (r.status === "cancelled") return `Import stopped · ${saved} ${saved === 1 ? "course" : "courses"} saved.`;
  if (r.status === "failed" && saved === 0) return `The import stopped. ${r.error ?? ""}`.trim();
  if (saved === n) return `${n} ${n === 1 ? "course" : "courses"} imported.`;
  return `${saved} of ${n} courses imported.`;
}

/** A row's step in words: "Downloading files: 3 of 12". */
export function stepText(c: CourseRun): string {
  const words: Record<LmsImportStep, string> = {
    reading: "Reading the course",
    files: "Downloading files",
    readings: "Downloading readings",
    writing: "Writing the course folder",
  };
  if (!c.step) return c.result ? "Imported" : c.failed ? c.failed : "Waiting";
  return c.total > 1 ? `${words[c.step]}: ${Math.min(c.done, c.total)} of ${c.total}` : `${words[c.step]}…`;
}
