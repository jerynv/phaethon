/**
 * Pure helpers for Settings › Assistant: model references, which providers
 * count as added, and the words for a key check. Unit-tested in logic.test.ts.
 */
import type { KeyProblem, ModelInfo, ProviderId, ProviderInfo, Settings } from "./api";

export const PROVIDER_IDS: readonly ProviderId[] = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "groq",
  "together",
  "mistral",
  "deepseek",
  "xai",
  "reallms",
  "ollama",
  "lmstudio",
  "custom",
];

/** The model Phaethon uses for Anthropic when none is chosen (the core's DEFAULT_MODEL). */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** A model name the core accepts for an OpenAI-compatible provider (`is_valid_compat_model`). */
export const COMPAT_MODEL = /^(?![-./:])(?!.*\.\.)[A-Za-z0-9._:/@+-]{1,200}$/;
/** An Anthropic model id the core accepts (`is_valid_model_id`). */
export const ANTHROPIC_MODEL = /^claude-[a-z0-9.-]{1,73}$/;

export function isValidModelFor(provider: ProviderId, model: string): boolean {
  return provider === "anthropic" ? ANTHROPIC_MODEL.test(model) : COMPAT_MODEL.test(model);
}

/** A reference as the core saves it: plain for Anthropic, "provider:model" otherwise. */
export const toRef = (provider: ProviderId, model: string) => (provider === "anthropic" ? model : `${provider}:${model}`);

/** A reference's provider and model. A head that isn't a provider id means the whole string is an Anthropic id. */
export function splitRef(ref: string): { provider: ProviderId; model: string } {
  const at = ref.indexOf(":");
  const head = at > 0 ? ref.slice(0, at) : "";
  if ((PROVIDER_IDS as readonly string[]).includes(head)) return { provider: head as ProviderId, model: ref.slice(at + 1) };
  return { provider: "anthropic", model: ref };
}

const titleWord = (w: string) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

/**
 * Turns common raw model slugs into friendly human names when a provider list
 * hasn't named them yet:
 * - "claude-opus-5-5" → "Claude Opus 5.5"
 * - "gemini-2.5-pro" → "Gemini 2.5 Pro"
 * - "gemini-2.5-flash-lite" → "Gemini 2.5 Flash-Lite"
 * - "gpt-4o-mini" → "GPT-4o Mini"
 * - "gpt-5" → "GPT-5"
 */
export function readableModel(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (claude) {
    return `Claude ${titleWord(claude[1])} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  // Strip trailing dated snapshots like -2025-05-06, -20250506, -05-06, -001, -latest, or -exp(-03-25)
  const trimmed = id.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|\d{2}-\d{2}|00\d|latest|exp(?:-\d{2}-\d{2})?)$/i, "");
  const gemini = /^gemini-(\d+(?:\.\d+)?)(?:-([a-z0-9-]+))?$/i.exec(trimmed);
  if (gemini) {
    const ver = gemini[1];
    const rest = gemini[2];
    if (!rest) return `Gemini ${ver}`;
    const tokens = rest.split("-").filter(Boolean);
    const words: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].toLowerCase() === "flash" && tokens[i + 1]?.toLowerCase() === "lite") {
        words.push("Flash-Lite");
        i++;
      } else {
        words.push(titleWord(tokens[i]));
      }
    }
    return `Gemini ${ver} ${words.join(" ")}`;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?[a-z]?)(?:-([a-z0-9-]+))?$/i.exec(trimmed);
  if (gpt) {
    const ver = gpt[1].replace(/[A-Z]/g, (c) => c.toLowerCase());
    const rest = gpt[2];
    if (!rest) return `GPT-${ver}`;
    const words = rest.split("-").filter(Boolean).map(titleWord);
    return `GPT-${ver} ${words.join(" ")}`;
  }
  const oSeries = /^(o\d+)(?:-(mini|pro|high|preview))$/i.exec(trimmed);
  if (oSeries) {
    return `${oSeries[1].toLowerCase()} ${titleWord(oSeries[2])}`;
  }
  return id;
}

/** The name a list gives a model (by id or alias), else a readable id. */
export function modelLabel(id: string, models: readonly ModelInfo[] | undefined): string {
  const found = models?.find((m) => m.id === id || m.aliases?.includes(id));
  return found?.name && found.name !== found.id ? found.name : readableModel(id);
}

/** The model chosen for a provider: Anthropic always has one. */
export function providerModel(p: ProviderInfo, settings: Pick<Settings, "model">): string | null {
  if (p.id === "anthropic") return p.model ?? settings.model ?? DEFAULT_ANTHROPIC_MODEL;
  return p.model;
}

/**
 * Whether a provider counts as added: a key saved, or (no key needed) a model
 * or an address of its own saved. Matches the old Settings rows.
 */
export function isAdded(p: ProviderInfo): boolean {
  if (p.hasKey) return true;
  if (p.key === "required") return false;
  return p.model !== null || (p.editableBase && !!p.baseUrl && p.baseUrl !== p.defaultBaseUrl);
}

/** The added providers, the default first, then in preset order. */
export function addedProviders(settings: Settings): ProviderInfo[] {
  const added = settings.providers.filter((p) => isAdded(p));
  return added.sort((a, b) => Number(b.id === settings.provider) - Number(a.id === settings.provider));
}

/** What a provider still needs before it can answer, or null when it's ready. */
export type Need = { field: "key" | "url" | "model"; text: string } | null;
export function providerNeed(p: ProviderInfo, settings: Pick<Settings, "model">, now = Date.now()): Need {
  if (p.editableBase && !p.baseUrl) return { field: "url", text: "Add the server’s address." };
  if (p.key === "required" && !p.hasKey) return { field: "key", text: `Add your ${p.name} API key.` };
  if (p.hasKey && p.keyExpiresAt != null && p.keyExpiresAt <= now) return { field: "key", text: `Your ${p.name} key has expired. Paste a new one.` };
  if (!providerModel(p, settings)) return { field: "model", text: "Choose a model." };
  return null;
}

/** How a saved key that expires (a sign-in token) reads beside it; null for keys that don't expire. */
export function keyExpiry(expiresAt: number | null | undefined, now = Date.now()): { tone: "ready" | "warning" | "error"; text: string } | null {
  if (expiresAt == null) return null;
  const ms = expiresAt - now;
  if (ms <= 0) return { tone: "error", text: "Expired" };
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return { tone: "warning", text: "Expires within the hour" };
  if (hours < 24) return { tone: "warning", text: `Expires in ${hours} hour${hours === 1 ? "" : "s"}` };
  const days = Math.floor(hours / 24);
  return { tone: "ready", text: `Expires in ${days} day${days === 1 ? "" : "s"}` };
}

/** The result of Check and save. */
export type KeyOutcome =
  | { kind: "saved" }
  /** Saved: the key is real, but the account needs credit before it can answer. */
  | { kind: "no-credit" }
  | { kind: "problem"; problem: KeyProblem | "empty" | "unchecked" | "not-saved"; detail?: string };

export const isSaved = (o: KeyOutcome | null) => o?.kind === "saved" || o?.kind === "no-credit";
/** Problems a person can get past by saving without the check. */
export const canSaveUnchecked = (o: KeyOutcome | null) => o?.kind === "problem" && (o.problem === "network" || o.problem === "unchecked");

/** One or two short sentences for an outcome, the way out last. */
export function outcomeText(o: KeyOutcome, provider: Pick<ProviderInfo, "id" | "name" | "keyPrefix">): string {
  const name = provider.id === "custom" ? "your server" : provider.name;
  if (o.kind === "saved") return "Key saved.";
  if (o.kind === "no-credit") return `Key saved. Add ${provider.name} credit before it can answer.`;
  switch (o.problem) {
    case "empty":
      return provider.keyPrefix ? `Paste your key first. It starts with ${provider.keyPrefix}` : "Paste your key first.";
    case "format":
    case "rejected":
      if (provider.id === "anthropic")
        return o.problem === "format" ? "That isn’t an Anthropic key. They start with sk-ant-. It wasn’t saved." : "Anthropic didn’t accept this key. It wasn’t saved.";
      return `${o.detail ?? `${provider.name} didn’t accept this key.`} It wasn’t saved.`;
    case "network":
      return `Couldn’t reach ${name} to check the key. Try again, or save it without checking.`;
    case "unchecked":
      return "Couldn’t check this key. Try again, or save it without checking.";
    case "billing":
      return `Add ${provider.name} credit to continue.`;
    case "not-saved":
      return `The key wasn’t saved.${o.detail ? ` ${o.detail}` : ""}`;
  }
}

/**
 * Check a key, then save it if it works. A real key on an account without
 * credit is saved too, so it needn't be pasted again after adding credit.
 */
export async function checkAndSave(
  raw: string,
  provider: ProviderId,
  calls: { check: (p: ProviderId, key: string) => Promise<{ ok: boolean; problem?: KeyProblem; message: string }>; save: (p: ProviderId, key: string) => Promise<void> },
  skipCheck = false,
): Promise<KeyOutcome> {
  const key = raw.trim();
  if (!key) return { kind: "problem", problem: "empty" };
  let noCredit = false;
  if (!skipCheck) {
    try {
      const r = await calls.check(provider, key);
      if (!r.ok) {
        if (r.problem === "billing") noCredit = true;
        else return { kind: "problem", problem: r.problem ?? "rejected", detail: r.message };
      }
    } catch (e) {
      return { kind: "problem", problem: "unchecked", detail: String(e) };
    }
  }
  try {
    await calls.save(provider, key);
  } catch (e) {
    return { kind: "problem", problem: "not-saved", detail: typeof e === "string" ? e : String(e) };
  }
  return noCredit ? { kind: "no-credit" } : { kind: "saved" };
}

/** Filter models by every word of a query, in id or name. */
export function matchModels<T extends { id: string; name: string }>(models: readonly T[], query: string): T[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...models];
  return models.filter((m) => words.every((w) => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w)));
}
