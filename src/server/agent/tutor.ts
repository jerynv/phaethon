import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { spaceDir } from "../core/vault.ts";
import { listSpaces, readSpaceMeta, updateSpaceMeta } from "../spaces/meta.ts";
import teaching from "./prompts/tutor/10-teaching.md";
import quiz from "./prompts/tutor/quiz.md";
import explain from "./prompts/tutor/explain.md";
import socratic from "./prompts/tutor/socratic.md";
import cram from "./prompts/tutor/cram.md";

/**
 * Tutor modes: a per-space setting (`tutorMode` in space.json; absent =
 * normal) that adds teaching instructions to every turn and offers the lesson
 * tools. The instructions build on the explanation method in the base prompt.
 */

export type TutorMode = "normal" | "quiz" | "explain" | "socratic" | "cram";

export const TUTOR_TITLES: Record<TutorMode, string> = {
  normal: "Normal",
  quiz: "Quiz me",
  explain: "Explain it back",
  socratic: "Socratic",
  cram: "Exam cram",
};

const INSTRUCTIONS: Record<Exclude<TutorMode, "normal">, string> = { quiz, explain, socratic, cram };

export function parseMode(v: unknown): TutorMode {
  if (typeof v !== "string") return "normal";
  const s = v.trim();
  return s in TUTOR_TITLES ? (s as TutorMode) : "normal";
}

export function tutorMode(space: string): TutorMode {
  try {
    return parseMode(readSpaceMeta(space).tutorMode);
  } catch {
    return "normal";
  }
}

/** The prompt section for a mode; undefined for normal. */
export function tutorSection(mode: TutorMode): string | undefined {
  if (mode === "normal") return undefined;
  return `# Tutor mode: ${TUTOR_TITLES[mode]}\n\nThe user turned this on for this space, so it holds for every message until they turn it off.\n\n${INSTRUCTIONS[mode].trim()}\n\n${teaching.trim()}`;
}

/** For CLI backends (`--append-system-prompt`). */
export function tutorSectionFor(space: string): string | undefined {
  return tutorSection(tutorMode(space));
}

commands({
  space_tutor_mode_set: ({ space, mode }: { space: unknown; mode: unknown }) => {
    const id = String(space);
    spaceDir(id);
    if (typeof mode !== "string" || !(mode in TUTOR_TITLES)) throw new Refusal("That isn’t a tutor mode Phaethon knows.");
    try {
      updateSpaceMeta(id, { tutorMode: mode === "normal" ? undefined : mode });
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(`The tutor mode couldn’t be saved: ${messageOf(e)}`);
    }
    return null;
  },

  space_tutor_modes_list: () => {
    const out: Record<string, TutorMode> = {};
    for (const s of listSpaces()) {
      const mode = tutorMode(s.id);
      if (mode !== "normal") out[s.id] = mode;
    }
    return out;
  },
});
