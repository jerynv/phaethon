import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Backend` in src-tauri/src/vault.rs. */
export type Backend = "phaethon" | "claude-cli";

/**
 * Mirrors `SettingsView` in src-tauri/src/lib.rs. The key itself never comes back.
 * `appearance` is whatever passed the core's shape check (`{}` when none is
 * saved); src/theme/tokens.ts validates it again before anything is applied.
 * `vaultPath` and `version` may be missing from an older core.
 */
export type Settings = {
  backend: Backend;
  hasAnthropicKey: boolean;
  model: string;
  appearance?: unknown;
  vaultPath?: string;
  version?: string;
};

/**
 * Something saved in the conversation record beside the text. Never sent to
 * the model.
 */
export type ThreadRecord =
  | { kind: "approval"; path: string; action: "create" | "replace"; allowed: boolean }
  | { kind: "access"; space: string; path: string; answer: "once" | "always" | "deny" }
  | { kind: "read"; space: string; path: string; tool: "read" | "list" | "search"; query?: string }
  | { kind: "stopped" };

/**
 * Mirrors `UiMessage` in src-tauri/src/thread.rs. `index` (where the message
 * starts in thread.json, for edit and regenerate) and `records` may be missing
 * from an older core.
 */
export type SavedMessage = {
  role: "user" | "assistant";
  text: string;
  attachments: SavedAttachment[];
  index?: number;
  records?: ThreadRecord[];
};

/** Mirrors `UiAttachment` in src-tauri/src/thread.rs. `path` is relative to the space. */
export type SavedAttachment = { name: string; path: string; mediaType: string };

/**
 * Fired on window once a change to the backend, the key or the model is saved,
 * wherever it was made (Settings, the first-run card). The detail says which;
 * a listener reads the settings again if it needs the new values. Only a
 * backend change alters which conversation a space shows.
 */
export const SETTINGS_CHANGED_EVENT = "phaethon:settings-changed";
export type SettingsChangedDetail = { what: "backend" | "key" | "model" };

function announce<T>(what: SettingsChangedDetail["what"], p: Promise<T>): Promise<T> {
  return p.then((v) => {
    window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail: { what } }));
    return v;
  });
}

export const getSettings = () => invoke<Settings>("settings_get");
export const setBackend = (backend: Backend) => announce("backend", invoke<void>("settings_set_backend", { backend }));
export const setApiKey = (key: string) => announce("key", invoke<void>("api_key_set", { provider: "anthropic", key }));
export const clearApiKey = () => announce("key", invoke<void>("api_key_clear", { provider: "anthropic" }));

/** Why a key failed its check. "billing": the key is real but the account has no credit. */
export type KeyProblem = "format" | "rejected" | "network" | "billing";
export type KeyCheck = { ok: boolean; problem?: KeyProblem; message: string };
/** Checks a key (its shape, then a small real call) without saving it. */
export const checkApiKey = (key: string) => invoke<KeyCheck>("api_key_check", { key });

/** A model Phaethon's own agent can use. `name` is for people ("Claude Opus 5.5"). */
export type ModelInfo = { id: string; name: string };
/** From the provider when a key works; a fixed list otherwise. */
export const listModels = () => invoke<ModelInfo[]>("models_list");
/** `null` goes back to the default model. */
export const setModel = (model: string | null) => announce("model", invoke<void>("settings_set_model", { model }));

/** Open a file in a space with its default app, or show it in Finder (`reveal`). `path` is relative to the space. */
export const openFile = (space: string, path: string, reveal = false) => invoke<void>("file_open", { space, path, reveal });
/** Replaces the vault's saved appearance. Pass only a validated object (src/theme). */
export const saveAppearance = (appearance: unknown) => invoke<void>("appearance_set", { appearance });
export const loadThread = (space: string) => invoke<SavedMessage[]>("thread_load", { space });

/** Mirrors `ThreadSummary` in src-tauri/src/thread.rs. `updated` is milliseconds since the epoch. */
export type ThreadSummary = { id: string; title: string; updated: number; messages: number; current: boolean };

/** Keep the current conversation in the space's archive and start an empty one. Refused while a reply runs. */
export const newThread = (space: string) => invoke<void>("thread_new", { space });
/** The space's conversations, the current one first. Empty with the Claude Code backend. */
export const listThreads = (space: string) => invoke<ThreadSummary[]>("threads_list", { space });
/** Make a saved conversation the current one. Refused while a reply runs. */
export const openThread = (space: string, id: string) => invoke<void>("thread_open", { space, id });
