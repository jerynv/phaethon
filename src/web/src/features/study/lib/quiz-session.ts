/** Where a quiz was left (layout, flags, question), kept beside the answer draft. */
export type QuizSession = { layout: "single" | "all"; flagged: string[]; at: number };

const key = (space: string, path: string) => `phaethon.quiz-session:${space}:${path}`;

export function loadQuizSession(space: string, path: string, created: number, ids: string[]): QuizSession {
  const fallback: QuizSession = { layout: "single", flagged: [], at: 0 };
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(key(space, path)) ?? "null") as {
      created?: number;
      layout?: string;
      flagged?: unknown;
      at?: unknown;
    } | null;
    if (!value || value.created !== created) return fallback;
    return {
      layout: value.layout === "all" ? "all" : "single",
      flagged: Array.isArray(value.flagged)
        ? [...new Set<string>(value.flagged.filter((id: unknown): id is string => typeof id === "string" && ids.includes(id)))]
        : [],
      at: Number.isInteger(value.at) ? Math.max(0, Math.min(ids.length - 1, value.at as number)) : 0,
    };
  } catch {
    return fallback;
  }
}

export function saveQuizSession(space: string, path: string, created: number, session: QuizSession): void {
  try {
    globalThis.localStorage?.setItem(key(space, path), JSON.stringify({ ...session, created }));
  } catch {
    // The quiz stays usable when storage is unavailable.
  }
}

/** The message that asks the assistant for help with one question, without its answer or grading notes. */
export function questionHelpContext(
  quiz: { title: string; course?: string; sources: string[] },
  path: string,
  question: { prompt: string; choices?: string[]; kind: string },
  answer: string | string[] | undefined,
): string {
  return [
    `Help me work through this question from “${quiz.title}”${quiz.course ? ` (${quiz.course})` : ""}. Ask guiding questions before revealing the answer. Use only the course materials.`,
    `Quiz file: ${path}`,
    `Question: ${question.prompt}`,
    ...(question.choices?.length ? [`Choices: ${question.choices.map((choice, i) => `${String.fromCharCode(65 + i)}. ${choice}`).join("; ")}`] : []),
    ...(answer && (Array.isArray(answer) ? answer.length : answer.trim()) ? [`My current answer: ${Array.isArray(answer) ? answer.join(", ") : answer}`] : []),
    ...(quiz.sources.length ? [`Course sources: ${quiz.sources.join(", ")}`] : []),
  ].join("\n\n");
}
