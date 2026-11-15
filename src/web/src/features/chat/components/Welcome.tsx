import { useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { ArtTile } from "@/components/art";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { FILL_EVENT, type FillDetail } from "./ChatActions";

type Starter = { id: string; icon: IconData; title: string; line: string; prompt: string };

/** A study space starts from learning; any other space from its files. Each fills the composer, never sends. */
const STUDY: Starter[] = [
  { id: "teach", icon: icons.teacher, title: "Teach me", line: "A concept, step by step", prompt: "Teach me " },
  { id: "quiz", icon: icons.quiz, title: "Quiz me", line: "Questions from your notes", prompt: "Quiz me on " },
  { id: "plan", icon: icons.plan, title: "Plan my week", line: "Study time around what’s due", prompt: "Plan my week around what’s due" },
];
const GENERAL: Starter[] = [
  { id: "create", icon: icons.create, title: "Create", line: "Notes, plans, drafts", prompt: "Draft " },
  { id: "find", icon: icons.find, title: "Find", line: "Answers in your files", prompt: "Find where my files mention " },
  { id: "summarize", icon: icons.fileText, title: "Summarize", line: "Long files, made short", prompt: "Summarize " },
];

/** A small white file label set on the art tile. */
function FileTag({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-md bg-card/90 px-1.5 text-3xs text-foreground shadow-card", className)}>
      <Icon icon={icons.file} className="size-2.5 text-muted-foreground" />
      {name}
    </span>
  );
}

function fill(draftKey: string, text: string) {
  window.dispatchEvent(new CustomEvent<FillDetail>(FILL_EVENT, { detail: { draftKey, text } }));
}

/**
 * Under the welcome composer (refs a163, a6e6): three starter cards in a row
 * and, at the bottom, one quiet card with a small art tile that brings files
 * into the space (a163's "Connect your channel").
 */
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
          <Card key={s.id} variant="interactive" render={<button type="button" onClick={() => fill(draftKey, s.prompt)} />} className="flex-row items-center gap-3 p-3 text-left @xl/welcome:flex-col @xl/welcome:items-start @xl/welcome:gap-5 @xl/welcome:p-4">
            <Icon icon={s.icon} className="size-5 text-muted-foreground" />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground text-sm">{s.title}</span>
              <span className="text-muted-foreground text-sm">{s.line}</span>
            </span>
          </Card>
        ))}
      </div>
      <span className="min-h-6 flex-1" />
      <Card variant="interactive" render={<button type="button" onClick={addFiles} aria-busy={adding || undefined} />} className="hidden w-full max-w-md flex-row items-center gap-4 p-2 pr-5 text-left @md/welcome:flex">
        {/* The art carries a hint of what goes in, after a163's app icons on its tile. */}
        <ArtTile palette="sky" seed={`welcome-${space.id}`} grain className="flex h-14 w-20">
          <span className="flex size-full flex-col items-start justify-center gap-1 px-1.5" aria-hidden>
            <FileTag name="notes.md" />
            <FileTag name="slides.pdf" className="ml-2" />
          </span>
        </ArtTile>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground text-sm">Add files to {space.name}</span>
          <span className="truncate text-muted-foreground text-sm">Notes, slides and PDFs to read and cite</span>
        </span>
        {adding ? <Spinner size="md" className="text-muted-foreground" /> : <Icon icon={icons.folderAdd} className="size-4.5 text-muted-foreground" />}
      </Card>
    </div>
  );
}
