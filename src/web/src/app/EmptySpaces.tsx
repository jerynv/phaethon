import { useState } from "react";
import { ArtTile } from "@/components/art";
import { Button } from "@/components/ui/button";
import { NewSpaceDialog } from "./NewSpaceDialog";

/** No spaces yet (the vault was emptied by hand): a small piece of art, one line, one action. */
export function EmptySpaces() {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-8 pb-16">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <ArtTile palette="sky" seed="no-spaces" className="size-20 rounded-card" />
        <div className="flex flex-col gap-1">
          <h1 className="font-medium text-base text-foreground">No spaces yet</h1>
          <p className="text-muted-foreground text-sm">A space keeps one part of your life apart: its own files, conversations and memory.</p>
        </div>
        <Button size="sm" className="mt-1" onClick={() => setOpen(true)}>
          New space
        </Button>
      </div>
      <NewSpaceDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
