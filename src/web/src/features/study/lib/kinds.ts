/** Question kinds in words, in the order the make dialog offers them. */
import type { QuestionKind } from "./types";

export const KINDS: { kind: QuestionKind; label: string }[] = [
  { kind: "choice", label: "Multiple choice" },
  { kind: "multi", label: "Select all" },
  { kind: "truefalse", label: "True or false" },
  { kind: "short", label: "Short answer" },
  { kind: "cloze", label: "Fill in the blank" },
];

export const kindLabel = (k: QuestionKind) => KINDS.find((x) => x.kind === k)?.label ?? k;

/** The paths a course's parts stand for, as study_make_* takes them. */
export function partPath(folder: string, part: "syllabus" | "assignments" | "files" | "readings"): string {
  return part === "syllabus" ? `${folder}/syllabus.md` : part === "assignments" ? `${folder}/assignments.md` : `${folder}/${part}`;
}

/** The courses (folders) that chosen paths come from. */
export function coursesOf(paths: Iterable<string>, folders: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const f = folders.find((x) => p === x || p.startsWith(`${x}/`));
    if (f) out.add(f);
  }
  return [...out];
}
