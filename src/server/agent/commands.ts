/** Registers the agent worker's commands: providers, keys and models; tutor modes; agent turns. */
import "../providers/commands.ts";
import "./tutor.ts";
import "./turn.ts";

import { setProviderSettingsView } from "../settings/commands.ts";
import { providerSettingsView } from "../providers/build.ts";
// settings_get's provider half (keys present, presets, readiness) comes from the providers module.
setProviderSettingsView((s) => {
  const view = providerSettingsView(s);
  return { ...view, model: view.model ?? "" };
});
