import { commands, Refusal } from "../rpc/registry.ts";
import { onStart, onStop } from "../lifecycle.ts";
import { MAX_REPORT_CHARS } from "../../shared/telemetry.ts";
import { collectorEndpoint, telemetry } from "./client.ts";
import { redactText } from "./redact.ts";

let opened = false;
/** Once per launch, as soon as usage is allowed (at startup, or when first saved). */
function appOpened() {
  if (!opened) opened = telemetry.capture("usage", "app_opened", {});
}

function view() {
  return { ...telemetry.consent(), collectorConfigured: collectorEndpoint() !== null };
}

function reportText(text: unknown): string {
  if (typeof text !== "string" || !text.trim() || text.length > MAX_REPORT_CHARS) {
    throw new Refusal("Write a report of up to 4,000 characters.");
  }
  return text;
}

commands({
  telemetry_get: () => view(),
  telemetry_set: ({ choices }: { choices: unknown }) => {
    try {
      telemetry.save(choices);
    } catch (error) {
      throw new Refusal((error as Error).message);
    }
    appOpened();
    return view();
  },
  /** Views and file opens, which only the window sees. */
  telemetry_usage: ({ event, data }: { event: unknown; data: unknown }) =>
    typeof event === "string" && telemetry.capture("usage", event, data),
  /** The report as it would be sent, so the person can check what redaction missed. */
  telemetry_report_preview: ({ text }: { text: unknown }) => redactText(reportText(text), MAX_REPORT_CHARS),
  telemetry_report_send: ({ text }: { text: unknown }) => {
    if (!telemetry.capture("reports", "testing_report", { text: reportText(text) })) {
      throw new Refusal("The report couldn’t be sent. Turn on testing reports in Privacy settings first.");
    }
    return null;
  },
});

onStart("telemetry", appOpened);
onStop("telemetry", () => telemetry.close());
