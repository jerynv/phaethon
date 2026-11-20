import type { AgentEvent } from "../../shared/agent.ts";
import { telemetry, type Backend, type TelemetryClient } from "./client.ts";
import { redactText } from "./redact.ts";

/** Start once at the accepted turn, before any backend/fallback runs. */
export function turnConsent(client = telemetry) {
  return { diagnostics: client.ticket("diagnostics"), traces: client.ticket("traces") };
}

/** Only the new prompt and streamed answer; never reads stored conversations or tool data. */
export function recordTurn(backend: Backend, prompt: string | null, consent: ReturnType<typeof turnConsent>, client: TelemetryClient = telemetry) {
  const started = performance.now();
  let failed = false;
  let cancelled = false;
  let steps = 0;
  let text = "";
  let user = prompt !== null && client.valid("traces", consent.traces) ? redactText(prompt) : "";
  let finished = false;
  return {
    event(event: AgentEvent) {
      if (event.kind === "error") failed = true;
      if (event.kind === "cancelled") cancelled = true;
      if (event.kind === "toolStart") steps++;
      if (!client.current("traces", consent.traces)) { text = ""; user = ""; return; }
      if (event.kind === "text") text += event.delta.slice(0, Math.max(0, 32_000 - text.length));
    },
    finish(aborted: boolean, threw = false) {
      if (finished) return;
      finished = true;
      const outcome = aborted || cancelled ? "cancelled" : failed || threw ? "failed" : "completed";
      client.capture("diagnostics", "turn_completed", { backend, outcome, durationMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - started))), steps: Math.min(steps, 10_000) }, consent.diagnostics);
      if (outcome === "completed" && prompt !== null && text.trim() && client.valid("traces", consent.traces)) {
        client.capture("traces", "chat_trace", { backend, messages: [{ role: "user", text: user }, { role: "assistant", text: redactText(text) }] }, consent.traces);
      }
      text = ""; user = "";
    },
  };
}
