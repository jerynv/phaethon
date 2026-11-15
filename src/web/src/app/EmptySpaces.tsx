import { useState } from "react";
import { EmptyState } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { NewSpaceDialog } from "./NewSpaceDialog";

/** No spaces yet (the vault was emptied by hand): art, one line, one action. */
export function EmptySpaces() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 pb-16">
      <EmptyState
        palette="meadow"
        seed="no-spaces"
        title="No spaces yet"
        description="A space keeps its own files, conversations and memory."
        action={
          <Button size="sm" className="w-full" onClick={() => setOpen(true)}>
            <Icon icon={icons.add} />
            New space
          </Button>
        }
      />
      <NewSpaceDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
