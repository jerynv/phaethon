import { attempts, loadAttempt } from "./store.ts";

/**
 * The `study_attempt` agent tool (port of the tools.rs branch): lists and
 * reads completed quiz attempts in the current space only. The agent loop
 * registers it last in its tool list; it needs no approval.
 */

export const STUDY_ATTEMPT_TOOL = {
  name: "study_attempt",
  description:
    "Find completed quiz attempts in this space. Call with no path to list them, then call with an attempt path from that list to read the answers and results. Read the quiz itself with read_file using the quiz path in the attempt. This tool cannot read other hidden app state or another space.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "A quiz attempt path returned by this tool. Omit to list completed attempts." } },
    additionalProperties: false,
  },
} as const;

/** The input checked against the schema: `{path?: string}` and nothing else. Throws the model-facing message. */
export function parseStudyAttemptInput(input: unknown): { path: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw "input must be a JSON object";
  const obj = input as Record<string, unknown>;
  const extra = Object.keys(obj).find((k) => k !== "path");
  if (extra !== undefined) throw `unexpected field "${extra}"`;
  const v = obj.path;
  if (v === undefined || v === null) return { path: "" };
  if (typeof v !== "string") throw '"path" must be a string';
  return { path: v };
}

/** The activity label shown while it runs. */
export function studyAttemptLabel(input: unknown): string {
  let p = "";
  try {
    p = parseStudyAttemptInput(input).path;
  } catch {
    p = "";
  }
  return p === "" ? "Finding completed quizzes" : "Reading a completed quiz";
}

/** Runs the tool in `space` (the canonical space folder); returns compact JSON or throws a string. */
export function runStudyAttempt(space: string, input: unknown): string {
  const { path } = parseStudyAttemptInput(input);
  if (path === "") {
    const list = attempts(space)
      .map((a, i) => [a, i] as const)
      .sort((x, y) => y[0].taken - x[0].taken || x[1] - y[1])
      .slice(0, 100)
      .map(([a]) => ({ path: a.path, quiz: a.quiz, taken: a.taken, score: a.score }));
    return JSON.stringify(list);
  }
  return JSON.stringify(loadAttempt(space, path));
}
