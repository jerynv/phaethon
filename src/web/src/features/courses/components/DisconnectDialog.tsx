import { useState } from "react";
import { cleanMessage, FieldError } from "@/components/errors";
import { toast } from "@/components/toast";
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
import { Spinner } from "@/components/ui/spinner";
import { connectionName } from "../lib/sites";
import type { LmsConnection } from "../lib/types";
import { useCourses } from "../store";

/** Signs out of a course site; imported courses stay where they are. */
export function DisconnectDialog({ connection, onOpenChange }: { connection: LmsConnection | null; onOpenChange: (open: boolean) => void }) {
  const disconnect = useCourses((s) => s.disconnect);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = connection ? connectionName(connection) : "";

  const run = async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      await disconnect(connection.id);
      toast.success(`Disconnected from ${name}`);
      onOpenChange(false);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={!!connection} onOpenChange={(o) => (!o ? (setError(null), onOpenChange(false)) : undefined)}>
      <AlertDialogPopup className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">Disconnect {name}?</AlertDialogTitle>
          <AlertDialogDescription>Phaethon signs out of this site. Imported courses stay in your spaces; sign in again to import more.</AlertDialogDescription>
          <FieldError className="pt-1">{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" size="sm" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" size="sm" onClick={() => void run()} disabled={busy} className="min-w-24">
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
