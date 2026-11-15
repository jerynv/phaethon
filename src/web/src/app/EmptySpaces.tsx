import { Stack } from "@phosphor-icons/react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { NewSpaceDialog } from "./NewSpaceDialog";

/** No spaces yet (the vault was emptied by hand): one action, make one. */
export function EmptySpaces() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-1 flex-col">
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Stack />
          </EmptyMedia>
          <EmptyTitle>No spaces</EmptyTitle>
          <EmptyDescription>A space keeps one part of your life apart: its own files, conversations and memory.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => setOpen(true)}>
            New space
          </Button>
        </EmptyContent>
      </Empty>
      <NewSpaceDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
