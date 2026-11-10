import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { checkApiKey, keychainDelete, keychainSet, providerAccount } from "../core/secrets.ts";
import { stringMap, readSettings, updateSettings } from "../settings/settings.ts";
import * as anthropic from "./anthropic.ts";
import * as openai from "./openai.ts";
import { readKey } from "./build.ts";
import { baseUrl, bindCustomKey, checkBase, isValidCompatModel, isValidModelId, keyFor, keyProblem, presetOrRefuse } from "./presets.ts";

/**
 * Provider, key and model commands. Keys go from the renderer into the
 * keychain and never come back (only `hasKey` booleans, via settings_get).
 */

async function settingsWrite(f: () => void): Promise<null> {
  try {
    f();
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal(`Could not save the setting: ${messageOf(e)}`);
  }
  return null;
}

commands({
  settings_set_provider: ({ provider }: { provider: unknown }) => {
    const p = presetOrRefuse(provider);
    return settingsWrite(() => updateSettings({ provider: p.id }));
  },

  settings_set_provider_model: ({ provider, model }: { provider: unknown; model?: string | null }) => {
    const p = presetOrRefuse(provider);
    if (p.id === "anthropic") throw new Refusal("That isn’t a provider Phaethon knows.");
    const m = typeof model === "string" ? model.trim() : "";
    if (m && !isValidCompatModel(m)) throw new Refusal("That isn’t a model name Phaethon can use. It’s one word, like gpt-5 or llama3.2:3b.");
    const models = stringMap(readSettings().providerModels);
    if (m) models[p.id] = m;
    else delete models[p.id];
    return settingsWrite(() => updateSettings({ providerModels: models }));
  },

  settings_set_provider_url: ({ provider, url }: { provider: unknown; url?: string | null }) => {
    const p = presetOrRefuse(provider);
    if (!p.editableBase) throw new Refusal("That provider’s address can’t be changed.");
    const raw = typeof url === "string" ? url.trim() : "";
    const urls = stringMap(readSettings().providerUrls);
    if (raw) urls[p.id] = checkBase(raw);
    else delete urls[p.id];
    return settingsWrite(() => updateSettings({ providerUrls: urls }));
  },

  settings_set_model: ({ model }: { model?: string | null }) => {
    if (model !== null && model !== undefined && (typeof model !== "string" || !isValidModelId(model))) {
      throw new Refusal("That isn’t a model Phaethon knows how to use.");
    }
    return settingsWrite(() => updateSettings({ model: model ?? null }));
  },

  api_key_set: ({ provider, key }: { provider: unknown; key: unknown }) => {
    const p = presetOrRefuse(provider);
    if (p.key === "none") throw new Refusal("That provider doesn’t take a key.");
    if (typeof key !== "string") throw new Refusal("That does not look like an API key.");
    const settings = readSettings();
    const base = p.id === "custom" ? baseUrl(settings, p) : p.base;
    const problem = keyProblem(p, base, key);
    if (problem) throw new Refusal(problem);
    const clean = checkApiKey(key);
    keychainSet(providerAccount(p.id), p.id === "custom" ? bindCustomKey(base, clean) : clean);
    return null;
  },

  api_key_clear: ({ provider }: { provider: unknown }) => {
    const p = presetOrRefuse(provider);
    keychainDelete(providerAccount(p.id));
    return null;
  },

  api_key_check: async ({ key, provider }: { key: unknown; provider?: unknown }) => {
    const p = presetOrRefuse(provider ?? "anthropic");
    if (typeof key !== "string") return { ok: false, problem: "format", message: "That does not look like an API key." };
    if (p.id === "anthropic") return anthropic.checkKey(baseUrl(readSettings(), p), key);
    return openai.checkKey(p, baseUrl(readSettings(), p), key);
  },

  models_list: async ({ provider }: { provider?: unknown }) => {
    const p = presetOrRefuse(provider ?? "anthropic");
    const settings = readSettings();
    if (p.id === "anthropic") {
      let key: string | undefined;
      try {
        key = readKey("anthropic") ?? undefined;
      } catch {
        key = undefined;
      }
      return anthropic.modelsOrFallback(baseUrl(settings, p), key);
    }
    const base = baseUrl(settings, p);
    let key: string | undefined;
    try {
      key = keyFor(p, base, readKey);
    } catch {
      key = undefined;
    }
    try {
      return await openai.listModels(p, base, key);
    } catch (e) {
      throw new Refusal(messageOf(e));
    }
  },

  provider_status: async ({ provider }: { provider: unknown }) => {
    const p = presetOrRefuse(provider);
    if (!p.editableBase) throw new Refusal("Only a server on this computer or your own can be checked.");
    const base = baseUrl(readSettings(), p);
    let key: string | undefined;
    try {
      key = keyFor(p, base, readKey);
    } catch {
      key = undefined;
    }
    return openai.status(p, base, key);
  },
});
