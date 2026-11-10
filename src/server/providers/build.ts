import { keychainGet, providerAccount } from "../core/secrets.ts";
import { stringMap, readSettings, type VaultSettings } from "../settings/settings.ts";
import { Anthropic } from "./anthropic.ts";
import { FakeProvider, fakeScriptPath } from "./fake.ts";
import { OpenAiCompatible } from "./openai.ts";
import { baseUrl, chosen, chosenModel, keyFor, keyedIds, modelForSpace, PRESETS, type ModelRef, type Preset } from "./presets.ts";
import type { Provider, Sees } from "./types.ts";
import { sees as modelSight } from "./vision.ts";

/** Reads a provider's saved key from the vault's keychain namespace. */
export function readKey(id: string): string | null {
  return keychainGet(providerAccount(id));
}

/** A provider for one model reference. Throws a Refusal (shown as `noApiKey`) when it can't be used. */
export function providerFor(ref: ModelRef, settings: VaultSettings = readSettings()): Provider {
  const fake = fakeScriptPath();
  if (fake) return new FakeProvider(fake);
  const base = baseUrl(settings, ref.provider);
  const key = keyFor(ref.provider, base, readKey);
  if (ref.provider.id === "anthropic") return new Anthropic(key!, ref.model, base);
  return new OpenAiCompatible({ preset: ref.provider, base, key, model: ref.model });
}

/** The provider that answers in `space` (its own model, else the vault's default). */
export function forSpace(space: string | undefined): Provider {
  const settings = readSettings();
  return providerFor(modelForSpace(space, settings), settings);
}

export type Sight = { sees: Sees; model: string; shown: boolean };

/** Can the model that answers in this space look at pictures? (Study uses this for its material alerts.) */
export function sightForSpace(space: string): Sight {
  const settings = readSettings();
  switch (settings.backend) {
    case "claude-cli":
      return { sees: "yes", model: "Claude Code", shown: true };
    case "codex-cli":
      return { sees: "yes", model: "Codex", shown: true };
    case "gemini-cli":
      return { sees: "yes", model: "Gemini CLI", shown: false };
    default:
      break;
  }
  try {
    const ref = modelForSpace(space, settings);
    if (fakeScriptPath()) {
      const p = new FakeProvider(fakeScriptPath()!);
      return { sees: p.imageInput(), model: p.model, shown: p.imageInput() === "yes" };
    }
    const s = modelSight(ref.provider.id, baseUrl(settings, ref.provider), ref.model);
    return { sees: s, model: ref.model, shown: s === "yes" };
  } catch {
    return { sees: "unknown", model: chosen(settings).name, shown: false };
  }
}

export type ProviderView = {
  id: string;
  name: string;
  key: Preset["key"];
  local: boolean;
  editableBase: boolean;
  hasKey: boolean;
  baseUrl: string;
  defaultBaseUrl: string;
  model: string | null;
  keysUrl: string;
  keyPrefix: string;
  ready: boolean;
};

function hasKey(id: string): boolean {
  try {
    return readKey(id) !== null;
  } catch {
    return false;
  }
}

/**
 * The provider half of `settings_get` (storage's command merges this in):
 * `{hasAnthropicKey, model, provider, defaultModel, providerReady, providers}`.
 */
export function providerSettingsView(settings: VaultSettings = readSettings()) {
  const keyed = new Set(keyedIds());
  const providers: ProviderView[] = PRESETS.map((p) => {
    let base = "";
    let baseOk = true;
    try {
      base = baseUrl(settings, p);
    } catch {
      baseOk = false;
    }
    const k = p.local || !keyed.has(p.id) ? false : hasKey(p.id);
    const model = p.id === "anthropic" ? chosenModel(settings, p) ?? null : stringMap(settings.providerModels)[p.id]?.trim() || null;
    return {
      id: p.id,
      name: p.name,
      key: p.key,
      local: p.local,
      editableBase: p.editableBase,
      hasKey: k,
      baseUrl: p.editableBase ? stringMap(settings.providerUrls)[p.id]?.trim() ?? "" : base,
      defaultBaseUrl: p.base,
      model,
      keysUrl: p.keysUrl,
      keyPrefix: p.keyPrefix,
      ready: baseOk && (p.key !== "required" || k),
    };
  });
  const current = chosen(settings);
  const view = providers.find((v) => v.id === current.id)!;
  return {
    hasAnthropicKey: providers.find((v) => v.id === "anthropic")!.hasKey,
    model: settings.model,
    provider: current.id,
    defaultModel: chosenModel(settings, current) ?? null,
    providerReady: view.ready,
    providers,
  };
}
