/**
 * Plain helpers for taking a quiz (quiz-view.tsx): the letter of a choice,
 * an exam's scope said once, which question is next without an answer, and
 * the answers kept on this computer until they are checked, so leaving a
 * quiz (Back to Study, another view, closing the app) never loses them.
 */

export type Answer = string | string[];
export type Answers = Record<string, Answer>;

/** A, B, C … for the choices, as a printed test letters them. */
export const choiceLetter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

export const isAnswered = (a: Answer | undefined) => (Array.isArray(a) ? a.length > 0 : !!a?.trim());

/**
 * The scope's parts said once: "no graphs or combinatorics; not graphs or
 * combinatorics" (written that way by quizzes made before the core stopped
 * adding the second) keeps only the first.
 */
export function tidyScope(scope: string): string {
  const seen = new Set<string>();
  const parts = scope.split(/\s*;\s*/).filter((p) => {
    const key = p.toLowerCase().replace(/^(no|not)\s+/, "not ").replace(/[.\s]+$/, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return parts.join("; ");
}

/** The first question without an answer after `from` (an index), wrapping round; -1 when every one has one. */
export function nextUnanswered(ids: string[], answers: Answers, from: number): number {
  for (let k = 1; k <= ids.length; k++) {
    const i = (from + k) % ids.length;
    if (!isAnswered(answers[ids[i]])) return i;
  }
  return -1;
}

/** "4, 8 and 19". */
export function listWords(items: (string | number)[]): string {
  const s = items.map(String);
  return s.length <= 1 ? (s[0] ?? "") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;
}

const draftKey = (space: string, path: string) => `phaethon.quiz-draft:${space}:${path}`;

/**
 * Answers not yet checked, for this quiz as it was made (`created`): a quiz
 * made again under the same name starts empty. Only on this computer, and
 * nothing breaks when storage is unavailable.
 */
export function loadDraft(space: string, path: string, created: number, ids: string[]): Answers {
  try {
    const raw = globalThis.localStorage?.getItem(draftKey(space, path));
    if (!raw) return {};
    const d = JSON.parse(raw) as { created?: number; answers?: Answers };
    if (d.created !== created || !d.answers || typeof d.answers !== "object") {
      globalThis.localStorage?.removeItem(draftKey(space, path));
      return {};
    }
    const known = new Set(ids);
    return Object.fromEntries(Object.entries(d.answers).filter(([id, a]) => known.has(id) && (typeof a === "string" || (Array.isArray(a) && a.every((x) => typeof x === "string")))));
  } catch {
    return {};
  }
}

export function saveDraft(space: string, path: string, created: number, answers: Answers): void {
  try {
    if (Object.values(answers).some(isAnswered)) globalThis.localStorage?.setItem(draftKey(space, path), JSON.stringify({ created, answers }));
    else globalThis.localStorage?.removeItem(draftKey(space, path));
  } catch {
    // Storage full or blocked: the answers still stand on the page.
  }
}

export function clearDraft(space: string, path: string): void {
  try {
    globalThis.localStorage?.removeItem(draftKey(space, path));
  } catch {
    // Nothing to clear.
  }
}

/** How many answers are waiting in a draft, for the Study hub's row (the quiz itself isn't loaded there). */
export function draftCount(space: string, path: string): number {
  try {
    const raw = globalThis.localStorage?.getItem(draftKey(space, path));
    if (!raw) return 0;
    const d = JSON.parse(raw) as { answers?: Answers };
    return Object.values(d.answers ?? {}).filter(isAnswered).length;
  } catch {
    return 0;
  }
}
