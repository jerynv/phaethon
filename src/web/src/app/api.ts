import { invoke } from "@/lib/core";

/** Wire types and calls the shell uses (old Tauri command names and shapes). */

export type SpaceView = {
  id: string;
  name: string;
  description: string;
  hue: number;
  educationEnabled: boolean;
  lastUsed: number | null;
};

export type ThreadSummary = {
  id: string;
  title: string;
  updated: number;
  messages: number;
  current: boolean;
};

export type SearchSnippet = {
  message: number;
  role: "user" | "assistant";
  before: string;
  matched: string;
  after: string;
};

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

export type CoreInfo = { version: string; platform: string; desktop: boolean };

/** The parts of `settings_get` the shell reads; the assistant settings own the rest. */
export type SettingsView = {
  backend?: string;
  providerReady?: boolean;
  hasAnthropicKey?: boolean;
  appearance?: unknown;
  vaultPath?: string;
  version?: string;
};

export type UpdateStatus =
  | { state: "notSetUp"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAt: number }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "error"; message: string; during: "check" | "launch" };

export type UpdateView = { currentVersion: string; source: string | null; canInstall: boolean; status: UpdateStatus };

export type InstallEvent =
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "installing" }
  | { kind: "restarting" };

export const api = {
  coreInfo: () => invoke<CoreInfo>("core_info"),
  settings: () => invoke<SettingsView>("settings_get"),
  spaces: () => invoke<SpaceView[]>("spaces_list"),
  createSpace: (a: { name: string; description?: string | null; hue?: number | null; educationEnabled?: boolean | null }) =>
    invoke<SpaceView>("space_create", a),
  updateSpace: (a: { id: string; name?: string; description?: string; hue?: number; educationEnabled?: boolean }) =>
    invoke<SpaceView>("space_update", a),
  touchSpace: (id: string) => invoke<void>("space_touch", { id }),
  showSpace: (id: string) => invoke<void>("space_show", { id }),
  addToSpace: (id: string, folder: boolean) => invoke<{ paths: string[]; files: number; skipped: number } | null>("space_add", { id, folder }),
  exportSpace: (id: string) => invoke<{ fileName: string; files: number } | null>("space_export", { id }),
  showExport: () => invoke<void>("export_show"),
  threads: (space: string) => invoke<ThreadSummary[]>("threads_list", { space }),
  newThread: (space: string) => invoke<void>("thread_new", { space }),
  openThread: (space: string, id: string) => invoke<void>("thread_open", { space, id }),
  deleteThread: (space: string, id: string) => invoke<void>("thread_delete", { space, id }),
  search: (space: string, query: string, allSpaces: boolean) =>
    invoke<SearchResults>("conversations_search", { space, query, allSpaces }),
  updateState: () => invoke<UpdateView>("update_state"),
  updateCheck: () => invoke<UpdateView>("update_check"),
};
