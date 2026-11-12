import { useState } from "react";
import { cleanMessage, FieldError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Spinner } from "@/components/ui/spinner";
import { studyDelete } from "../api";

/** "Delete “Sets and functions”?": the deck or quiz file goes; nothing else does. */
export function ConfirmDelete({
  space,
  item,
  onClose,
  onDeleted,
}: {
  space: string;
  item: { path: string; title: string; kind: "deck" | "quiz" } | null;
  onClose: () => void;
  onDeleted: (path: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(item);
  if (item && item !== shown) setShown(item);

  const remove = async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await studyDelete(space, item.path);
      toast.success(`Deleted ${item.title}`);
      onDeleted(item.path);
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={item !== null}
      onOpenChange={(o) => {
        if (!o) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogPopup className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="text-lg">Delete “{shown?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {shown?.kind === "quiz" ? "The quiz is deleted. Past scores go with it." : "The deck and its review history are deleted."} This can’t be undone.
          </AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button size="sm" variant="ghost" />}>Cancel</AlertDialogClose>
          <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
