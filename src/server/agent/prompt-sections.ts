// STUB: owned by agent worker. The CLI backends need three prompt pieces the
// agent worker owns (loop.md §1.4, §1.5, §1.11 / §8.2–8.3); this stand-in lets
// the CLI worker's code run before that branch is merged. The integrator
// points these at the agent worker's real exports.

/** `rich_output::PROMPT` ("How your replies are shown"). */
export const RICH_OUTPUT_PROMPT = "# How your replies are shown";

/** `app_guide::cli_section()`: the buttons text plus PLACES, given whole to CLIs (they can't call app_guide). */
export function appGuideCliSection(): string {
  return "# Buttons";
}

/** `tutor_mode::prompt_section(space)`; null for the normal mode. */
export function tutorModeSection(_space: string): string | null {
  return null;
}
