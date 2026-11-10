import { spaceDir } from "../core/vault.ts";
import { promptSection as scopeSection } from "./scope.ts";
import { promptSection as studySection } from "./store.ts";
import { visibleFor } from "./visible.ts";

/**
 * Study's sections of the assistant's system prompt, for every backend.
 * Phaethon's own loop appends, in order: scopePromptSection, studyPromptSection,
 * STUDY_CHAT_PROMPT. CLI backends get the same three through
 * `studyPromptForCli` (the Rust core forgot the study section for CLIs, so
 * they never learned the deck format or the exam dates).
 */

export const STUDY_FENCE = "phaethon-study";

export const STUDY_CHAT_PROMPT = `# A quiz or flashcards from the chat

While you teach or explain, you may ask a quick check question to see whether an idea landed: one at a time, built on what you just explained, answerable by reasoning from it rather than by remembering a phrase, and talked through with the student once they answer. Use your check tool for it when you have one. A check like this is part of explaining, not a practice set.

A practice set is different: a quiz, a practice test, a batch of practice questions or flashcards for the student to keep and work through. Never write one in the chat yourself, not even a few items as a sample: Phaethon makes them, checking every item against the course's own notes and the exam's scope, and you can't. When the user asks for one, reply in a few short sentences of prose: what it will cover, which course material it draws on (by name), how many questions or cards, and which kinds of question. Everything Phaethon makes comes only from the course's own material (its files, syllabus, assignments, announcements and the readings it assigns) and what the user says it covers, so don't promise topics the course hasn't covered or an exam's coverage you haven't seen in its materials. Then end the reply with exactly one block like this, with nothing after it:

\`\`\`phaethon-study
{"kind": "quiz", "title": "Test 1 practice", "exam": "Test 1", "focus": "", "count": 10, "kinds": ["choice", "truefalse", "short"], "difficulty": "exam", "sources": ["courses/<course folder>"]}
\`\`\`

Reviewing existing study material is allowed directly in chat. When the user asks to review a completed quiz or explain a missed item, read the saved attempt and the quiz it names. Phaethon's own assistant can call study_attempt to find and read an attempt. Reproduce the original question and its answer choices on request, identify their selected answer and the correct answer, and explain the reasoning using the course material: what the right answer follows from, step by step, and which wrong idea leads to the answer they picked. Do not generate a new quiz or a study block unless the user asks for one.

The user sees the block as a button; pressing it makes the quiz from that material and opens it in Study. "kind" is "quiz" or "deck" (flashcards). "exam" names the exam it is for, as the course names it ("Test 1", "Midterm 2", "Final"), when it is for one: only that exam's scope is used, and if Phaethon can't find what the exam covers it asks the user. "count" is 1 to 50 questions, or 1 to 100 cards. For a quiz, "kinds" are some of choice, multi, truefalse, short, cloze, and "difficulty" is easier, exam or harder. "focus" names topics to narrow to, in a few words, or is empty. "sources" are the course folders (courses/<folder>) or files to draw on, as paths in this space; leave it empty for all of the user's courses. Use the block only when the user wants a practice set made. To change one, reply with a new block.`;

/** "# Study": where study files live, the deck format, and upcoming exams; null when the space has neither courses nor study/. */
export function studyPromptSection(space: string, now: number = Date.now()): string | null {
  const dir = spaceDir(space);
  return studySection(dir, !visibleFor(space).isEmpty(), now);
}

/** What each visible course teaches and what its exams cover; null when the space sees no course. */
export function scopePromptSection(space: string): string | null {
  return scopeSection(visibleFor(space));
}

/** Study's whole part of a CLI backend's appended system prompt (scope, study, chat block rules). */
export function studyPromptForCli(space: string, now: number = Date.now()): string {
  return [scopePromptSection(space), studyPromptSection(space, now), STUDY_CHAT_PROMPT].filter((s): s is string => !!s).join("\n\n");
}
