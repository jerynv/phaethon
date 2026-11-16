import { api } from "@/app/api";
import { useNav, type SettingsSection } from "@/app/store";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";
import { fileManagerName } from "@/lib/platform";
import { actionLabel, readActions, type ChatActionId } from "../lib/chat-actions";

/** Composer listens for this to open its file picker. */
export const ATTACH_EVENT = "phaethon:attach";

/** The welcome's starter cards put words in the composer of one conversation (`draftKey`). */
export const FILL_EVENT = "phaethon:composer-fill";
export type FillDetail = { draftKey: string; text: string };

const SECTION: Partial<Record<ChatActionId, SettingsSection>> = {
  "settings-assistant": "providers",
  "settings-appearance": "appearance",
  "settings-accessibility": "appearance",
  "settings-spaces": "spaces",
  "settings-courses": "courses",
  "settings-memory": "memory",
  "settings-people": "people",
  "settings-mail": "mail",
  "settings-automations": "automations",
  "settings-about": "about",
};

function icon(id: ChatActionId) {
  if (id === "attach-files") return <Icon icon={icons.attach} />;
  if (id === "add-files" || id === "add-folder") return <Icon icon={icons.folderAdd} />;
  if (id === "show-folder") return <Icon icon={icons.folderOpen} />;
  if (id === "import-courses") return <Icon icon={icons.courses} />;
  if (id === "new-space") return <Icon icon={icons.add} />;
  if (id === "settings-memory") return <Icon icon={icons.memory} />;
  if (id === "settings-people") return <Icon icon={icons.people} />;
  if (id === "settings-mail") return <Icon icon={icons.mail} />;
  if (id === "settings-automations") return <Icon icon={icons.automation} />;
  return <Icon icon={icons.settings} />;
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
        <Button key={id} size="sm" variant="outline" onClick={() => run(id)}>
          {icon(id)}
          {actionLabel(id, fileManagerName())}
        </Button>
      ))}
    </div>
  );
}
