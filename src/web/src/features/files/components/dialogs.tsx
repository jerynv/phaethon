import { useEffect, useRef, useState } from "react";
import { cleanMessage, FieldError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type FileEntry, fileDelete, fileMove, fileRename, folderCreate, itemCount, parentOf } from "../api";
import { FolderPicker } from "./FolderPicker";

/** What the page asked for: one dialog at a time. */
export type FileDialog =
  { kind: "rename"; entry: FileEntry } | { kind: "move"; entry: FileEntry } | { kind: "delete"; entry: FileEntry } | { kind: "folder"; parent: string } | null;

type Props = {
  space: string;
  spaceName: string;
  canTrash: boolean;
  dialog: FileDialog;
  onClose: () => void;
  /** A change landed: `path` is where the item is now (null when it is gone). */
  onDone: (change: { kind: "rename" | "move" | "delete" | "folder"; from?: string; path: string | null; trashed?: boolean }) => void;
};

/** Rename, Move to folder, New folder and Delete, each in its own dialog. */
export function FileDialogs(p: Props) {
  // Keep the last one while its dialog animates out.
  const [shown, setShown] = useState(p.dialog);
  if (p.dialog && p.dialog !== shown) setShown(p.dialog);
  const open = (k: NonNullable<FileDialog>["kind"]) => p.dialog?.kind === k;
  return (
    <>
      <NameDialog {...p} open={open("rename") || open("folder")} shown={shown?.kind === "rename" || shown?.kind === "folder" ? shown : null} />
      <MoveDialog {...p} open={open("move")} entry={shown?.kind === "move" ? shown.entry : null} />
      <DeleteDialog {...p} open={open("delete")} entry={shown?.kind === "delete" ? shown.entry : null} />
    </>
  );
}

function NameDialog({
  space,
  open,
  shown,
  onClose,
  onDone,
}: Props & {
  open: boolean;
  shown: Extract<FileDialog, { kind: "rename" | "folder" }> | null;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const renaming = shown?.kind === "rename" ? shown.entry : null;

  useEffect(() => {
    if (!open) return;
    setName(renaming ? renaming.name : "");
    setError(null);
    // Select the name without its extension, as Finder does.
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      const dot = renaming && !renaming.dir ? renaming.name.lastIndexOf(".") : -1;
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length);
    });
  }, [open, renaming]);

  const submit = async () => {
    if (!shown || busy) return;
    if (!name.trim()) return setError("Give it a name.");
    setBusy(true);
    setError(null);
    try {
      if (shown.kind === "rename") {
        const r = await fileRename(space, shown.entry.path, name.trim());
        onDone({ kind: "rename", from: shown.entry.path, path: r.path });
      } else {
        const r = await folderCreate(space, shown.parent, name.trim());
        onDone({ kind: "folder", path: r.path });
      }
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{renaming ? `Rename “${renaming.name}”` : "New folder"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-1.5">
          <Label htmlFor="files-name" className="sr-only">
            Name
          </Label>
          <Input
            id="files-name"
            ref={input}
            value={name}
            maxLength={255}
            placeholder={renaming ? undefined : "Folder name"}
            aria-invalid={error ? true : undefined}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <FieldError>{error}</FieldError>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" pending={busy} onClick={() => void submit()}>
            {renaming ? "Rename" : "Create folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function MoveDialog({ space, spaceName, open, entry, onClose, onDone }: Props & { open: boolean; entry: FileEntry | null }) {
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const from = entry ? parentOf(entry.path) : "";

  useEffect(() => {
    if (!open || !entry) return;
    setFolder(parentOf(entry.path));
    setError(null);
  }, [open, entry]);

  const submit = async () => {
    if (!entry || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fileMove(space, entry.path, folder);
      onDone({ kind: "move", from: entry.path, path: r.path });
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move “{entry?.name}”</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-2">
          <FolderPicker
            space={space}
            spaceName={spaceName}
            value={folder}
            onChange={setFolder}
            blocked={entry?.dir ? entry.path : undefined}
            className="h-64"
          />
          <FieldError>{error}</FieldError>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" pending={busy} disabled={folder === from} onClick={() => void submit()}>
            Move here
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteDialog({ space, canTrash, open, entry, onClose, onDone }: Props & { open: boolean; entry: FileEntry | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const remove = async () => {
    if (!entry || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fileDelete(space, entry.path);
      onDone({
        kind: "delete",
        from: entry.path,
        path: null,
        trashed: r.trashed,
      });
      onClose();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const inside = entry?.dir && entry.count ? `The ${itemCount(entry.count)} in it go too. ` : "";
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogPopup className="max-w-sm rounded-panel">
        <AlertDialogHeader>
          <AlertDialogTitle>{canTrash ? `Move “${entry?.name}” to the Trash?` : `Delete “${entry?.name}” for good?`}</AlertDialogTitle>
          <AlertDialogDescription>
            {inside}
            {canTrash ? "You can put it back from the Trash." : "It’s deleted from this computer for good. This can’t be undone."}
          </AlertDialogDescription>
          <FieldError>{error}</FieldError>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" shape="pill" pending={busy} onClick={() => void remove()}>
            {canTrash ? "Move to Trash" : "Delete for good"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
