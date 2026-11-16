import type { ToolCategory } from "#shared/agent.ts";

/**
 * What Phaethon is doing, in plain words, for people who don't care which
 * tool ran: "Reading week 6 notes", "Searching your School files". The
 * technical label and path stay available behind "Show technical details".
 */

type Step = { category: ToolCategory; label: string; target?: string };

/** "courses/math301/week-6_notes.md" → "week 6 notes". */
export function prettyName(path: string): string {
  const base = path.replace(/\/+$/, "").split("/").pop() ?? path;
  const stem = base.includes(".") && !base.startsWith(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const words = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words || base;
}

function folderName(path: string | undefined): string | null {
  const clean = (path ?? "").replace(/\/+$/, "");
  if (!clean || clean === ".") return null;
  return prettyName(clean);
}

export function friendlyStep(step: Step, spaceName?: string): string {
  const files = spaceName ? `your ${spaceName} files` : "your files";
  switch (step.category) {
    case "read":
      return step.target ? `Reading ${prettyName(step.target)}` : "Reading a file";
    case "list": {
      const f = folderName(step.target);
      return f ? `Looking through ${f}` : `Looking through ${files}`;
    }
    case "search":
      // Phaethon's own searches (memory, mail) name themselves; a file search says where.
      return step.label && !/^search(ing)?$/i.test(step.label.trim()) ? step.label : `Searching ${files}`;
    case "write":
      return step.target ? `Writing ${prettyName(step.target)}` : "Writing a file";
    case "command": {
      const line = step.target?.replace(/\s+/g, " ").trim();
      return line ? `Running ${line}` : "Working on your computer";
    }
    case "other":
      if (/^using tool$/i.test(step.label)) return step.target ? `Using ${prettyName(step.target)}` : "Working on it";
      return step.label;
  }
}

/** "4s", "1m 05s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** A reassuring second line once a single step has run a while, so a long step never looks stuck. */
export function patienceHint(ms: number, category?: ToolCategory): string | null {
  if (ms < 8000) return null;
  if (ms < 30000) return category === "read" ? "Still reading" : "Still on it";
  return "Still working";
}
