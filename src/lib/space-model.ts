import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { readableModel } from "@/components/settings/api-key";

import {
  CLI_INFO,
  getSettings,
  listCliModels,
  listModels,
  SETTINGS_CHANGED_EVENT,
  type Backend,
  type CliModelInfo,
  type ModelInfo,
  type ProviderId,
  type ProviderInfo,
  type SettingsChangedDetail,
} from "./backend";
import { inTauri } from "./tauri";

/**
 * Which model answers in each space. A space may choose its own (saved in its
 * space.json, so it syncs with the space; src-tauri/src/space_model.rs);
 * every other space uses the default model from Settings. Only Phaethon's own
 * agent uses either. With a CLI answering (Claude Code, Codex, Gemini CLI),
 * `own` holds each space's model for that CLI instead ("codex:gpt-5.5"), and a
 * space without one uses the CLI's own default; `cliModels` is what each CLI
 * itself says it offers (agent/models.rs), asked once and on Refresh.
 *
 * A model is named by a reference, as the core saves it (providers.rs): a
 * plain id is an Anthropic model ("claude-opus-5-5"), any other provider's is
 * "provider:model" ("openrouter:openai/gpt-5").
 */
export type ModelsState = {
  status: "loading" | "ready" | "error";
  backend: Backend;
  /** The default model's reference (Settings › Assistant); "" while the chosen provider has none picked. */
  defaultModel: string;
  /** The provider Phaethon's own agent uses by default. */
  provider: ProviderId;
  /** Every provider as Settings knows it; empty from an older core (Anthropic only). */
  providers: readonly ProviderInfo[];
  /** Space id → the model that space chose. Spaces using the default are absent. */
  own: Readonly<Record<string, string>>;
  /** Anthropic's models to choose from; the fixed list until Anthropic's own has loaded. */
  models: readonly ModelInfo[];
  /** Names learned from other providers' lists, by reference. */
  names: Readonly<Record<string, string>>;
  /** Each CLI's own list, once asked: loading, or its models and (when it can't list them) a note. */
  cliModels: Readonly<Partial<Record<CliId, CliModelsState>>>;
};

export type CliId = "claude" | "codex" | "gemini";
export type CliModelsState = { status: "loading" | "ready" | "error"; models: readonly CliModelInfo[]; note?: string };

/** Mirrors the presets' names in src-tauri/src/providers.rs. */
export const PROVIDER_NAMES: Readonly<Record<ProviderId, string>> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  groq: "Groq",
  together: "Together AI",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  xai: "xAI",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "Your own server",
};

const FALLBACK: readonly ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

let state: ModelsState = {
  status: inTauri() ? "loading" : "ready",
  backend: "phaethon",
  defaultModel: FALLBACK[0].id,
  provider: "anthropic",
  providers: [],
  own: {},
  models: FALLBACK,
  names: {},
  cliModels: {},
};
const listeners = new Set<() => void>();
let modelsAsked = false;
const namesAsked = new Set<ProviderId>();

function set(patch: Partial<ModelsState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

/** A reference's provider and model id. */
export function splitRef(ref: string): { provider: ProviderId; model: string } {
  const at = ref.indexOf(":");
  const head = at > 0 ? ref.slice(0, at) : "";
  if (head && head in PROVIDER_NAMES) return { provider: head as ProviderId, model: ref.slice(at + 1) };
  return { provider: "anthropic", model: ref };
}

/**
 * A CLI's model as the core writes it ("codex:gpt-5.5", "gemini:pro",
 * "claude:opus"; space_model.rs), or null.
 */
export function splitCliRef(ref: string): { backend: "claude-cli" | "codex-cli" | "gemini-cli"; name: string; model: string } | null {
  const m = /^(claude|codex|gemini):(.+)$/.exec(ref);
  if (!m) return null;
  const backend = `${m[1]}-cli` as "claude-cli" | "codex-cli" | "gemini-cli";
  return { backend, name: CLI_INFO[backend].name, model: m[2] };
}

/**
 * Ask `cli` which models it offers (a listing only, never a model turn): once,
 * or again with `force` (Settings opening, the menu's Refresh). A list already
 * shown stays while a new one loads.
 */
export async function loadCliModels(cli: CliId, force = false): Promise<CliModelsState | undefined> {
  const had = state.cliModels[cli];
  if (had && (had.status === "loading" || (!force && had.status === "ready"))) return had;
  if (!inTauri()) return undefined;
  set({ cliModels: { ...state.cliModels, [cli]: { status: "loading", models: had?.models ?? [], note: had?.note } } });
  try {
    const out = await listCliModels(cli);
    set({ cliModels: { ...state.cliModels, [cli]: { status: "ready", models: out.models, note: out.note } } });
  } catch (e) {
    set({ cliModels: { ...state.cliModels, [cli]: { status: "error", models: had?.models ?? [], note: `Phaethon couldn’t ask for the list: ${String(e)}` } } });
  }
  return state.cliModels[cli];
}

/** The name a CLI gives one of its models ("GPT-6.1-Sol"), or the id while unknown. */
export function cliModelName(cli: CliId, model: string, s: ModelsState = state): string {
  return s.cliModels[cli]?.models.find((m) => m.id === model)?.name ?? model;
}

/** The reference for `model` of `provider`, as the core saves it. */
export const toRef = (provider: ProviderId, model: string) => (provider === "anthropic" ? model : `${provider}:${model}`);

/** Names from a provider's list, so its models read as people know them. */
export function rememberNames(provider: ProviderId, models: readonly ModelInfo[]) {
  if (provider === "anthropic") return;
  const names = { ...state.names };
  let changed = false;
  for (const m of models) {
    const ref = toRef(provider, m.id);
    if (m.name && m.name !== m.id && names[ref] !== m.name) {
      names[ref] = m.name;
      changed = true;
    }
  }
  if (changed) set({ names });
}

/** Read the backend, the default and every space's own model again. */
export async function refreshModels(): Promise<void> {
  if (!inTauri()) return;
  try {
    const [settings, own] = await Promise.all([getSettings(), invoke<Record<string, string>>("space_models_list")]);
    set({
      status: "ready",
      backend: settings.backend,
      defaultModel: settings.defaultModel === undefined ? settings.model : (settings.defaultModel ?? ""),
      provider: settings.provider ?? "anthropic",
      providers: settings.providers ?? [],
      own,
    });
  } catch {
    set({ status: state.status === "ready" ? "ready" : "error" });
  }
  // The answering CLI's own list, once per launch (Settings and the menu's Refresh ask again).
  if (state.backend !== "phaethon" && state.backend in CLI_INFO) void loadCliModels(CLI_INFO[state.backend as keyof typeof CLI_INFO].id);
  // Other providers' lists for the names of the models in use, once per launch each; their ids stand in until then.
  for (const ref of [state.defaultModel, ...Object.values(state.own)]) {
    const p = splitRef(ref).provider;
    if (p === "anthropic" || namesAsked.has(p) || !state.providers.find((x) => x.id === p)?.ready) continue;
    namesAsked.add(p);
    listModels(p).then(
      (models) => rememberNames(p, models),
      () => {},
    );
  }
  // The provider's list once per launch (it is a network call); the fixed list stands in until then.
  if (!modelsAsked) {
    modelsAsked = true;
    listModels().then(
      (models) => models.length && set({ models }),
      () => {},
    );
  }
}

/** The provider's name for people ("OpenRouter"). */
export function providerName(id: ProviderId, s: ModelsState = state): string {
  return s.providers.find((p) => p.id === id)?.name ?? PROVIDER_NAMES[id];
}

/**
 * The model's name for people: "Claude Sonnet 5.5" for Anthropic's, and
 * "OpenRouter · GPT-5" for another provider's. "" is "no model chosen yet".
 */
export function modelName(ref: string, models: readonly ModelInfo[] = state.models): string {
  if (!ref) return "No model chosen";
  const cli = splitCliRef(ref);
  if (cli) return `${cli.name} · ${cliModelName(CLI_INFO[cli.backend].id, cli.model)}`;
  const { provider, model } = splitRef(ref);
  if (provider === "anthropic") return models.find((m) => m.id === model)?.name ?? readableModel(model);
  return `${providerName(provider)} · ${state.names[ref] ?? model}`;
}

/** The model a space answers with, and whether it is the space's own choice. */
export function modelOf(s: ModelsState, spaceId: string): { id: string; own: boolean } {
  const own = s.own[spaceId];
  return own ? { id: own, own: true } : { id: s.defaultModel, own: false };
}

/** One provider's models to choose from, as references. */
export type ModelGroup = { provider: ProviderId; name: string; models: ModelInfo[] };

/**
 * The choices, by provider: Anthropic's list, and for each other provider that
 * can answer (a key saved, or a server on this computer that is in use or
 * chosen) its model from Settings and the ones spaces use. A model in use is
 * always listed, so a choice never disappears.
 */
export function modelGroups(s: ModelsState): ModelGroup[] {
  const inUse = [s.defaultModel, ...Object.values(s.own)].filter(Boolean);
  const used = (p: ProviderId) => inUse.filter((r) => splitRef(r).provider === p);
  const groups: ModelGroup[] = [];
  const anthropic = s.providers.find((p) => p.id === "anthropic");
  if (!s.providers.length || s.provider === "anthropic" || anthropic?.hasKey || used("anthropic").length) {
    const list = [...s.models];
    for (const id of used("anthropic")) if (!list.some((m) => m.id === id)) list.push({ id, name: modelName(id, s.models) });
    groups.push({ provider: "anthropic", name: "Anthropic", models: list });
  }
  for (const p of s.providers) {
    if (p.id === "anthropic") continue;
    const wanted = p.local ? p.id === s.provider || !!p.model || used(p.id).length > 0 : p.ready;
    if (!wanted && !used(p.id).length) continue;
    const refs = [...(p.model ? [toRef(p.id, p.model)] : []), ...used(p.id)];
    const unique = [...new Set(refs)];
    if (!unique.length) continue;
    groups.push({ provider: p.id, name: p.name, models: unique.map((id) => ({ id, name: state.names[id] ?? splitRef(id).model })) });
  }
  return groups;
}

/** Every choice in one list (see [`modelGroups`]). */
export function modelChoices(s: ModelsState): ModelInfo[] {
  return modelGroups(s).flatMap((g) => g.models.map((m) => (g.provider === "anthropic" ? m : { id: m.id, name: modelName(m.id) })));
}

/** The providers a space can pick another model from: the ones that can answer. */
export const choosableProviders = (s: ModelsState) => s.providers.filter((p) => p.ready);

/**
 * Give `spaceId` its own model, or with `null` put it back on the default.
 * Takes effect from the next message in that space; a reply already running
 * keeps the model it started with.
 */
export async function setSpaceModel(spaceId: string, model: string | null): Promise<void> {
  if (inTauri()) await invoke<void>("space_model_set", { space: spaceId, model });
  const own = { ...state.own };
  if (model) own[spaceId] = model;
  else delete own[spaceId];
  set({ own });
}

/** What was done, in words: "Work now uses Claude Opus 5.5." */
export function changedText(spaceName: string, model: string | null, s: ModelsState = state): string {
  return model
    ? `${spaceName} now uses ${modelName(model, s.models)}.`
    : `${spaceName} now uses the default model, ${modelName(s.defaultModel, s.models)}.`;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

let watching = 0;
function onChanged(e: Event) {
  // A new key may see more models.
  if ((e as CustomEvent<SettingsChangedDetail>).detail?.what === "key") {
    modelsAsked = false;
    namesAsked.clear();
  }
  void refreshModels();
}

/**
 * The models state, kept fresh: read on first use, again when the backend,
 * the key or the default model changes anywhere, and when the window regains
 * focus (a synced or hand-edited space.json may have changed a space's model).
 */
export function useModels(): ModelsState {
  useEffect(() => {
    if (!inTauri()) return;
    if (watching++ === 0) {
      void refreshModels();
      window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
      window.addEventListener("focus", onChanged);
    }
    return () => {
      if (--watching > 0) return;
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
      window.removeEventListener("focus", onChanged);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => state);
}
