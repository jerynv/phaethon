import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Backend` in src-tauri/src/vault.rs. */
export type Backend = "steward" | "claude-cli";

/** Mirrors `SettingsView` in src-tauri/src/lib.rs. The key itself never comes back. */
export type Settings = { backend: Backend; hasAnthropicKey: boolean; model: string };

/** Mirrors `UiMessage` in src-tauri/src/thread.rs. */
export type SavedMessage = { role: "user" | "assistant"; text: string };

export const getSettings = () => invoke<Settings>("settings_get");
export const setBackend = (backend: Backend) => invoke<void>("settings_set_backend", { backend });
export const setApiKey = (key: string) => invoke<void>("api_key_set", { provider: "anthropic", key });
export const clearApiKey = () => invoke<void>("api_key_clear", { provider: "anthropic" });
export const loadThread = (space: string) => invoke<SavedMessage[]>("thread_load", { space });
