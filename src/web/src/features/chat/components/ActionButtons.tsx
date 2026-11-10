import {
  BookOpenIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  FilePlusIcon,
  FolderIcon,
  FolderPlusIcon,
  InfoIcon,
  LayersIcon,
  LoaderIcon,
  PaletteIcon,
  PaperclipIcon,
  PersonStandingIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import { use, useId, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";
import { spaceAdd, spaceShow } from "../api";
import { MessageContext, useSpace, useSpaceId } from "../context";
import { SETTINGS_SECTION, actionLabel, fileManagerName, readActions, type ChatActionId } from "../lib/chat-actions";

const ICONS: Record<ChatActionId, LucideIcon> = {
  "add-files": FilePlusIcon,
  "add-folder": FolderPlusIcon,
  "attach-files": PaperclipIcon,
  "show-folder": FolderIcon,
  "import-courses": BookOpenIcon,
  "new-space": LayersIcon,
  "settings-assistant": SparklesIcon,
  "settings-appearance": PaletteIcon,
  "settings-accessibility": PersonStandingIcon,
  "settings-spaces": LayersIcon,
  "settings-courses": BookOpenIcon,
  "settings-about": InfoIcon,
};

/** Asks the composer of a space to open its file picker. */
export const ATTACH_FILES_EVENT = "phaethon:attach-files";

type Outcome = { at: "adding"; id: ChatActionId } | { at: "added"; words: string } | { at: "error"; message: string };

/**
 * A ```phaethon-actions block, drawn as buttons with the app's own words,
 * nothing until the reply is whole. Add files… says what it added (or why
 * not) beneath, politely.
 */
export function ActionButtons({ code }: { code: string }) {
  const space = useSpaceId();
  const { name } = useSpace(space);
  const { streaming } = use(MessageContext);
  const nav = useNav();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const statusId = useId();
  const ids = streaming ? [] : readActions(code);
  if (!ids.length) return null;
  const fm = fileManagerName();

  const add = async (id: ChatActionId) => {
    setOutcome({ at: "adding", id });
    try {
      const done = await spaceAdd(space, id === "add-folder");
      if (!done) return setOutcome(null);
      const names = done.paths.map((p) => p.replace(/^files\//, ""));
      const what = names.length === 1 ? names[0] : `${names.length} items`;
      setOutcome({ at: "added", words: `Added ${what} (${done.files === 1 ? "1 file" : `${done.files} files`}) to ${name}.` });
    } catch (e) {
      setOutcome({ at: "error", message: `Nothing was added. ${errorText(e)}` });
    }
  };

  const run = (id: ChatActionId) => {
    const section = SETTINGS_SECTION[id];
    if (section) return nav.openSettings(section);
    switch (id) {
      case "add-files":
      case "add-folder":
        return void add(id);
      case "attach-files":
        return void window.dispatchEvent(new CustomEvent(ATTACH_FILES_EVENT, { detail: { space } }));
      case "show-folder":
        return void spaceShow(space).catch((e) => setOutcome({ at: "error", message: errorText(e) }));
      case "import-courses":
        return nav.go({ kind: "courses" }, space);
      case "new-space":
        return nav.openSettings("spaces");
    }
  };

  return (
    <div className="ph-block ph-ui flex flex-col gap-2" data-chat-actions="">
      <div role="group" aria-label="Suggested actions" className="flex flex-wrap gap-2">
        {ids.map((id) => {
          const busy = outcome?.at === "adding" && outcome.id === id;
          const Icon = busy ? LoaderIcon : ICONS[id];
          return (
            <Button
              key={id}
              variant="outline"
              size="sm"
              data-chat-action={id}
              aria-disabled={outcome?.at === "adding" || undefined}
              aria-describedby={outcome && outcome.at !== "adding" ? statusId : undefined}
              onClick={() => outcome?.at !== "adding" && run(id)}
            >
              <Icon aria-hidden className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
              {busy ? "Adding…" : actionLabel(id, fm)}
            </Button>
          );
        })}
      </div>
      <div role="status" className="empty:hidden">
        {outcome?.at === "added" && (
          <p id={statusId} className="flex items-start gap-2 text-sm">
            <CircleCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{outcome.words}</span>
          </p>
        )}
      </div>
      {outcome?.at === "error" && (
        <p id={statusId} role="alert" className="flex items-start gap-2 text-sm">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>{outcome.message}</span>
        </p>
      )}
    </div>
  );
}
