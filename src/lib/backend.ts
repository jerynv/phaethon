import { invoke } from "@tauri-apps/api/core";

/** Mirrors `Backend` in src-tauri/src/vault.rs. */
export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";

/** A backend that is someone else's CLI (src-tauri/src/agent.rs), not Phaethon's own agent. */
export type CliBackend = Exclude<Backend, "phaethon">;
export const isCliBackend = (b: Backend | undefined | null): b is CliBackend => !!b && b !== "phaethon";

/** Each CLI backend's name for people, its command, and how its sign-in is done. */
export const CLI_INFO: Readonly<
  Record<CliBackend, { id: "claude" | "codex" | "gemini"; name: string; command: string; login: string; company: string; account: string; installUrl: string; folder: string }>
> = {
  "claude-cli": {
    id: "claude",
    name: "Claude Code",
    command: "claude",
    login: "claude",
    company: "Anthropic",
    account: "your own Claude account",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    folder: ".claude",
  },
  "codex-cli": {
    id: "codex",
    name: "Codex",
    command: "codex",
    login: "codex login",
    company: "OpenAI",
    account: "your own ChatGPT or OpenAI account",
    installUrl: "https://developers.openai.com/codex/cli",
    folder: ".codex",
  },
  "gemini-cli": {
    id: "gemini",
    name: "Gemini CLI",
    command: "gemini",
    login: "gemini",
    company: "Google",
    account: "your own Google account",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    folder: ".gemini",
  },
};

/** The CLI that answers, or null for Phaethon's own agent. */
export const cliOf = (b: Backend | undefined | null) => (isCliBackend(b) ? (CLI_INFO[b] ?? null) : null);

/** Mirrors `CliInfo` in src-tauri/src/agent.rs. `loggedIn` is null when the CLI can't say without a real question. */
export type AgentCliStatus = {
  id: "claude" | "codex" | "gemini" | "opencode";
  name: string;
  installed: boolean;
  loggedIn: boolean | null;
  loginCommand: string;
  supported: boolean;
  /**
   * Runs with a setup (home) of its own for this vault, never the person's, and is signed in to
   * from Settings (`signInCli`): Codex and Gemini CLI. Missing from an older core.
   */
  ownHome?: boolean;
};
/** Which CLIs are on this computer, and (Codex) whether signed in, from the CLI's own status command. */
export const agentClis = () => invoke<AgentCliStatus[]>("agent_clis_status");

/** Mirrors `SignInOutcome` in src-tauri/src/agent/sign_in.rs. `message` is plain words for the person. */
export type CliSignIn = {
  status: "signedIn" | "notSignedIn" | "cancelled" | "busy" | "missing";
  message: string;
};
/**
 * Sign in to Codex or Gemini CLI for this vault's own setup, with the CLI's own sign-in (it opens the
 * browser itself). Resolves when the person finishes there, or `cancelCliSignIn`.
 */
export const signInCli = (cli: "codex" | "gemini") => invoke<CliSignIn>("agent_cli_sign_in", { cli });
/** One model a CLI offers. Mirrors `CliModel` in src-tauri/src/agent/models.rs. */
export type CliModelInfo = { id: string; name: string; description?: string };
/** A CLI's models, from the CLI itself; `note` says in words when it can't list them (or couldn't now). */
export type CliModelList = { models: CliModelInfo[]; note?: string };
/** The models `cli` offers, asked of the CLI itself (listing only). */
export const listCliModels = (cli: "claude" | "codex" | "gemini") => invoke<CliModelList>("agent_cli_models", { cli });

/** Stop a sign-in that waits for the browser; false if none was waiting. */
export const cancelCliSignIn = (cli: "codex" | "gemini") => invoke<boolean>("agent_cli_sign_in_cancel", { cli });

/**
 * Mirrors `SettingsView` in src-tauri/src/lib.rs. The key itself never comes back.
 * `appearance` is whatever passed the core's shape check (`{}` when none is
 * saved); src/theme/tokens.ts validates it again before anything is applied.
 * `vaultPath` and `version` may be missing from an older core.
 */
export type Settings = {
  backend: Backend;
  hasAnthropicKey: boolean;
  /** The Anthropic model chosen in Settings. */
  model: string;
  /** The provider Phaethon's own agent uses (Anthropic when missing, from an older core). */
  provider?: ProviderId;
  /** The default model as a reference ("provider:model", plain for Anthropic); null while none is chosen. */
  defaultModel?: string | null;
  /** Whether the chosen provider can answer: a key saved where one is needed, and a model. */
  providerReady?: boolean;
  /** Every provider, with whether a key is saved; never the key. */
  providers?: ProviderInfo[];
  appearance?: unknown;
  vaultPath?: string;
  version?: string;
};

/** Mirrors the presets in src-tauri/src/providers.rs. */
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

/** Mirrors `ProviderView` in src-tauri/src/providers.rs. */
export type ProviderInfo = {
  id: ProviderId;
  name: string;
  key: "required" | "optional" | "none";
  local: boolean;
  editableBase: boolean;
  hasKey: boolean;
  /** Where requests go ("" while a server of one's own has no address yet). */
  baseUrl: string;
  defaultBaseUrl: string;
  /** The model chosen for it in Settings; for Anthropic always one. */
  model: string | null;
  keysUrl: string;
  keyPrefix: string;
  ready: boolean;
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
export type SettingsChangedDetail = { what: "backend" | "key" | "model" | "provider" };

function announce<T>(what: SettingsChangedDetail["what"], p: Promise<T>): Promise<T> {
  return p.then((v) => {
    window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail: { what } }));
    return v;
  });
}

export const getSettings = () => invoke<Settings>("settings_get");
export const setBackend = (backend: Backend) => announce("backend", invoke<void>("settings_set_backend", { backend }));
export const setApiKey = (key: string, provider: ProviderId = "anthropic") => announce("key", invoke<void>("api_key_set", { provider, key }));
export const clearApiKey = (provider: ProviderId = "anthropic") => announce("key", invoke<void>("api_key_clear", { provider }));

/** Why a key failed its check. "billing": the key is real but the account has no credit. */
export type KeyProblem = "format" | "rejected" | "network" | "billing";
export type KeyCheck = { ok: boolean; problem?: KeyProblem; message: string };
/** Checks a key (its shape, then a small real call to that provider only) without saving it. */
export const checkApiKey = (key: string, provider: ProviderId = "anthropic") =>
  invoke<KeyCheck>("api_key_check", provider === "anthropic" ? { key } : { key, provider });

/** A model Phaethon's own agent can use. `name` is for people ("Claude Opus 5.5"). */
/** `sees`: whether it reads pictures, where the provider's list says (src-tauri/src/vision.rs). */
export type ModelInfo = { id: string; name: string; sees?: "yes" | "no" | "unknown" };
/**
 * Anthropic's: from Anthropic when a key works, a fixed list otherwise. Any
 * other provider's: its own list, or an error in words (a model can still be typed).
 */
export const listModels = (provider: ProviderId = "anthropic") =>
  invoke<ModelInfo[]>("models_list", provider === "anthropic" ? {} : { provider });
/** The Anthropic model; `null` goes back to the default model. */
export const setModel = (model: string | null) => announce("model", invoke<void>("settings_set_model", { model }));
/** Which provider Phaethon's own agent uses. */
export const setProvider = (provider: ProviderId) => announce("provider", invoke<void>("settings_set_provider", { provider }));
/** The model `provider` (not Anthropic) answers with by default; `null` clears it. */
export const setProviderModel = (provider: ProviderId, model: string | null) =>
  announce("model", invoke<void>("settings_set_provider_model", { provider, model }));
/** The address of a server on this computer or one's own; `null` goes back to the usual one. */
export const setProviderUrl = (provider: ProviderId, url: string | null) =>
  announce("provider", invoke<void>("settings_set_provider_url", { provider, url }));
/** Mirrors `ServerStatus` in src-tauri/src/openai.rs. */
export type ServerStatus = { running: boolean; models: ModelInfo[]; message: string };
/** Whether a server on this computer (or one's own) answers, in words. */
export const providerStatus = (provider: ProviderId) => invoke<ServerStatus>("provider_status", { provider });

/** Replaces the vault's saved appearance. Pass only a validated object (src/theme). */
export const saveAppearance = (appearance: unknown) => invoke<void>("appearance_set", { appearance });
export const loadThread = (space: string) => invoke<SavedMessage[]>("thread_load", { space });

/** Mirrors `ThreadSummary` in src-tauri/src/thread.rs. `updated` is milliseconds since the epoch. */
export type ThreadSummary = { id: string; title: string; updated: number; messages: number; current: boolean };

/** Keep the current conversation in the space's archive and start an empty one. Refused while a reply runs. */
export const newThread = (space: string) => invoke<void>("thread_new", { space });
/** The space's conversations, the current one first (with either backend). */
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
/** Search the saved conversations in `space`, or in every space. */
export const searchConversations = (space: string, query: string, allSpaces: boolean) =>
  invoke<SearchResults>("conversations_search", { space, query, allSpaces });
