import type { TelemetryChoices, TelemetryView } from "#shared/telemetry.ts";
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
  /** When it was pinned (ms); absent when it isn't. */
  pinned?: number;
  /** The title was given by hand. */
  renamed?: boolean;
  /** When its writes were allowed without asking (ms). */
  allowWrites?: number;
};

/** A listed conversation, with whether it is replying right now (in this window or another). */
export type ThreadListed = ThreadSummary & { running?: boolean };

/**
 * One page of a space's conversations, newest first: on the first page every
 * pinned one comes first, then up to `limit` others. `nextCursor` asks for
 * the page after (as `before`); `total` counts every conversation that matches.
 */
export type ThreadPage = { items: ThreadListed[]; total: number; hasMore: boolean; nextCursor: string | null };

/** Where Phaethon writes files without asking (Settings lists these and can take them back). */
export type WritePermissions = {
  spaces: { space: string; since: number }[];
  conversations: { thread: string; title: string; since: number }[];
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

export type TelemetrySettings = TelemetryChoices & { configured: boolean; collectorConfigured: boolean };

export const api = {
  telemetry: () => invoke<TelemetrySettings>("telemetry_get"),
  saveTelemetry: (choices: TelemetryChoices) => invoke<TelemetrySettings>("telemetry_set", { choices }),
  /** Views and file opens; the core counts every other action itself. */
  telemetryUsage: (event: "view_opened" | "action_completed", data: { view?: TelemetryView; action?: "file_opened" }) =>
    invoke<boolean>("telemetry_usage", { event, data }),
  previewTelemetryReport: (text: string) => invoke<string>("telemetry_report_preview", { text }),
  sendTelemetryReport: (text: string) => invoke<null>("telemetry_report_send", { text }),
  coreInfo: () => invoke<CoreInfo>("core_info"),
  settings: () => invoke<SettingsView>("settings_get"),
  spaces: () => invoke<SpaceView[]>("spaces_list"),
  createSpace: (a: { name: string; description?: string | null; hue?: number | null; educationEnabled?: boolean | null }) =>
    invoke<SpaceView>("space_create", a),
  updateSpace: (a: { id: string; name?: string; description?: string; hue?: number; educationEnabled?: boolean }) =>
    invoke<SpaceView>("space_update", a),
  deleteSpace: (id: string) => invoke<void>("space_delete", { id }),
  revealDeletedSpace: (id: string) => invoke<void>("space_reveal_deleted", { id }),
  touchSpace: (id: string) => invoke<void>("space_touch", { id }),
  showSpace: (id: string) => invoke<void>("space_show", { id }),
  addToSpace: (id: string, folder: boolean) => invoke<{ paths: string[]; files: number; skipped: number } | null>("space_add", { id, folder }),
  exportSpace: (id: string) => invoke<{ fileName: string; files: number } | null>("space_export", { id }),
  showExport: () => invoke<void>("export_show"),
  threads: (space: string, page: { limit: number; before?: string | null; query?: string }) => invoke<ThreadPage>("threads_list", { space, ...page }),
  /** One conversation's row, read again after a reply; null when it isn't saved. */
  threadSummary: (space: string, thread: string) => invoke<ThreadListed | null>("thread_summary", { space, thread }),
  threadsCount: (space: string) => invoke<{ total: number; pinned: number }>("threads_count", { space }),
  createThread: (space: string) => invoke<string>("thread_create", { space }),
  deleteThread: (space: string, thread: string) => invoke<void>("thread_delete", { space, thread }),
  renameThread: (space: string, thread: string, title: string) => invoke<unknown>("thread_rename", { space, thread, title }),
  pinThread: (space: string, thread: string, pinned: boolean) => invoke<unknown>("thread_pin", { space, thread, pinned }),
  writePermissions: (space: string) => invoke<WritePermissions>("write_permissions_list", { space }),
  /** Lets Phaethon write without asking in one conversation (`thread`) or the whole space, or takes that back. */
  setWritePermission: (a: { space: string; thread?: string; scope: "conversation" | "space"; allow: boolean }) => invoke<WritePermissions>("write_permission_set", a),
  search: (space: string, query: string, allSpaces: boolean) =>
    invoke<SearchResults>("conversations_search", { space, query, allSpaces }),
  updateState: () => invoke<UpdateView>("update_state"),
  updateCheck: () => invoke<UpdateView>("update_check"),
};
