/**
 * Typed calls for Settings › Assistant. Names, arguments and shapes are the
 * core's (the old Tauri commands, see research core-head §1.4). A key goes to
 * the core and never comes back: the renderer only learns `hasKey`.
 */
import { invoke } from "@/lib/core";

export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";
export type CliId = "claude" | "codex" | "gemini";
export const isCliBackend = (b: Backend | null | undefined): b is Exclude<Backend, "phaethon"> => !!b && b !== "phaethon";
export const cliOfBackend = (b: Backend): CliId | null => (isCliBackend(b) ? (b.slice(0, -4) as CliId) : null);

export type ProviderId =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "groq"
  | "together"
  | "mistral"
  | "deepseek"
  | "xai"
  | "ollama"
  | "lmstudio"
  | "custom";

/** `ProviderView` from the core. `model` is the model chosen for this provider (always one for Anthropic). */
export type ProviderInfo = {
  id: ProviderId;
  name: string;
  key: "required" | "optional" | "none";
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

/** `SettingsView` from the core. */
export type Settings = {
  backend: Backend;
  hasAnthropicKey: boolean;
  model: string;
  provider: ProviderId;
  /** The vault default as a reference ("provider:model", plain for Anthropic); null while none is chosen. */
  defaultModel: string | null;
  providerReady: boolean;
  providers: ProviderInfo[];
  appearance: unknown;
  vaultPath: string;
  version: string;
};

export type ModelInfo = {
  id: string;
  name: string;
  sees?: "yes" | "no" | "unknown";
  description?: string;
  aliases?: string[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};
export type KeyProblem = "format" | "rejected" | "network" | "billing";
export type KeyCheck = { ok: boolean; problem?: KeyProblem; message: string };
export type ServerStatus = { running: boolean; models: ModelInfo[]; message: string };
export type SpaceView = { id: string; name: string; description: string; hue: number; educationEnabled: boolean; lastUsed: number | null };

/**
 * Fired on window after a change to the backend, a key, a provider or a model
 * is saved, wherever it was made. Other features (the chat model picker) read
 * the settings again when they hear it. Same name as before the rewrite.
 */
export const SETTINGS_CHANGED_EVENT = "phaethon:settings-changed";
export type SettingsChangedDetail = { what: "backend" | "key" | "model" | "provider" };

function announce<T>(what: SettingsChangedDetail["what"], p: Promise<T>): Promise<T> {
  return p.then((v) => {
    window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail: { what } }));
    return v;
  });
}

export const getSettings = () => invoke<Settings>("settings_get");
export const setBackend = (backend: Backend) => announce("backend", invoke<void>("settings_set_backend", { backend }));
export const setProvider = (provider: ProviderId) => announce("provider", invoke<void>("settings_set_provider", { provider }));
/** The Anthropic model; null goes back to the recommended one. */
export const setAnthropicModel = (model: string | null) => announce("model", invoke<void>("settings_set_model", { model }));
/** Another provider's model; null clears it. */
export const setProviderModel = (provider: ProviderId, model: string | null) =>
  announce("model", invoke<void>("settings_set_provider_model", { provider, model }));
/** A server's address (editable presets only); null goes back to the usual one. */
export const setProviderUrl = (provider: ProviderId, url: string | null) =>
  announce("provider", invoke<void>("settings_set_provider_url", { provider, url }));
export const setApiKey = (provider: ProviderId, key: string) => announce("key", invoke<void>("api_key_set", { provider, key }));
export const clearApiKey = (provider: ProviderId) => announce("key", invoke<void>("api_key_clear", { provider }));
/** Checks a key with one cheap request to that provider only, without saving it. */
export const checkApiKey = (provider: ProviderId, key: string) =>
  invoke<KeyCheck>("api_key_check", provider === "anthropic" ? { key } : { key, provider });
export const listModels = (provider: ProviderId) => invoke<ModelInfo[]>("models_list", provider === "anthropic" ? {} : { provider });
export const providerStatus = (provider: ProviderId) => invoke<ServerStatus>("provider_status", { provider });

export const listSpaces = () => invoke<SpaceView[]>("spaces_list");
/** Space id → its own model reference, for the backend that answers now. */
export const listSpaceModels = () => invoke<Record<string, string>>("space_models_list");
/** Give a space its own model ("provider:model", or "codex:x" for a CLI); null puts it back on the default. */
export const setSpaceModel = (space: string, model: string | null) =>
  announce("model", invoke<void>("space_model_set", { space, model }));
