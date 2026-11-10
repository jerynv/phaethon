import accuracy from "./prompts/10-accuracy.md";
import method from "./prompts/20-method.md";
import voice from "./prompts/30-voice.md";
import richOutput from "./prompts/60-rich-output.md";
import { appGuideCliSection as guide } from "./app-guide.ts";
import { tutorSectionFor } from "./tutor.ts";

/**
 * The pieces of Phaethon's system prompt that CLI backends (Claude Code,
 * Codex, Gemini CLI) also get, appended to their own system prompt.
 */

/** How to reason and explain: the same accuracy, method and voice rules Phaethon's own agent follows. */
export const REASONING_PROMPT = [accuracy, method, voice].map((p) => p.trim()).join("\n\n");

/** What the chat renders ("How your replies are shown"). */
export const RICH_OUTPUT_PROMPT = richOutput.trim();

/** The buttons text plus where things are, given whole to CLIs (they can't ask for it). */
export function appGuideCliSection(): string {
  return guide();
}

/** The space's tutor mode; null for the normal mode. */
export function tutorModeSection(space: string): string | null {
  return tutorSectionFor(space) ?? null;
}
