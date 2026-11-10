// STUB: owned by study (study::attempts / load_attempt for the study_attempt tool)
export type AttemptSummary = { path: string; quiz: string; taken: number; score: unknown };

export function listAttempts(_space: string): AttemptSummary[] {
  return [];
}

export function loadAttempt(_space: string, _path: string): unknown {
  throw new Error("That quiz attempt isn’t in this space any more.");
}
