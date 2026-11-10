import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { vaultRoot } from "../core/vault.ts";
import { isValidAppearance, parseBackend, readSettings, setSetting, validateAppearance, type VaultSettings } from "./settings.ts";

/**
 * The provider half of `settings_get` (`hasAnthropicKey`, `model`, `provider`,
 * `defaultModel`, `providerReady`, `providers`) belongs to the providers
 * module, which installs it here with `setProviderSettingsView`. Until it
 * does, the fields come from settings.json alone, with no keys and no presets.
 */
export type ProviderSettingsView = {
  hasAnthropicKey: boolean;
  model: string;
  provider: string;
  defaultModel: string | null;
  providerReady: boolean;
  providers: unknown[];
};

type ProviderPart = (settings: VaultSettings) => ProviderSettingsView | Promise<ProviderSettingsView>;

let providerPart: ProviderPart = (s) => ({
  hasAnthropicKey: false,
  model: s.model ?? "",
  provider: s.provider ?? "anthropic",
  defaultModel: s.model,
  providerReady: false,
  providers: [],
});

export function setProviderSettingsView(part: ProviderPart): void {
  providerPart = part;
}

commands({
  settings_get: async () => {
    const s = readSettings();
    const providers = await providerPart(s);
    return {
      backend: s.backend,
      ...providers,
      appearance: s.appearance !== undefined && isValidAppearance(s.appearance) ? s.appearance : {},
      vaultPath: vaultRoot(),
      version: process.env.PHAETHON_VERSION ?? "0.0.0-dev",
    };
  },

  appearance_set: ({ appearance }: { appearance: unknown }) => {
    try {
      validateAppearance(appearance);
    } catch (e) {
      throw new Refusal(messageOf(e));
    }
    try {
      setSetting("appearance", appearance);
    } catch (e) {
      throw new Refusal(`Could not save your appearance settings: ${messageOf(e)}`);
    }
    return null;
  },

  settings_set_backend: ({ backend }: { backend: unknown }) => {
    const chosen = parseBackend(backend);
    if (!chosen) throw new Refusal("That isn’t an assistant Phaethon knows.");
    try {
      setSetting("backend", chosen);
    } catch (e) {
      throw new Refusal(`Could not save the setting: ${messageOf(e)}`);
    }
    return null;
  },
});
