import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Backend` in src-tauri/src/vault.rs. */
export type Backend = "steward" | "claude-cli";

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

/** Mirrors `UiMessage` in src-tauri/src/thread.rs. */
export type SavedMessage = { role: "user" | "assistant"; text: string; attachments: SavedAttachment[] };

/** Mirrors `UiAttachment` in src-tauri/src/thread.rs. `path` is relative to the space. */
export type SavedAttachment = { name: string; path: string; mediaType: string };

export const getSettings = () => invoke<Settings>("settings_get");
export const setBackend = (backend: Backend) => invoke<void>("settings_set_backend", { backend });
export const setApiKey = (key: string) => invoke<void>("api_key_set", { provider: "anthropic", key });
export const clearApiKey = () => invoke<void>("api_key_clear", { provider: "anthropic" });
/** Replaces the vault's saved appearance. Pass only a validated object (src/theme). */
export const saveAppearance = (appearance: unknown) => invoke<void>("appearance_set", { appearance });
export const loadThread = (space: string) => invoke<SavedMessage[]>("thread_load", { space });
