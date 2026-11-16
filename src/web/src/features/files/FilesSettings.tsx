import { type ReactNode, useEffect, useState } from "react";
import type { SpaceView } from "@/app/api";
import { cleanMessage, RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonRows } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { StartTruncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useDelayed } from "@/hooks/use-delayed";
import { Row, SettingsGroup, SwitchRow, useLoad } from "@/features/settings/ui";
import { type FileSort, filesSettings, setFilesSettings, SORTS } from "./api";
import { FolderPicker } from "./components/FolderPicker";

/**
 * Settings › Spaces › (a space) › Files: what the Files view shows (hidden
 * files, the order it starts in) and the folders Phaethon's own agent may not
 * read, enforced by its file tools in the core. The coding agents read the
 * folder with their own tools, so the copy says the exclusion is Phaethon's
 * agent's. `children` are the group's other rows (Export, Space folder).
 */
export function FilesGroup({ space, children }: { space: SpaceView; children?: ReactNode }) {
  const state = useLoad(() => filesSettings(space.id), [space.id], "spaces:files");
  const [busy, setBusy] = useState<"hidden" | "sort" | "excluded" | null>(null);
  const [picking, setPicking] = useState(false);
  const waiting = useDelayed(state.loading && !state.data);
  const s = state.data;

  const save = async (kind: "hidden" | "sort" | "excluded", patch: { showHidden?: boolean; sort?: FileSort; excluded?: string[] }) => {
    setBusy(kind);
    try {
      state.setData(await setFilesSettings(space.id, patch));
    } catch (e) {
      toast.error("Couldn’t change the Files settings", cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsGroup label="Files">
      {s ? (
        <>
          <SwitchRow
            label="Show hidden files"
            description="Names that start with a dot, like .gitignore."
            checked={s.showHidden}
            pending={busy === "hidden"}
            onCheckedChange={(v) => void save("hidden", { showHidden: v })}
          />
          <Row label="Sort files by">
            <Select value={s.sort} onValueChange={(v) => void save("sort", { sort: v as FileSort })} disabled={busy === "sort"}>
              <SelectTrigger size="sm" aria-label="Sort files by" className="w-40">
                <SelectValue>{(v: FileSort) => SORTS.find((o) => o.value === v)?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {SORTS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Row>
          <Row
            label="Folders Phaethon’s agent can’t read"
            description="Phaethon’s own agent can’t list, read, search or change anything in them. Coding agents like Claude Code and Codex read the folder with their own tools, so this doesn’t apply to them."
            below={
              s.excluded.length ? (
                <ul aria-label="Folders kept from Phaethon’s agent" className="flex flex-col gap-px">
                  {s.excluded.map((f) => (
                    <li key={f} className="flex h-8 min-w-0 items-center gap-2 rounded-md pr-0.5 pl-1 hover:bg-accent">
                      <Icon icon={icons.locked} className="size-3.5 shrink-0 text-subtle-foreground" />
                      <StartTruncate value={`${f}/`} className="min-w-0 flex-1 font-mono text-xs" />
                      <Button
                        size="xs"
                        variant="ghost-destructive"
                        disabled={busy === "excluded"}
                        aria-label={`Let Phaethon’s agent read ${f}`}
                        onClick={() =>
                          void save("excluded", {
                            excluded: s.excluded.filter((x) => x !== f),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : undefined
            }
          >
            <Button size="xs" variant="outline" pending={busy === "excluded"} onClick={() => setPicking(true)}>
              Add folder…
            </Button>
          </Row>
          <ExcludeDialog
            space={space}
            open={picking}
            excluded={s.excluded}
            onOpenChange={setPicking}
            onPick={async (folder) => {
              await save("excluded", { excluded: [...s.excluded, folder] });
              setPicking(false);
            }}
          />
        </>
      ) : state.error ? (
        <div className="px-3 py-2">
          <RowError message="Couldn’t read the Files settings" onRetry={() => void state.reload()} />
        </div>
      ) : waiting ? (
        <SkeletonRows count={2} className="px-1 py-1" />
      ) : null}
      {children}
    </SettingsGroup>
  );
}

function ExcludeDialog({
  space,
  open,
  excluded,
  onOpenChange,
  onPick,
}: {
  space: SpaceView;
  open: boolean;
  excluded: string[];
  onOpenChange: (o: boolean) => void;
  onPick: (folder: string) => Promise<void>;
}) {
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setFolder("");
  }, [open]);
  const already = excluded.some((f) => folder === f || folder.startsWith(`${f}/`));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keep a folder from Phaethon’s agent</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <FolderPicker space={space.id} spaceName={space.name} value={folder} onChange={setFolder} className="h-64" />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            pending={busy}
            disabled={!folder || already}
            onClick={async () => {
              setBusy(true);
              try {
                await onPick(folder);
              } finally {
                setBusy(false);
              }
            }}
          >
            {already ? "Already kept out" : folder ? `Keep out “${folder.split("/").pop()}”` : "Choose a folder"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
