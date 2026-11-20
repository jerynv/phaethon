import type { AgentEvent } from "../../shared/agent.ts";
import type { TelemetryBackend } from "../../shared/telemetry.ts";
import { telemetry } from "./client.ts";

/** Enough raw answer to fill a trace message after redaction trims it. */
const MAX_ANSWER_CHARS = 16_000;

/**
 * Watches one backend attempt of a chat turn (automatic fallback can make
 * several per send). When it ends, records its diagnostics and, for a completed
 * turn whose `traceGrant` still holds, a trace of the new prompt and the
 * streamed answer: never tool calls, reasoning, system prompts or older messages.
 * `prompt` is null when continuing a turn, which has no new prompt to trace.
 */
export function recordTurn(backend: TelemetryBackend, prompt: string | null, traceGrant: number | null, client = telemetry) {
  const started = performance.now();
  const tracing = prompt !== null && traceGrant !== null;
  let failed = false;
  let cancelled = false;
  let steps = 0;
  let answer = "";
  let finished = false;
  return {
    event(event: AgentEvent) {
      if (event.kind === "error") failed = true;
      else if (event.kind === "cancelled") cancelled = true;
      else if (event.kind === "toolStart") steps++;
      else if (event.kind === "text" && tracing && answer.length < MAX_ANSWER_CHARS) answer += event.delta;
    },
    finish(aborted: boolean, threw = false) {
      if (finished) return;
      finished = true;
      const outcome = aborted || cancelled ? "cancelled" : failed || threw ? "failed" : "completed";
      client.capture("diagnostics", "turn_completed", {
        backend,
        outcome,
        durationMs: Math.min(86_400_000, Math.round(performance.now() - started)),
        steps: Math.min(steps, 10_000),
      });
      if (tracing && outcome === "completed" && answer.trim()) {
        const messages = [
          { role: "user", text: prompt },
          { role: "assistant", text: answer },
        ];
        client.capture("traces", "chat_trace", { backend, messages }, traceGrant);
      }
    },
  };
}
