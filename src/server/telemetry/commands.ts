import { commands, Refusal } from "../rpc/registry.ts";
import { onStart, onStop } from "../lifecycle.ts";
import { collectorEndpoint, telemetry } from "./client.ts";
import { redactText } from "./redact.ts";

let opened = false;
function appOpened() {
  if (!opened && telemetry.capture("usage", "app_opened", {})) opened = true;
}
function view() { return { ...telemetry.consent(), collectorConfigured: collectorEndpoint() !== null }; }

commands({
  telemetry_get: () => view(),
  telemetry_set: ({ choices }: { choices: unknown }) => {
    try { telemetry.save(choices); } catch (error) { throw new Refusal((error as Error).message); }
    appOpened();
    return view();
  },
  telemetry_usage: ({ event, data }: { event: unknown; data: unknown }) => {
    return typeof event === "string" && telemetry.capture("usage", event, data);
  },
  telemetry_report_preview: ({ text }: { text: unknown }) => {
    if (typeof text !== "string" || text.length > 4000) throw new Refusal("Reports can contain up to 4,000 characters.");
    return redactText(text, 4000);
  },
  telemetry_report_send: ({ text }: { text: unknown }) => {
    if (typeof text !== "string" || !text.trim() || text.length > 4000) throw new Refusal("Write a report of up to 4,000 characters.");
    if (!telemetry.capture("reports", "testing_report", { text })) throw new Refusal("The report couldn’t be queued. Check that testing reports are enabled and a collector is configured.");
    return null;
  },
});

onStart("telemetry consent", appOpened);
onStop("stop telemetry", () => telemetry.close());
