import { useCallback, useEffect, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { HUES } from "@/app/NewSpaceDialog";
import { useNav } from "@/app/store";
import { EmptyState, FieldError, RowError, SurfaceError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard, SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { StartTruncate, Truncate } from "@/components/truncate";
import { AsyncButton } from "@/components/async-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ToggleRow } from "@/components/ui/toggle-row";
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
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, SwitchRow, useCrumb, useLoad } from "../ui";

/**
 * Settings › Spaces: the list of spaces, and per space its name,
 * description, colour and study tools; the folder coding agents work in;
 * full access; which other spaces it reads or is read by; and export.
 */

const refreshSpaces = () => useNav.getState().loadSpaces();

function Swatches({ value, onChange, disabled, small }: { value: number; onChange: (h: number) => void; disabled?: boolean; small?: boolean }) {
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
          className={cn("rounded-full ring-offset-2 ring-offset-card transition-shadow disabled:opacity-60", small ? "size-4.5" : "size-6", h === value && "ring-2 ring-primary")}
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
          <ToggleRow title="Study tools" description="Courses, flashcards, quizzes, grades and a study plan." checked={edu} onCheckedChange={setEdu} />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} pending={busy}>
            Create space
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** A text field that saves on Enter or when it loses focus. */
function SavedField({ id, value, placeholder, maxLength, onSave, className }: { id: string; value: string; placeholder?: string; maxLength: number; onSave: (v: string) => Promise<void>; className?: string }) {
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
    <div className={cn("flex flex-col gap-1.5", className)}>
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
    <SettingsGroup label="Space">
      <Row label="Name" htmlFor={`name-${space.id}`}>
        <SavedField id={`name-${space.id}`} className="w-64" value={space.name} maxLength={60} onSave={(name) => update({ name })} />
      </Row>
      <Row label="Description" htmlFor={`desc-${space.id}`}>
        <SavedField id={`desc-${space.id}`} className="w-64" value={space.description} placeholder="What this space is for" maxLength={200} onSave={(description) => update({ description })} />
      </Row>
      <Row label="Colour" below={busy === "hue" && error ? <FieldError>{error}</FieldError> : undefined}>
        {busy === "hue" ? <Spinner size="sm" tone="muted" /> : null}
        <Swatches small value={space.hue} disabled={busy === "hue"} onChange={(hue) => void quick("hue", { hue })} />
      </Row>
      <SwitchRow
        label="Study tools"
        description="Courses, flashcards, quizzes, grades and a study plan."
        checked={space.educationEnabled}
        pending={busy === "edu"}
        onCheckedChange={(on) => void quick("edu", { educationEnabled: on })}
        below={busy !== "hue" && error ? <FieldError>{error}</FieldError> : undefined}
      />
    </SettingsGroup>
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
    <SettingsGroup label="Coding agents">
      <Row
        label="Working folder"
        description={
          w ? (
            <span className="flex min-w-0 flex-col gap-0.5">
              <StartTruncate value={w.path} className="font-mono" />
              {!w.available ? (
                <span className="flex items-center gap-1 text-warning-foreground">
                  <Icon icon={icons.warning} className="size-3" />
                  This folder is missing. Choose it again or use Phaethon’s folder.
                </span>
              ) : null}
            </span>
          ) : ws.error ? (
            <RowError message="Couldn’t read the working folder" onRetry={() => void ws.reload()} />
          ) : wsWaiting ? (
            <SkeletonRows count={1} className="-mx-2 [&>div]:h-4" />
          ) : null
        }
        below={<FieldError>{error}</FieldError>}
      >
        {w?.kind === "folder" ? (
          <Button size="xs" variant="ghost" onClick={() => void clear()} disabled={busy !== null} pending={busy === "clear"}>
            Use Phaethon’s folder
          </Button>
        ) : null}
        <Button size="xs" variant="outline" onClick={() => void choose()} disabled={!w || (busy !== null && busy !== "choose")} pending={busy === "choose"}>
          Choose…
        </Button>
      </Row>
      <SwitchRow
        label="Full access"
        description={on ? "Coding agents can change files and run commands anywhere on this computer." : "Coding agents can read this space and write only where you allow."}
        checked={on}
        disabled={!fa.data}
        pending={busy === "access"}
        onCheckedChange={(next) => (next ? setConfirm(true) : void access(false))}
        below={fa.error ? <RowError message="Couldn’t read full access" onRetry={() => void fa.reload()} /> : undefined}
      />
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Give coding agents full access in ${space.name}?`} confirm="Turn on full access" destructive onConfirm={() => void access(true)}>
        <p>Claude Code, Codex and Gemini CLI run without Phaethon’s walls in this space: they can edit and delete files, run any command, and reach folders outside the space.</p>
        <p>Phaethon’s own agent isn’t affected. The setting stays on this computer and isn’t synced with your vault.</p>
      </ConfirmDialog>
    </SettingsGroup>
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
    <SettingsGroup label="Access between spaces" note="Asked for in a chat when one space needs another’s files.">
      <Loader state={grants} errorTitle="Couldn’t read the access list" skeleton={<SkeletonCard rows={2} className="rounded-none border-0" />}>
        {(g) => {
          const rows = [
            ...g.grants.map((x) => ({ id: x.id, other: x.from, path: x.path, text: `Reads from ${nameOf(x.from)}` })),
            ...g.incoming.map((x) => ({ id: x.id, other: x.to, path: x.path, text: `${nameOf(x.to)} reads from here` })),
          ];
          return (
            <>
              {rows.length === 0 ? (
                <EmptyRow>No other space can read this one, and it reads none.</EmptyRow>
              ) : (
                rows.map((r) => (
                  <div key={r.id} className="flex min-h-10 items-center gap-3 px-3 py-1.5">
                    <SpaceAvatar name={nameOf(r.other)} hue={hueOf(r.other)} className="size-5 rounded-sm text-3xs" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <Truncate className="text-sm">{r.text}</Truncate>
                      <StartTruncate value={r.path} className="font-mono text-2xs text-muted-foreground" />
                    </div>
                    <Button size="xs" variant="ghost-destructive" onClick={() => void revoke(r.id, `${r.text}: ${r.path}`)}>
                      Remove
                    </Button>
                  </div>
                ))
              )}
              {g.problems.length ? (
                <div className="flex flex-col gap-1 bg-warning/8 px-3 py-2 text-warning-foreground text-xs">
                  {g.problems.map((p) => (
                    <span key={p} className="flex items-start gap-1.5 [overflow-wrap:anywhere]">
                      <Icon icon={icons.warning} className="mt-0.5 size-3" />
                      {p}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          );
        }}
      </Loader>
    </SettingsGroup>
  );
}

function WritesGroup({ space }: { space: SpaceView }) {
  const perms = useLoad(() => api.writePermissions(space.id), [space.id]);
  const revoke = async (what: string, change: { thread?: string; scope: "conversation" | "space" }) => {
    try {
      await api.setWritePermission({ space: space.id, ...change, allow: false });
      await perms.reload();
      toast.success("Phaethon will ask again", what);
    } catch (e) {
      toast.error("Couldn’t change that", cleanMessage(e));
    }
  };
  const since = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <SettingsGroup label="Changing files without asking">
      <Loader state={perms} errorTitle="Couldn’t read what may change files" skeleton={<SkeletonCard rows={1} className="rounded-none border-0" />}>
        {(p) => {
          const rows = [
            ...p.spaces.map((x) => ({ key: "space", label: `Every conversation in ${space.name}`, since: x.since, change: { scope: "space" as const } })),
            ...p.conversations.map((x) => ({ key: x.thread, label: x.title, since: x.since, change: { scope: "conversation" as const, thread: x.thread } })),
          ];
          return (
            <>
              {rows.length === 0 ? (
                <EmptyRow>Phaethon asks before it changes a file here.</EmptyRow>
              ) : (
                rows.map((r) => (
                  <div key={r.key} className="flex min-h-10 items-center gap-3 px-3 py-1.5">
                    <div className="flex min-w-0 flex-1 flex-col">
                      <Truncate className="text-sm">{r.label}</Truncate>
                      <span className="text-muted-foreground text-xs tabular-nums">Since {since(r.since)}</span>
                    </div>
                    <Button size="xs" variant="ghost-destructive" onClick={() => void revoke(r.label, r.change)}>
                      Ask again
                    </Button>
                  </div>
                ))
              )}
            </>
          );
        }}
      </Loader>
    </SettingsGroup>
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
    <SettingsGroup label="Files">
      <Row label="Export space" description="A zip of its files, conversations and memory.">
        <Button size="xs" variant="outline" onClick={() => void run()} pending={busy}>
          Export…
        </Button>
      </Row>
      <Row label="Space folder">
        <AsyncButton size="xs" variant="outline" action={() => api.showSpace(space.id)} failure="Couldn’t show the folder">
          Show
        </AsyncButton>
      </Row>
    </SettingsGroup>
  );
}

function SpaceDetail({ space, spaces, onBack }: { space: SpaceView; spaces: SpaceView[]; onBack: () => void }) {
  useCrumb({ label: space.name, onBack });
  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className="-mb-3 flex h-7 items-center gap-1.5 self-start rounded-md px-1 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon icon={icons.arrowLeft} className="size-4" />
        Spaces
      </button>
      <IdentityGroup space={space} />
      <AgentsGroup space={space} />
      <GrantsGroup space={space} spaces={spaces} />
      <WritesGroup space={space} />
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

  const add = (
    <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
      <Icon icon={icons.add} />
      New space
    </Button>
  );

  return (
    <>
      {spaces.error && !spaces.data ? (
        <SurfaceError title="Couldn’t load your spaces" message={spaces.error} onRetry={() => void refreshSpaces()} />
      ) : !spaces.data ? (
        waiting ? <SkeletonCard rows={3} className="rounded-card" /> : null
      ) : list.length === 0 ? (
        <EmptyState
          palette="meadow"
          seed="spaces"
          title="No spaces yet"
          description="A space keeps its own files, conversations and memory."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              <Icon icon={icons.add} />
              New space
            </Button>
          }
          className="max-w-none"
        />
      ) : (
        <SettingsGroup label="Spaces" action={add}>
          {list.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setEditing(s.id)}
              className="group flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <SpaceAvatar name={s.name} hue={s.hue} className="size-6 rounded-md text-2xs" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-2">
                  <Truncate className="min-w-0 text-sm">{s.name}</Truncate>
                  {s.educationEnabled ? <span className="shrink-0 rounded-sm bg-primary/8 px-1.5 text-primary text-2xs leading-4">Study tools</span> : null}
                </span>
                {s.description ? <Truncate className="text-muted-foreground text-xs">{s.description}</Truncate> : null}
              </span>
              <Icon icon={icons.chevronRight} className="size-4 text-subtle-foreground transition-[color,translate] group-hover:translate-x-0.5 group-hover:text-foreground" />
            </button>
          ))}
        </SettingsGroup>
      )}
      <NewSpace open={creating} onOpenChange={setCreating} onCreated={(s) => setEditing(s.id)} />
    </>
  );
}
