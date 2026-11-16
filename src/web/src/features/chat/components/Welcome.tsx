import { useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";
import { FILL_EVENT, type FillDetail } from "./ChatActions";

type Starter = { id: string; icon: IconData; title: string; prompt: string };

/** A study space starts from learning; any other space from its files. Each fills the composer, never sends. */
const STUDY: Starter[] = [
  { id: "teach", icon: icons.teacher, title: "Teach me", prompt: "Teach me " },
  { id: "quiz", icon: icons.quiz, title: "Quiz me", prompt: "Quiz me on " },
  { id: "plan", icon: icons.plan, title: "Plan my week", prompt: "Plan my week around what’s due" },
];
const GENERAL: Starter[] = [
  { id: "create", icon: icons.create, title: "Create", prompt: "Draft " },
  { id: "find", icon: icons.find, title: "Find", prompt: "Find where my files mention " },
  { id: "summarize", icon: icons.fileText, title: "Summarize", prompt: "Summarize " },
];

function fill(draftKey: string, text: string) {
  window.dispatchEvent(new CustomEvent<FillDetail>(FILL_EVENT, { detail: { draftKey, text } }));
}

const CHIP = "h-8 gap-1.5 px-3 font-normal text-sm sm:h-8";

/** Under the welcome composer: one centred row of starter chips, and a quieter one that brings files into the space. */
export function Welcome({ space, draftKey }: { space: SpaceView; draftKey: string }) {
  const starters = space.educationEnabled ? STUDY : GENERAL;
  const [adding, setAdding] = useState(false);
  const addFiles = () => {
    if (adding) return;
    setAdding(true);
    api
      .addToSpace(space.id, false)
      .then(
        (r) => r && toast.success(`Added ${r.files} ${r.files === 1 ? "file" : "files"} to ${space.name}`, r.skipped ? `${r.skipped} skipped` : undefined),
        (e) => toast.error("Couldn’t add files", errorText(e)),
      )
      .finally(() => setAdding(false));
  };
  return (
    <div className="flex grow-3 flex-col items-center px-8 pb-6">
      <div className="mt-3 flex w-full max-w-(--chat-max-width) flex-wrap items-center justify-center gap-2" role="group" aria-label="Starters">
        {starters.map((s) => (
          <Button key={s.id} variant="outline" className={CHIP} onClick={() => fill(draftKey, s.prompt)}>
            <Icon icon={s.icon} className="size-4" />
            {s.title}
          </Button>
        ))}
        <Button variant="ghost-muted" className={CHIP} onClick={addFiles} pending={adding}>
          <Icon icon={icons.folderAdd} className="size-4" />
          Add files to {space.name}
        </Button>
      </div>
    </div>
  );
}
