import { Refusal } from "../rpc/registry.ts";
import { stringMap, readSettings, type VaultSettings } from "../settings/settings.ts";
import { readSpaceMeta } from "../spaces/meta.ts";
import { byteLength } from "../core/fsx.ts";

/**
 * The providers Phaethon's own agent can use, how a model is named, and the
 * rules that keep each API key going only to its own provider.
 */

export type KeyNeed = "required" | "optional" | "none";
export type Preset = {
  id: string;
  name: string;
  base: string;
  key: KeyNeed;
  local: boolean;
  editableBase: boolean;
  keysUrl: string;
  keyPrefix: string;
  checkPath: string;
};

const p = (id: string, name: string, base: string, key: KeyNeed, local: boolean, editableBase: boolean, keysUrl: string, keyPrefix: string, checkPath: string): Preset => ({
  id,
  name,
  base,
  key,
  local,
  editableBase,
  keysUrl,
  keyPrefix,
  checkPath,
});

export const PRESETS: Preset[] = [
  p("anthropic", "Anthropic", "https://api.anthropic.com", "required", false, false, "https://console.anthropic.com/settings/keys", "sk-ant-", "/v1/models?limit=1"),
  p("openai", "OpenAI", "https://api.openai.com/v1", "required", false, false, "https://platform.openai.com/api-keys", "", "/models"),
  p("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "required", false, false, "https://openrouter.ai/settings/keys", "sk-or-", "/key"),
  p("groq", "Groq", "https://api.groq.com/openai/v1", "required", false, false, "https://console.groq.com/keys", "gsk_", "/models"),
  p("together", "Together AI", "https://api.together.xyz/v1", "required", false, false, "https://api.together.ai/settings/api-keys", "", "/models"),
  p("mistral", "Mistral", "https://api.mistral.ai/v1", "required", false, false, "https://console.mistral.ai/api-keys", "", "/models"),
  p("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "required", false, false, "https://platform.deepseek.com/api_keys", "", "/models"),
  p("xai", "xAI", "https://api.x.ai/v1", "required", false, false, "https://console.x.ai", "xai-", "/models"),
  p("ollama", "Ollama", "http://127.0.0.1:11434/v1", "none", true, true, "", "", "/models"),
  p("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", "none", true, true, "", "", "/models"),
  p("custom", "Your own server", "", "optional", false, true, "", "", "/models"),
];

export const DEFAULT_MODEL = "claude-opus-5-5";

export function preset(id: string): Preset | undefined {
  return PRESETS.find((x) => x.id === id);
}

export function presetOrRefuse(id: unknown): Preset {
  const found = typeof id === "string" ? preset(id) : undefined;
  if (!found) throw new Refusal("That isn’t a provider Phaethon knows.");
  return found;
}

/** Presets that take a key, in order (the keychain's provider list). */
export function keyedIds(): string[] {
  return PRESETS.filter((x) => x.key !== "none").map((x) => x.id);
}

export function isValidModelId(id: string): boolean {
  return id.startsWith("claude-") && id.length >= 8 && id.length <= 80 && /^[a-z0-9.-]+$/.test(id);
}

export function isValidCompatModel(id: string): boolean {
  const n = byteLength(id);
  return n >= 1 && n <= 200 && !/^[-./:]/.test(id) && !id.includes("..") && /^[A-Za-z0-9\-_.:/@+]+$/.test(id);
}

export type ModelRef = { provider: Preset; model: string };

/** `provider:model`, or a plain Anthropic id (older saved form). */
export function parseRef(raw: string): ModelRef | undefined {
  const s = raw.trim();
  const colon = s.indexOf(":");
  if (colon > 0) {
    const pre = preset(s.slice(0, colon));
    if (pre) {
      const model = s.slice(colon + 1);
      const ok = pre.id === "anthropic" ? isValidModelId(model) : isValidCompatModel(model);
      return ok ? { provider: pre, model } : undefined;
    }
  }
  return isValidModelId(s) ? { provider: preset("anthropic")!, model: s } : undefined;
}

/** The saved form: plain for Anthropic, `provider:model` otherwise. */
export function savedRef(ref: ModelRef): string {
  return ref.provider.id === "anthropic" ? ref.model : `${ref.provider.id}:${ref.model}`;
}

export function chosen(settings: VaultSettings = readSettings()): Preset {
  return (settings.provider && preset(settings.provider)) || preset("anthropic")!;
}

export function chosenModel(settings: VaultSettings, pre: Preset): string | undefined {
  if (pre.id === "anthropic") return settings.model && isValidModelId(settings.model) ? settings.model : DEFAULT_MODEL;
  const m = stringMap(settings.providerModels)[pre.id]?.trim();
  return m && isValidCompatModel(m) ? m : undefined;
}

export function defaultRef(settings: VaultSettings = readSettings()): ModelRef | undefined {
  const pre = chosen(settings);
  const model = chosenModel(settings, pre);
  return model ? { provider: pre, model } : undefined;
}

/** The space's own model, else the vault default. */
export function modelForSpace(space: string | undefined, settings: VaultSettings = readSettings()): ModelRef {
  if (space) {
    const own = readSpaceMeta(space).model;
    if (typeof own === "string") {
      const ref = parseRef(own);
      if (ref) return ref;
    }
  }
  const ref = defaultRef(settings);
  if (!ref) throw new Refusal(`Choose which ${chosen(settings).name} model answers, in Settings › Assistant.`);
  return ref;
}

// ---------------------------------------------------------------------------
// Addresses

export const BAD_ADDRESS = "That isn’t an address Phaethon can use. It looks like http://127.0.0.1:11434/v1 or https://example.com/v1.";

/** Validates a user-supplied base URL and returns it without a trailing "/". */
export function checkBase(raw: string): string {
  const s = raw.trim();
  if (!s || [...s].length > 300 || /\s/.test(s)) throw new Refusal(BAD_ADDRESS);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Refusal(BAD_ADDRESS);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || url.search || url.hash || s.includes("?") || s.includes("#")) {
    throw new Refusal(BAD_ADDRESS);
  }
  return url.toString().replace(/\/+$/, "");
}

export function origin(base: string): string | undefined {
  try {
    const u = new URL(base);
    return u.origin === "null" ? undefined : u.origin;
  } catch {
    return undefined;
  }
}

export function isLoopback(base: string): boolean {
  let host: string;
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost") return true;
  if (host === "[::1]" || host === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The Anthropic API address; tests may point it at a local server. */
export function anthropicBase(): string {
  const test = process.env.PHAETHON_ANTHROPIC_BASE_URL;
  if (test && process.env.PHAETHON_TEST === "1") return test.replace(/\/+$/, "");
  return preset("anthropic")!.base;
}

/** Where requests for `pre` go. Settings can only move presets whose address is editable. */
export function baseUrl(settings: VaultSettings, pre: Preset): string {
  if (pre.id === "anthropic") return anthropicBase();
  if (!pre.editableBase) return pre.base;
  const saved = stringMap(settings.providerUrls)[pre.id]?.trim();
  if (saved) {
    try {
      return checkBase(saved);
    } catch {
      throw new Refusal(`The address saved for ${pre.name} isn’t one Phaethon can use. Fix it in Settings › Assistant.`);
    }
  }
  if (pre.id === "custom") throw new Refusal("Add your server’s address in Settings › Assistant first.");
  return pre.base;
}

// ---------------------------------------------------------------------------
// Keys

/** Checked before a key is saved or sent; undefined when it's fine. */
export function keyProblem(pre: Preset, base: string, key: string): string | undefined {
  const k = key.trim();
  if (k.length < 8 || k.length > 400 || !/^[\x21-\x7e]+$/.test(k)) {
    return `That doesn’t look like a ${pre.name} API key. Copy the whole key again; it’s one line with no spaces.`;
  }
  const owner = PRESETS.find((o) => o.keyPrefix && k.startsWith(o.keyPrefix));
  if (owner && owner.id !== pre.id) {
    const sameServer = pre.id === "custom" && origin(base) !== undefined && origin(base) === origin(owner.base);
    if (!sameServer) {
      return `That looks like a key for ${owner.name}, not ${pre.name}, so it wasn’t sent anywhere. Choose ${owner.name} as the provider, or paste a ${pre.name} key.`;
    }
  }
  return undefined;
}

/** The keychain value for a custom server's key: bound to the origin it was saved for. */
export function bindCustomKey(base: string, key: string): string {
  const o = origin(base);
  if (!o) throw new Refusal("Add your server’s address first, then its key.");
  return JSON.stringify({ origin: o, key: key.trim() });
}

export function unbindCustomKey(saved: string, base: string): string {
  let v: { origin?: unknown; key?: unknown } | undefined;
  try {
    v = JSON.parse(saved);
  } catch {
    v = undefined;
  }
  if (!v || typeof v.origin !== "string" || typeof v.key !== "string") {
    throw new Refusal("The key saved for your own server can’t be read. Save it again in Settings › Assistant.");
  }
  if (v.origin !== origin(base)) {
    throw new Refusal(`The key for your own server was saved for ${v.origin}, and the address is now ${origin(base) ?? base}. Save the key again for the new address in Settings › Assistant.`);
  }
  return v.key;
}

/** The key to send to `pre` at `base`, read lazily; undefined for keyless servers. */
export function keyFor(pre: Preset, base: string, read: (id: string) => string | null): string | undefined {
  if (pre.key === "none") return undefined;
  const saved = read(pre.id);
  let key = saved ?? undefined;
  if (key !== undefined && pre.id === "custom") key = unbindCustomKey(key, base);
  if (key === undefined) {
    if (pre.key === "required") throw new Refusal(`Add your ${pre.name} API key in Settings to start.`);
    return undefined;
  }
  if (pre.id === "custom" && !base.startsWith("https://") && !isLoopback(base)) {
    throw new Refusal("Your server’s address starts with http://, so its key would travel unprotected. Use an https:// address, or remove the key.");
  }
  return key;
}
