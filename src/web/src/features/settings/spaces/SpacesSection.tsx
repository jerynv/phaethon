import { ChevronRightIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { HUES } from "@/app/NewSpaceDialog";
import { useNav } from "@/app/store";
import { FieldError, RowError, SurfaceError, cleanMessage } from "@/components/errors";
import { SkeletonCard, SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { StartTruncate, Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import {
  bindWorkspace,
  chooseWorkspace,
  clearWorkspace,
  fullAccessList,
  getWorkspace,
  listGrants,
  restoreGrant,
  revokeGrant,
  setFullAccess,
} from "../agents/api";
import { Card, ConfirmDialog, Group, Loader, Row, useCrumb, useLoad } from "../ui";

/**
 * Settings › Spaces: the list of spaces, and per space its name,
 * description, colour and study tools; the folder coding agents work in;
 * full access; which other spaces it reads or is read by; and export.
 */

const refreshSpaces = () => useNav.getState().loadSpaces();

function Swatches({ value, onChange, disabled }: { value: number; onChange: (h: number) => void; disabled?: boolean }) {
  const list = HUES.includes(value) ? HUES : [...HUES, value];
  return (
    <div className="flex gap-1.5" role="radiogroup" aria-label="Colour">
      {list.map((h) => (
        <button
          key={h}
          type="button"
          role="radio"
          aria-label={`Hue ${h}`}
          aria-checked={h === value}
          disabled={disabled}
          onClick={() => onChange(h)}
          className={cn("size-5 rounded-full ring-offset-2 ring-offset-card transition-shadow disabled:opacity-60", h === value && "ring-2 ring-foreground/60")}
          style={{ background: `oklch(0.62 0.14 ${h})` }}
        />
      ))}
    </div>
  );
}

function NewSpace({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (s: SpaceView) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hue, setHue] = useState(HUES[0]!);
  const [edu, setEdu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!name.trim()) return setError("Give the space a name.");
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSpace({ name: name.trim(), description: description.trim() || null, hue, educationEnabled: edu });
      await refreshSpaces();
      toast.success(`${s.name} created`);
      onOpenChange(false);
      setName("");
      setDescription("");
      setEdu(false);
      onCreated(s);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>A separate compartment with its own files, conversations and memory.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-space-name">Name</Label>
            <div className="flex items-center gap-2">
              <SpaceAvatar name={name || "S"} hue={hue} className="size-7 rounded-md text-xs" />
              <Input
                id="settings-space-name"
                autoFocus
                value={name}
                maxLength={60}
                aria-invalid={error ? true : undefined}
                placeholder="School, Work, Thesis…"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void submit()}
              />
            </div>
            <FieldError>{error}</FieldError>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="settings-space-desc">Description</Label>
            <Input id="settings-space-desc" value={description} maxLength={200} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Colour</Label>
            <Swatches value={hue} onChange={setHue} />
          </div>
          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
            <span className="flex flex-col">
              <span className="font-medium text-sm">Study tools</span>
              <span className="text-muted-foreground text-xs">Courses, flashcards, quizzes, grades and a study plan.</span>
            </span>
            <Switch checked={edu} onCheckedChange={setEdu} />
          </label>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy} className="min-w-24">
            {busy ? <Spinner /> : null}
            {busy ? "Creating…" : "Create space"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A text field that saves on Enter or when it loses focus. */
function SavedField({ id, value, placeholder, maxLength, onSave }: { id: string; value: string; placeholder?: string; maxLength: number; onSave: (v: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(value), [value]);
  const save = async () => {
    if (draft.trim() === value) return setDraft(value);
    setBusy(true);
    setError(null);
    try {
      await onSave(draft.trim());
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Input
          id={id}
          size="sm"
          value={draft}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setDraft(value);
              setError(null);
            }
          }}
          className={busy ? "pr-7" : undefined}
        />
        {busy ? <Spinner size="sm" tone="muted" className="absolute top-1/2 right-2 -translate-y-1/2" /> : null}
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}

function IdentityGroup({ space }: { space: SpaceView }) {
  const [busy, setBusy] = useState<"hue" | "edu" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const update = async (patch: { name?: string; description?: string; hue?: number; educationEnabled?: boolean }) => {
    await api.updateSpace({ id: space.id, ...patch });
    await refreshSpaces();
  };
  const quick = async (kind: "hue" | "edu", patch: { hue?: number; educationEnabled?: boolean }) => {
    setBusy(kind);
    setError(null);
    try {
      await update(patch);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Group label="Space">
      <Card>
        <Row label="Name" htmlFor={`name-${space.id}`} below={<SavedField id={`name-${space.id}`} value={space.name} maxLength={60} onSave={(name) => update({ name })} />} />
        <Row
          label="Description"
          htmlFor={`desc-${space.id}`}
          description="Phaethon reads it to know what the space is for."
          below={<SavedField id={`desc-${space.id}`} value={space.description} placeholder="What this space is for" maxLength={200} onSave={(description) => update({ description })} />}
        />
        <Row label="Colour" below={busy === "hue" && error ? <FieldError>{error}</FieldError> : undefined}>
          {busy === "hue" ? <Spinner size="sm" tone="muted" /> : null}
          <Swatches value={space.hue} disabled={busy === "hue"} onChange={(hue) => void quick("hue", { hue })} />
        </Row>
        <Row label="Study tools" description="Courses, flashcards, quizzes, grades and a study plan." below={busy !== "hue" && error ? <FieldError>{error}</FieldError> : undefined}>
          <Switch checked={space.educationEnabled} disabled={busy === "edu"} onCheckedChange={(on) => void quick("edu", { educationEnabled: on })} aria-label="Study tools" />
        </Row>
      </Card>
    </Group>
  );
}

function AgentsGroup({ space }: { space: SpaceView }) {
  const ws = useLoad(() => getWorkspace(space.id), [space.id]);
  const fa = useLoad(fullAccessList);
  const [busy, setBusy] = useState<"choose" | "clear" | "access" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const wsWaiting = useDelayed(ws.loading && !ws.data);
  const on = fa.data?.includes(space.id) ?? false;

  const choose = async () => {
    setBusy("choose");
    setError(null);
    try {
      const pick = await chooseWorkspace();
      if (pick) ws.setData(await bindWorkspace(space.id, pick.token));
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const clear = async () => {
    setBusy("clear");
    setError(null);
    try {
      ws.setData(await clearWorkspace(space.id));
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const access = async (next: boolean) => {
    setBusy("access");
    try {
      await setFullAccess(space.id, next);
      await fa.reload();
    } catch (e) {
      toast.error("Couldn’t change full access", cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const w = ws.data;
  return (
    <Group label="Coding agents">
      <Card>
        <Row
          label="Working folder"
          description={
            w ? (
              <span className="flex min-w-0 flex-col gap-0.5">
                <StartTruncate value={w.path} className="font-mono text-[11px]" />
                {!w.available ? (
                  <span className="flex items-center gap-1 text-warning-foreground">
                    <TriangleAlertIcon className="size-3 shrink-0" />
                    This folder is missing. Choose it again or use Phaethon’s folder.
                  </span>
                ) : w.kind === "managed" ? (
                  <span>Phaethon’s own folder for this space</span>
                ) : null}
              </span>
            ) : ws.error ? (
              <RowError message="Couldn’t read the working folder" onRetry={() => void ws.reload()} />
            ) : wsWaiting ? (
              <SkeletonRows count={1} className="-mx-2 [&>div]:h-4" />
            ) : null
          }
          below={error ? <FieldError>{error}</FieldError> : undefined}
        >
          {w?.kind === "folder" ? (
            <Button size="xs" variant="ghost" onClick={() => void clear()} disabled={busy !== null}>
              {busy === "clear" ? <Spinner /> : null}
              Use Phaethon’s folder
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={() => void choose()} disabled={busy !== null || !w} className="min-w-[5.5rem]">
            {busy === "choose" ? <Spinner /> : null}
            {busy === "choose" ? "Choosing…" : "Choose…"}
          </Button>
        </Row>
        <Row
          label="Full access"
          description={on ? "Coding agents can change files and run commands anywhere on this computer." : "Coding agents can read this space and write only where you allow."}
          below={fa.error ? <RowError message="Couldn’t read full access" onRetry={() => void fa.reload()} /> : undefined}
        >
          {busy === "access" ? <Spinner size="sm" tone="muted" /> : null}
          <Switch checked={on} disabled={busy === "access" || !fa.data} onCheckedChange={(next) => (next ? setConfirm(true) : void access(false))} aria-label="Full access" />
        </Row>
      </Card>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Give coding agents full access in ${space.name}?`} confirm="Turn on full access" destructive onConfirm={() => void access(true)}>
        <p>Claude Code, Codex and Gemini CLI run without Phaethon’s walls in this space: they can edit and delete files, run any command, and reach folders outside the space.</p>
        <p>Phaethon’s own agent isn’t affected. The setting stays on this computer and isn’t synced with your vault.</p>
      </ConfirmDialog>
    </Group>
  );
}

function GrantsGroup({ space, spaces }: { space: SpaceView; spaces: SpaceView[] }) {
  const grants = useLoad(() => listGrants(space.id), [space.id]);
  const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  const hueOf = (id: string) => spaces.find((s) => s.id === id)?.hue ?? 0;
  const revoke = async (id: string, what: string) => {
    try {
      await revokeGrant(id);
      await grants.reload();
      toast.show({
        type: "success",
        title: "Access removed",
        description: what,
        timeout: 8000,
        action: {
          label: "Undo",
          onClick: () =>
            void restoreGrant(id).then(
              () => grants.reload(),
              (e) => toast.error("Couldn’t put the access back", cleanMessage(e)),
            ),
        },
      });
    } catch (e) {
      toast.error("Couldn’t remove the access", cleanMessage(e));
    }
  };
  return (
    <Group label="Access between spaces">
      <Loader state={grants} errorTitle="Couldn’t read the access list" skeleton={<SkeletonCard rows={2} />}>
        {(g) => {
          const rows = [
            ...g.grants.map((x) => ({ id: x.id, other: x.from, path: x.path, text: `Reads from ${nameOf(x.from)}` })),
            ...g.incoming.map((x) => ({ id: x.id, other: x.to, path: x.path, text: `${nameOf(x.to)} reads from here` })),
          ];
          return (
            <Card>
              {rows.length === 0 ? (
                <div className="px-3.5 py-6 text-center text-muted-foreground text-xs">No other space can read this one, and it reads none. Access is asked for in a chat when needed.</div>
              ) : (
                rows.map((r) => (
                  <div key={r.id} className="flex min-h-11 items-center gap-2.5 px-3.5 py-2">
                    <SpaceAvatar name={nameOf(r.other)} hue={hueOf(r.other)} />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <Truncate className="text-sm">{r.text}</Truncate>
                      <StartTruncate value={r.path} className="font-mono text-[11px] text-muted-foreground" />
                    </div>
                    <Button size="xs" variant="ghost-destructive" onClick={() => void revoke(r.id, `${r.text}: ${r.path}`)}>
                      Remove
                    </Button>
                  </div>
                ))
              )}
              {g.problems.length ? (
                <div className="flex flex-col gap-1 bg-warning-surface px-3.5 py-2.5 text-warning-foreground text-xs">
                  {g.problems.map((p) => (
                    <span key={p} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
                      <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
                      {p}
                    </span>
                  ))}
                </div>
              ) : null}
            </Card>
          );
        }}
      </Loader>
    </Group>
  );
}

function ExportGroup({ space }: { space: SpaceView }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.exportSpace(space.id);
      if (r)
        toast.show({
          type: "success",
          title: `Exported ${space.name}`,
          description: `${r.fileName} · ${r.files} ${r.files === 1 ? "file" : "files"}`,
          action: { label: "Show file", onClick: () => void api.showExport().catch((e) => toast.error("Couldn’t show the file", cleanMessage(e))) },
        });
    } catch (e) {
      toast.error(`Couldn’t export ${space.name}`, cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Group label="Export">
      <Card>
        <Row label="Export space" description="A zip of its files, conversations and memory.">
          <Button size="xs" variant="outline" onClick={() => void run()} disabled={busy} className="min-w-24">
            {busy ? <Spinner /> : null}
            {busy ? "Exporting…" : "Export…"}
          </Button>
        </Row>
        <Row label="Space folder" description="Open it in your file manager.">
          <Button size="xs" variant="outline" onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", cleanMessage(e)))}>
            Show
          </Button>
        </Row>
      </Card>
    </Group>
  );
}

function SpaceDetail({ space, spaces, onBack }: { space: SpaceView; spaces: SpaceView[]; onBack: () => void }) {
  useCrumb({ label: space.name, onBack });
  return (
    <>
      <IdentityGroup space={space} />
      <AgentsGroup space={space} />
      <GrantsGroup space={space} spaces={spaces} />
      <ExportGroup space={space} />
    </>
  );
}

export function SpacesSection() {
  const spaces = useNav((s) => s.spaces);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const back = useCallback(() => setEditing(null), []);
  const waiting = useDelayed(spaces.loading && !spaces.data);
  const list = spaces.data ?? [];
  const current = editing ? list.find((s) => s.id === editing) : undefined;

  if (current) return <SpaceDetail key={current.id} space={current} spaces={list} onBack={back} />;

  return (
    <Group
      label="Spaces"
      action={
        spaces.data ? (
          <Button size="xs" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New space
          </Button>
        ) : null
      }
    >
      {spaces.error && !spaces.data ? (
        <SurfaceError title="Couldn’t load your spaces" message={spaces.error} onRetry={() => void refreshSpaces()} />
      ) : !spaces.data ? (
        waiting ? <SkeletonCard rows={3} /> : null
      ) : list.length === 0 ? (
        <Card>
          <Empty className="py-10">
            <EmptyHeader>
              <EmptyTitle className="text-sm">No spaces yet</EmptyTitle>
              <EmptyDescription className="text-xs">A space keeps its own files, conversations and memory.</EmptyDescription>
            </EmptyHeader>
            <Button size="xs" onClick={() => setCreating(true)}>
              <PlusIcon />
              New space
            </Button>
          </Empty>
        </Card>
      ) : (
        <Card>
          {list.map((s) => (
            <button key={s.id} type="button" onClick={() => setEditing(s.id)} className="group flex min-h-11 w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-accent/50">
              <SpaceAvatar name={s.name} hue={s.hue} className="size-7 rounded-md text-xs" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <Truncate className="min-w-0 font-medium text-sm">{s.name}</Truncate>
                  {s.educationEnabled ? <span className="shrink-0 text-2xs text-muted-foreground">Study tools</span> : null}
                </span>
                {s.description ? <Truncate className="text-muted-foreground text-xs">{s.description}</Truncate> : <span className="text-subtle-foreground text-xs">No description</span>}
              </span>
              <ChevronRightIcon className="size-4 shrink-0 text-subtle-foreground transition-colors group-hover:text-foreground" strokeWidth={1.75} />
            </button>
          ))}
        </Card>
      )}
      <NewSpace open={creating} onOpenChange={setCreating} onCreated={(s) => setEditing(s.id)} />
    </Group>
  );
}
