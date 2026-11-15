import { useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
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

/** Under the welcome composer: three starter cards in a row and, at the bottom, one quiet row that brings files into the space. */
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
    <div className="@container/welcome flex grow-3 flex-col items-center px-8 pb-6">
      <div className="mt-5 grid w-full max-w-(--chat-max-width) grid-cols-1 gap-3 @xl/welcome:grid-cols-3" role="group" aria-label="Starters">
        {starters.map((s) => (
          <Card key={s.id} variant="interactive" render={<button type="button" onClick={() => fill(draftKey, s.prompt)} />} className="flex-row items-center gap-3 p-3 text-left @xl/welcome:flex-col @xl/welcome:items-start @xl/welcome:gap-4 @xl/welcome:p-4">
            <Icon icon={s.icon} className="size-5 text-muted-foreground" />
            <span className="font-medium text-foreground text-sm">{s.title}</span>
          </Card>
        ))}
      </div>
      <span className="min-h-6 flex-1" />
      <button
        type="button"
        onClick={addFiles}
        aria-busy={adding || undefined}
        className="flex h-8 items-center gap-2 rounded-lg px-3 text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {adding ? <Spinner size="sm" /> : <Icon icon={icons.folderAdd} className="size-4" />}
        Add files to {space.name}
      </button>
    </div>
  );
}
