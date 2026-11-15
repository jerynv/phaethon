/**
 * The composer's autocomplete, after T3 Code's: `@` mentions a file in the
 * space, `/` at the start of a line runs a command. Pure, so the trigger
 * rules and the ranking are unit-tested.
 */

export type Trigger = { kind: "mention" | "command"; query: string; start: number; end: number };

/** The trigger the caret sits in, if any: `@que|` after a space or line start, `/que|` at a line start. */
export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const mention = /(^|\s)@([^\s@]*)$/.exec(before);
  if (mention) {
    const start = caret - mention[2]!.length - 1;
    return { kind: "mention", query: mention[2]!, start, end: caret };
  }
  const command = /(^|\n)\/([a-z-]*)$/i.exec(before);
  if (command) {
    const start = caret - command[2]!.length - 1;
    return { kind: "command", query: command[2]!, start, end: caret };
  }
  return null;
}

/** The text with the trigger replaced, and where the caret goes. */
export function replaceTrigger(text: string, t: Trigger, insert: string): { text: string; caret: number } {
  const after = text.slice(t.end);
  const glue = insert && !/^\s/.test(after) ? " " : "";
  const next = text.slice(0, t.start) + insert + glue + after;
  return { text: next, caret: t.start + insert.length + glue.length };
}

/** A mention as written into the message: `@notes/a.md`, quoted when the path has spaces. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function score(path: string, q: string): number {
  if (!q) return 1;
  const p = path.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return 4;
  if (base.includes(q)) return 3;
  if (p.includes(q)) return 2;
  // Letters in order ("lec7" finds "lecture-7.md").
  let i = 0;
  for (const ch of base) if (ch === q[i]) i++;
  return i === q.length ? 1 : 0;
}

/** Files that match the query, best first (newest first within a rank: the list comes newest first). */
export function rankFiles<T extends { path: string }>(files: T[], query: string, limit = 8): T[] {
  const q = query.toLowerCase();
  return files
    .map((f, i) => ({ f, s: score(f.path, q), i }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.f);
}

export type ComposerCommand = { id: string; label: string; hint: string; keywords?: string[]; edu?: boolean };

export const COMMANDS: ComposerCommand[] = [
  { id: "quiz", label: "quiz", hint: "Teaching mode: asks questions to check you", edu: true, keywords: ["test", "practice"] },
  { id: "explain", label: "explain", hint: "Teaching mode: you teach it, it corrects you", edu: true, keywords: ["explain back"] },
  { id: "socratic", label: "socratic", hint: "Teaching mode: leads with questions, never the answer", edu: true },
  { id: "cram", label: "cram", hint: "Teaching mode: fast review of what’s on the exam", edu: true, keywords: ["exam"] },
  { id: "normal", label: "normal", hint: "Teaching mode: answers and explains", edu: true },
  { id: "new", label: "new", hint: "Start a new chat", keywords: ["chat", "clear"] },
  { id: "model", label: "model", hint: "Choose the model for this chat", keywords: ["provider"] },
  { id: "attach", label: "attach", hint: "Attach files from this computer", keywords: ["file", "upload"] },
];

export function rankCommands(query: string, edu: boolean): ComposerCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => (edu || !c.edu) && (!q || c.label.startsWith(q) || c.keywords?.some((k) => k.startsWith(q)) || c.label.includes(q)));
}
