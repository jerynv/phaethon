/**
 * A course's imported content as Courses shows it: files grouped so the ones
 * that came from an announcement or discussion are easy to find, and the
 * last import's notes split into locked items (with why) and the rest.
 * Pure (content.test.ts).
 */
import type { CourseContentEntry } from "./types";

export type FileGroup = { id: string; label: string; entries: CourseContentEntry[] };

/** The folder a course file sits in, below `files/` ("Lecture notes"), or "" at the top. */
export function folderOf(path: string): string {
  const m = /\/files\/(.+)\/[^/]+$/.exec(path);
  return m ? m[1]! : "";
}

/**
 * Files in groups: attachments of announcements and discussions first (they
 * are the ones people can't find), then each folder of the course's files in
 * name order, the top folder first.
 */
export function fileGroups(entries: readonly CourseContentEntry[]): FileGroup[] {
  const files = entries.filter((e) => e.kind === "file");
  const attached = files.filter((e) => e.from);
  const rest = files.filter((e) => !e.from);
  const folders = new Map<string, CourseContentEntry[]>();
  for (const e of rest) {
    const f = folderOf(e.path);
    folders.set(f, [...(folders.get(f) ?? []), e]);
  }
  const out: FileGroup[] = [];
  if (attached.length) out.push({ id: "attached", label: "From announcements and discussions", entries: attached });
  for (const f of [...folders.keys()].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))) {
    out.push({ id: `folder:${f}`, label: f || "Course files", entries: folders.get(f)! });
  }
  return out;
}

export type SkippedNote = { what: string; why: string; locked: boolean };

/** One note of the last import ("File “X” (from announcement “Y”): locked for now") as what and why. */
export function readSkipped(note: string): SkippedNote {
  const i = note.lastIndexOf(": ");
  const what = i > 0 ? note.slice(0, i) : note;
  const why = i > 0 ? note.slice(i + 2) : "";
  return { what: what.replace(/^(File|Page) “(.+?)”/, "$2"), why, locked: /\blocked\b/i.test(why) };
}

/** Locked items first (they open later), then everything else the import couldn't bring in. */
export function skippedGroups(notes: readonly string[] | undefined): { locked: SkippedNote[]; other: SkippedNote[] } {
  const all = (notes ?? []).map(readSkipped);
  return { locked: all.filter((n) => n.locked), other: all.filter((n) => !n.locked) };
}
