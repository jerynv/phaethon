import { keychainGet, providerAccount } from "../core/secrets.ts";
import { stringMap, readSettings, type Backend, type VaultSettings } from "../settings/settings.ts";
import { effectivePick } from "../threads/pick.ts";
import { Anthropic } from "./anthropic.ts";
import { FakeProvider, fakeScriptPath } from "./fake.ts";
import { OpenAiCompatible } from "./openai.ts";
import { baseUrl, chosen, chosenModel, jwtExpiry, keyFor, keyedIds, modelForSpace, parseRef, PRESETS, type ModelRef, type Preset } from "./presets.ts";
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

/**
 * The backend and Phaethon model conversation `thread` of `space` answers
 * with (threads/pick.ts); with no conversation, the ones a new chat starts
 * with (the last picked). `ref` is undefined for a coding agent or when no
 * model is chosen.
 */
export function conversationModel(space: string, thread?: string | null): { backend: Backend; ref: ModelRef | undefined } {
  const pick = effectivePick(space, thread ?? null).pick;
  const ref = pick.backend === "phaethon" && pick.model ? parseRef(pick.model) : undefined;
  return { backend: pick.backend, ref };
}

export type Sight = { sees: Sees; model: string; shown: boolean };

/** Can the model that answers this conversation (or a new chat in this space) look at pictures? (Study uses this for its material alerts.) */
export function sightFor(space: string, thread?: string | null): Sight {
  const settings = readSettings();
  let backend: Backend = settings.backend;
  let ref: ModelRef | undefined;
  try {
    ({ backend, ref } = conversationModel(space, thread));
  } catch {
    // An unreadable choice: the vault's backend and the space's model.
  }
  switch (backend) {
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
    ref ??= modelForSpace(space, settings);
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

/** `sightFor` a new chat in `space`. */
export function sightForSpace(space: string): Sight {
  return sightFor(space, null);
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
  /** When the saved key stops working (ms since the epoch), for keys that are sign-in tokens; else null. */
  keyExpiresAt: number | null;
  ready: boolean;
};

/** Whether `id` has a saved key and, for a sign-in token, when it expires. One keychain read; the key itself stays here. */
function savedKey(id: string): { has: boolean; expiresAt: number | null } {
  let saved: string | null;
  try {
    saved = readKey(id);
  } catch {
    return { has: false, expiresAt: null };
  }
  if (saved === null) return { has: false, expiresAt: null };
  let key = saved;
  if (id === "custom") {
    try {
      const k = (JSON.parse(saved) as { key?: unknown }).key;
      key = typeof k === "string" ? k : "";
    } catch {
      key = "";
    }
  }
  return { has: true, expiresAt: jwtExpiry(key) ?? null };
}

/**
 * The provider half of `settings_get` (storage's command merges this in):
 * `{hasAnthropicKey, model, provider, defaultModel, providerReady, providers}`.
 */
export function providerSettingsView(settings: VaultSettings = readSettings()) {
  const keyed = new Set(keyedIds());
  const current = chosen(settings);
  const fake = Boolean(fakeScriptPath());
  const providers: ProviderView[] = PRESETS.map((p) => {
    let base = "";
    let baseOk = true;
    try {
      base = baseUrl(settings, p);
    } catch {
      baseOk = false;
    }
    const saved = p.local || !keyed.has(p.id) ? { has: false, expiresAt: null } : savedKey(p.id);
    const k = saved.has;
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
      keyExpiresAt: saved.expiresAt,
      ready: baseOk && (p.key !== "required" || k || (fake && p.id === current.id)),
    };
  });
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
