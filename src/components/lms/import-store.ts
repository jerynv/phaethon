import { useSyncExternalStore } from "react";

import { importCourses, type ImportEvent, type LmsCourse } from "@/lib/lms";

// ---- Opening the dialog ----

/**
 * Where the Import courses dialog opens. `space`: the space it imports into
 * (and whose course sites it uses). With `connection` it starts at that site:
 * "choose" its courses, "signin" again, or "sync" (import its imported
 * courses again, straight to progress). "run": the import running now, or
 * the one that just finished.
 */
export type ImportRequest = { space: string; connection?: string; at?: "choose" | "signin" | "sync" | "run"; key: number };

let request: ImportRequest | null = null;
let nextKey = 1;
const requestListeners = new Set<() => void>();

export function openCourseImport(r: Omit<ImportRequest, "key">): void {
  request = { ...r, key: nextKey++ };
  requestListeners.forEach((l) => l());
}

export const useImportRequest = () =>
  useSyncExternalStore(
    (cb) => {
      requestListeners.add(cb);
      return () => requestListeners.delete(cb);
    },
    () => request,
  );

// ---- The run ----
// One import at a time, kept here rather than in the dialog: closing the
// dialog never stops it, and opening it again shows where it is.

export type CourseRun = {
  id: string;
  name: string;
  /** What it is doing now ("Downloading files"), until it is done or failed. */
  step?: string;
  done: number;
  total: number;
  result?: { folder: string; files: number; readings: number; links: number; skipped: string[] };
  failed?: string;
};

export type Run = {
  key: number;
  space: string;
  connection: string;
  school: string;
  courses: CourseRun[];
  status: "running" | "done" | "failed";
  /** Why the whole import stopped (status "failed"). */
  error?: string;
};

let run: Run | null = null;
let runKey = 1;
const runListeners = new Set<() => void>();
function setRun(next: Run | null) {
  run = next;
  runListeners.forEach((l) => l());
}
export const getRun = () => run;
export const useRun = () =>
  useSyncExternalStore(
    (cb) => {
      runListeners.add(cb);
      return () => runListeners.delete(cb);
    },
    () => run,
  );

/** Forget a finished run (a new import starts from a clean slate). */
export function clearRun(): void {
  if (run && run.status !== "running") setRun(null);
}

const patchCourse = (r: Run, id: string, f: (c: CourseRun) => CourseRun): Run => ({
  ...r,
  courses: r.courses.map((c) => (c.id === id ? f(c) : c)),
});

/** The course an event without an id is about: the one being worked on. */
const working = (r: Run) => r.courses.find((c) => !c.result && !c.failed && (c.step || c.done > 0)) ?? null;

/**
 * Start importing `courses` into `space`. Refused (false) while another import
 * runs. `onCourse` hears each course as it finishes, and `onEnd` the end.
 */
export function startImport(
  space: string,
  connection: string,
  school: string,
  courses: Pick<LmsCourse, "id" | "name">[],
  hooks: { onCourse?: (c: CourseRun) => void; onEnd?: (r: Run) => void } = {},
): boolean {
  if (run?.status === "running") return false;
  const key = runKey++;
  setRun({ key, space, connection, school, status: "running", courses: courses.map((c) => ({ id: c.id, name: c.name, done: 0, total: 0 })) });
  const mine = () => (run?.key === key ? run : null);

  function finish(status: Run["status"], error?: string) {
    const r = mine();
    if (!r || r.status !== "running") return;
    // A course that never reported back wasn't imported.
    const courses = r.courses.map((c) => (c.result || c.failed ? c : { ...c, step: undefined, failed: error ?? "It wasn’t imported." }));
    const next = { ...r, courses, status, error };
    setRun(next);
    hooks.onEnd?.(next);
  }

  function onEvent(e: ImportEvent) {
    const r = mine();
    if (!r || r.status !== "running") return;
    if (e.type === "progress") {
      setRun(patchCourse(r, e.course, (c) => ({ ...c, step: e.step, done: e.done, total: e.total })));
    } else if (e.type === "course") {
      const next = patchCourse(r, e.course, (c) => ({
        ...c,
        step: undefined,
        done: Math.max(c.total, 1),
        total: Math.max(c.total, 1),
        result: { folder: e.folder, files: e.files, readings: e.readings, links: e.links, skipped: e.skipped },
      }));
      setRun(next);
      const c = next.courses.find((x) => x.id === e.course);
      if (c) hooks.onCourse?.(c);
    } else if (e.type === "error") {
      // About the course being worked on: it failed, the rest go on. Otherwise the whole import stopped.
      const at = working(r);
      if (!at) return finish("failed", e.message);
      const next = patchCourse(r, at.id, (c) => ({ ...c, step: undefined, failed: e.message }));
      setRun(next);
      const c = next.courses.find((x) => x.id === at.id);
      if (c) hooks.onCourse?.(c);
    } else if (e.type === "done") {
      finish("done");
    }
  }

  importCourses(
    space,
    connection,
    courses.map((c) => c.id),
    onEvent,
  ).then(
    () => finish("done"),
    (err: unknown) => finish("failed", String(err)),
  );
  return true;
}

// ---- Course sites changed ----
// Bumped when a sign-in finishes or the dialog closes, so lists of sites
// (Settings › Course sites, the empty conversation) read them again.

let sitesVersion = 0;
const sitesListeners = new Set<() => void>();
export function sitesChanged(): void {
  sitesVersion++;
  sitesListeners.forEach((l) => l());
}
export const useSitesVersion = () =>
  useSyncExternalStore(
    (cb) => {
      sitesListeners.add(cb);
      return () => sitesListeners.delete(cb);
    },
    () => sitesVersion,
  );
