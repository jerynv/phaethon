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
 * from an older core. `at` (when it was sent, or a reply finished, in ms since
 * the epoch) is missing for messages saved before times were kept.
 */
export type SavedMessage = {
  role: "user" | "assistant";
  text: string;
  attachments: SavedAttachment[];
  index?: number;
  records?: ThreadRecord[];
  at?: number;
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

/** Mirrors `ClearOutcome` in src-tauri/src/memory.rs. "notKept": nothing was changed. */
export type ClearOutcome = { status: "cleared"; kept: string[] } | { status: "notKept"; reason: string };
/**
 * Clear a conversation ("current" or a saved id): the model picks out its key details, which are
 * kept in the space's MEMORY.md, then its messages are removed. Refused while a reply runs.
 */
export const clearThread = (space: string, id: string) => invoke<ClearOutcome>("thread_clear", { space, id });
/** Mirrors `ForgetPreview` in src-tauri/src/memory.rs. */
export type ForgetPreview = { files: number; sharedFiles: number; facts: number };
/** What deleting a conversation with everything would remove, asked before the confirm. */
export const previewForget = (space: string, id: string) => invoke<ForgetPreview>("thread_forget_preview", { space, id });
/** Mirrors `Forgotten` in src-tauri/src/memory.rs. */
export type Forgotten = { files: number; filesLeft: number; facts: number };
/** Delete a conversation, the files only it uses and what was kept from it. Refused while a reply runs. */
export const forgetThread = (space: string, id: string) => invoke<Forgotten>("thread_forget", { space, id });
/** The space's memory file, relative to the space (file_open can open it). */
export const MEMORY_FILE = "MEMORY.md";
/** Mirrors `Snippet` in src-tauri/src/search.rs: a match in its context (plain text; the UI marks `matched`). */
export type SearchSnippet = { message: number; role: "user" | "assistant"; before: string; matched: string; after: string };
/** Mirrors `Conversation` in src-tauri/src/search.rs. `threadId` is what openThread takes. */
export type SearchConversation = {
  space: string;
  threadId: string;
  title: string;
  updated: number;
  current: boolean;
  matches: number;
  snippets: SearchSnippet[];
};
export type SearchResults = { conversations: SearchConversation[]; truncated: boolean };
/** Search the saved conversations in `space`, or in every space. Refused with the Claude Code backend. */
export const searchConversations = (space: string, query: string, allSpaces: boolean) =>
  invoke<SearchResults>("conversations_search", { space, query, allSpaces });
