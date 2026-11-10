// STUB: owned by study worker. Minimal stand-in so the CLI worker's code runs
// before the study branch is merged; the integrator keeps the study worker's
// real file.

/** The `phaethon-study` block instructions every CLI turn gets (study chat prompt). */
export const STUDY_CHAT_PROMPT = "# A quiz or flashcards from the chat";

/** What each visible course teaches and its exams cover; null when nothing applies. */
export function scopePromptSection(_space: string): string | null {
  return null;
}

export function studyPromptSection(_space: string): string | null {
  return null;
}
