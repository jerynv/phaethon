import { FolderOpenIcon, FolderPlusIcon, GraduationCapIcon, PaperclipIcon, PlusIcon, Settings2Icon } from "lucide-react";
import { api } from "@/app/api";
import { useNav, type SettingsSection } from "@/app/store";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";
import { fileManagerName } from "@/lib/platform";
import { actionLabel, readActions, type ChatActionId } from "../lib/chat-actions";

/** Composer listens for this to open its file picker. */
export const ATTACH_EVENT = "phaethon:attach";

const SECTION: Partial<Record<ChatActionId, SettingsSection>> = {
  "settings-assistant": "providers",
  "settings-appearance": "appearance",
  "settings-accessibility": "appearance",
  "settings-spaces": "spaces",
  "settings-courses": "courses",
  "settings-about": "about",
};

function icon(id: ChatActionId) {
  if (id === "attach-files") return <PaperclipIcon />;
  if (id === "add-files" || id === "add-folder") return <FolderPlusIcon />;
  if (id === "show-folder") return <FolderOpenIcon />;
  if (id === "import-courses") return <GraduationCapIcon />;
  if (id === "new-space") return <PlusIcon />;
  return <Settings2Icon />;
}

/** Buttons the assistant offered (a `phaethon-actions` block): at most three, known ones only. */
export function ChatActions({ code, space }: { code: string; space: string }) {
  const ids = readActions(code);
  const nav = useNav.getState;
  if (ids.length === 0) return null;
  const run = (id: ChatActionId) => {
    const section = SECTION[id];
    if (section) return nav().openSettings(section);
    switch (id) {
      case "attach-files":
        return window.dispatchEvent(new CustomEvent(ATTACH_EVENT));
      case "add-files":
      case "add-folder":
        return void api.addToSpace(space, id === "add-folder").then(
          (r) => r && toast.success(`Added ${r.files} ${r.files === 1 ? "file" : "files"}`, r.skipped ? `${r.skipped} skipped` : undefined),
          (e) => toast.error("Couldn’t add files", errorText(e)),
        );
      case "show-folder":
        return void api.showSpace(space).catch((e) => toast.error("Couldn’t show the folder", errorText(e)));
      case "import-courses":
        return nav().setView("courses");
      case "new-space":
        return nav().openSettings("spaces");
    }
  };
  return (
    <div className="my-2 flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <Button key={id} size="xs" variant="outline" onClick={() => run(id)}>
          {icon(id)}
          {actionLabel(id, fileManagerName())}
        </Button>
      ))}
    </div>
  );
}
