import { useState } from "react";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useShell } from "./shell-store";
import { deleteConversation } from "./threads";

/** Asks before deleting a conversation; files it attached stay in the space. */
export function ConfirmDeleteDialog() {
  const target = useShell((s) => s.confirmDelete);
  const setTarget = useShell((s) => s.setConfirmDelete);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          setTarget(null);
          setError(null);
        }
      }}
    >
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
          <AlertDialogDescription>
            “{target?.title}” will be deleted for good. Files it added to the space stay.
          </AlertDialogDescription>
          {error ? (
            <p role="alert" className="rounded-md bg-error-surface px-3 py-2 text-error-foreground text-sm">
              {error}
            </p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!target) return;
              setBusy(true);
              const problem = await deleteConversation(target.spaceId, target.id);
              setBusy(false);
              if (problem) setError(problem);
              else setTarget(null);
            }}
          >
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
