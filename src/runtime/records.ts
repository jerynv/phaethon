import { invoke } from "@tauri-apps/api/core";

import type { SavedAttachment } from "@/lib/backend";

/** How the user answers an access request (`AccessAnswer` in agent.rs). A cancelled request counts as "deny". */
export type AccessAnswer = "once" | "always" | "deny";

/**
 * Something saved into the conversation record (never sent to the model): a
 * write the user answered, an access answer, a read in another space, or a
 * stopped reply. Sent live as a `record` event and returned again by
 * thread_load, so the receipts survive a reload.
 */
export type ChatRecord =
  | { kind: "approval"; path: string; action: "create" | "replace"; allowed: boolean }
  | { kind: "access"; space: string; path: string; answer: AccessAnswer }
  | { kind: "read"; space: string; path: string; tool: "read" | "list" | "search"; query?: string }
  | { kind: "stopped" };

/** A record as a data part of a reply: `id` makes "say it once" possible. */
export type RecordPartData = { id: string; record: ChatRecord };
export const RECORD_PART = "record";

/** Mirrors `UiMessage` in src-tauri/src/thread.rs (contract: index + records). */
export type UiMessage = {
  role: "user" | "assistant";
  text: string;
  attachments: SavedAttachment[];
  /** Position of the message's first raw entry in thread.json: what replaceFrom takes. */
  index: number;
  records: ChatRecord[];
};

export const loadUiThread = (space: string) => invoke<UiMessage[]>("thread_load", { space });

/** Open a file in the space with the default app, or show it in the file manager (`reveal`). */
export const openSpaceFile = (space: string, path: string, reveal = false) =>
  invoke<void>("file_open", { space, path, reveal });
