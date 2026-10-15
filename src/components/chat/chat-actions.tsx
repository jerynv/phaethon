import { useAuiState } from "@assistant-ui/react";
import { useContext, useId, useSyncExternalStore } from "react";

import { addedWords, addToSpace, fileManagerName, showInLabel, showSpaceFolder } from "@/components/shell/space-actions";
import { openCourseImport } from "@/components/lms/import-store";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { ACTIONS_FENCE, ATTACH_FILES_EVENT, NEW_SPACE_EVENT, SETTINGS_SECTION, actionLabel, readActions, type ChatActionId } from "@/lib/chat-actions";
import { openSettings } from "@/lib/open-settings";
import { findSpace } from "@/lib/spaces";

import { SpaceIdContext } from "./approval-card";

// What a card's Add files… or Add a folder… came to, kept outside the card so
// it survives a re-render or remount while the reply is on screen.
type Outcome = { at: "adding"; id: ChatActionId } | { at: "added"; words: string } | { at: "error"; message: string };
const outcomes = new Map<string, Outcome>();
const listeners = new Set<() => void>();
const setOutcome = (key: string, o: Outcome | null) => {
  if (o) outcomes.set(key, o);
  else outcomes.delete(key);
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

async function add(key: string, space: string, id: ChatActionId) {
  if (outcomes.get(key)?.at === "adding") return;
  setOutcome(key, { at: "adding", id });
  try {
    const done = await addToSpace(space, id === "add-folder", false);
    setOutcome(key, done ? { at: "added", words: addedWords(findSpace(space)?.name ?? "this space", done) } : null);
  } catch (e) {
    setOutcome(key, { at: "error", message: `Nothing was added. ${e instanceof Error ? e.message : String(e)}` });
  }
}

function run(id: ChatActionId, space: string, key: string) {
  const section = SETTINGS_SECTION[id];
  if (section) return openSettings(section);
  switch (id) {
    case "add-files":
    case "add-folder":
      return void add(key, space, id);
    case "attach-files":
      return void window.dispatchEvent(new CustomEvent(ATTACH_FILES_EVENT, { detail: { space } }));
    case "show-folder":
      return void showSpaceFolder(space);
    case "import-courses":
      return openCourseImport({ space });
    case "new-space":
      return void window.dispatchEvent(new CustomEvent(NEW_SPACE_EVENT));
  }
}

/**
 * A ```phaethon-actions block in a reply, drawn as a row of buttons instead
 * of code: the app's own words and icon for each id it knows (chat-actions.ts),
 * unknown ids left out, nothing at all until the reply is whole. Add files…
 * and Add a folder… say what they added (or why not) beneath, politely, with
 * Show in Finder; the others open what they name.
 */
export function ChatActions({ code }: { code: string }) {
  const space = useContext(SpaceIdContext);
  const complete = useAuiState((s) => s.message.status?.type !== "running");
  const messageId = useAuiState((s) => s.message.id);
  const key = `${space}\n${messageId}`;
  const outcome = useSyncExternalStore(subscribe, () => outcomes.get(key));
  const statusId = useId();
  const ids = complete ? readActions(code) : [];
  if (ids.length === 0) return null;
  const fm = fileManagerName();
  return (
    <div className="my-3 flex flex-col gap-2" data-chat-actions="">
      <div role="group" aria-label="Quick actions" className="flex flex-wrap gap-2">
        {ids.map((id) => {
          const { label, icon } = actionLabel(id, fm);
          const busy = outcome?.at === "adding" && outcome.id === id;
          return (
            <Button
              key={id}
              type="button"
              variant="outline"
              size="sm"
              data-chat-action={id}
              aria-disabled={outcome?.at === "adding" || undefined}
              aria-describedby={outcome && outcome.at !== "adding" ? statusId : undefined}
              onClick={() => outcome?.at !== "adding" && run(id, space, key)}
            >
              <Icon name={busy ? "spinner" : icon} className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
              {busy ? "Adding…" : label}
            </Button>
          );
        })}
      </div>
      <div role="status" className="empty:hidden">
        {outcome?.at === "added" && (
          <p id={statusId} className="flex items-start gap-2 text-sm text-ink" data-chat-action-added="">
            <Icon name="success" className="mt-0.5 shrink-0 text-success-ink" />
            <span className="min-w-0 wrap-break-word">{outcome.words}</span>
          </p>
        )}
      </div>
      {outcome?.at === "added" && (
        <Button type="button" variant="link" size="sm" className="self-start" data-chat-action-show="" onClick={() => void showSpaceFolder(space)}>
          <Icon name="folder" />
          {showInLabel()}
        </Button>
      )}
      {outcome?.at === "error" && (
        <p id={statusId} role="alert" className="flex items-start gap-2 text-sm text-ink" data-chat-action-error="">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <span className="min-w-0 wrap-break-word">{outcome.message}</span>
        </p>
      )}
    </div>
  );
}

/** For the markdown renderer: the block's language, drawn as the buttons with no code header. */
const NoHeader = () => null;
export const CHAT_ACTION_LANGUAGES = {
  [ACTIONS_FENCE]: { CodeHeader: NoHeader, SyntaxHighlighter: ChatActions },
};
