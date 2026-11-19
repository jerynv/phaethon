import type { TelemetryChoices, TelemetrySettings } from "@/app/api";
import type { MockContext, MockHandlers } from "../mock-core";
// Pure string helper only; the telemetry transport is never imported into the renderer.
import { redactText } from "../../../../server/telemetry/redact.ts";

function settings(ctx: MockContext): TelemetrySettings {
  if (!ctx.state.telemetry) {
    const hash = new URLSearchParams(location.hash.slice(1));
    ctx.state.telemetry = {
      configured: hash.get("privacy") !== "unconfigured",
      collectorConfigured: hash.get("collector") === "1",
      usage: false, diagnostics: false, reports: false, traces: false,
    } satisfies TelemetrySettings;
  }
  return ctx.state.telemetry as TelemetrySettings;
}

export default {
  telemetry_get: (_args, ctx) => ({ ...settings(ctx) }),
  telemetry_set: ({ choices }: { choices: TelemetryChoices }, ctx) => {
    if (!["usage", "diagnostics", "reports", "traces"].every((c) => typeof choices?.[c as keyof TelemetryChoices] === "boolean")) throw "Choose on or off for each privacy setting.";
    const next = { ...settings(ctx), ...choices, configured: true };
    ctx.state.telemetry = next;
    return { ...next };
  },
  telemetry_usage: () => false,
  telemetry_report_preview: ({ text }: { text: string }) => redactText(text, 4000),
  telemetry_report_send: (_args, ctx) => {
    const s = settings(ctx);
    if (!s.reports || !s.collectorConfigured) throw "The report couldn’t be queued. Check that testing reports are enabled and a collector is configured.";
    return null;
  },
} satisfies MockHandlers;
