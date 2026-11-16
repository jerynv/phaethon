import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { FieldError, RowError, cleanMessage } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard, SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ToggleRow } from "@/components/ui/toggle-row";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  addMemory,
  deleteMemory,
  getProfiles,
  memoryItems,
  memorySettings,
  previewMemory,
  removeNotice,
  setMemorySettings,
  setProfile,
  updateMemory,
  type MemoryItem,
  type MemoryKind,
  type MemorySettings,
  type Preview,
  type ProfileDoc,
} from "@/features/life/api";
import { cn } from "@/lib/utils";
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, SwitchRow, useLoad, type Loaded } from "../ui";
import { SmallSelect, SpaceSelect, SpacesPicker, dayTime, fromLocalInput, shortDate, spaceName, toLocalInput, useSpaceList, type SpaceLite } from "./shared";

/**
 * Settings › Memory (docs/MEMORY-MAIL-AUTOMATIONS.md): what agents may keep
 * and share, the profiles they read, the front burner and its archive, and a
 * box that shows what a message would bring up.
 */

const KIND: Record<MemoryKind, { icon: IconData; label: string }> = {
  event: { icon: icons.event, label: "Event" },
  state: { icon: icons.time, label: "State" },
  task: { icon: icons.check, label: "Task" },
  note: { icon: icons.memory, label: "Note" },
};

const STATUS: Record<MemoryItem["status"], string> = {
  active: "Active",
  done: "Done",
  expired: "Expired",
  dismissed: "Dismissed",
};

function KindIcon({ kind }: { kind: MemoryKind }) {
  return (
    <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
      <Icon icon={KIND[kind].icon} label={KIND[kind].label} className="size-4" />
    </span>
  );
}

// ---- Privacy ------------------------------------------------------------------

const ARCHIVE = [30, 90, 365, 0];
const GRACE = [1, 3, 7];
const daysLabel = (n: number) => (n === 0 ? "Forever" : n === 365 ? "1 year" : `${n} ${n === 1 ? "day" : "days"}`);

function PrivacyGroup({ spaces, state }: { spaces: SpaceLite[]; state: Loaded<MemorySettings> }) {
  const [pending, setPending] = useState<keyof MemorySettings | null>(null);
  const save = async (key: keyof MemorySettings, patch: Partial<MemorySettings>) => {
    const before = state.data;
    if (!before) return;
    state.setData({ ...before, ...patch });
    setPending(key);
    try {
      state.setData(await setMemorySettings(patch));
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t change that", cleanMessage(e));
    } finally {
      setPending(null);
    }
  };
  return (
    <SettingsGroup label="Privacy">
      <Loader state={state} errorTitle="Couldn’t read the memory settings" skeleton={<SkeletonRows count={4} className="px-3 py-2" />}>
        {(s) => {
          const archive = ARCHIVE.includes(s.archiveDays) ? ARCHIVE : [...ARCHIVE.slice(0, -1), s.archiveDays, 0];
          const grace = GRACE.includes(s.eventGraceDays) ? GRACE : [...GRACE, s.eventGraceDays].sort((a, b) => a - b);
          return (
            <>
              <SwitchRow label="Let agents remember things" checked={s.capture} pending={pending === "capture"} onCheckedChange={(v) => void save("capture", { capture: v })} />
              <SwitchRow
                label="Review conversations once a day"
                description="Reads changed conversations with your model to keep memory current, including coding-agent chats."
                checked={s.review}
                pending={pending === "review"}
                onCheckedChange={(v) => void save("review", { review: v })}
              />
              <SwitchRow
                label="Let agents add to your profile"
                checked={s.profileLearning}
                pending={pending === "profileLearning"}
                onCheckedChange={(v) => void save("profileLearning", { profileLearning: v })}
              />
              <SwitchRow
                label="Share life events across spaces"
                description="Things that touch every space, like being sick or travelling."
                checked={s.shareAcrossSpaces}
                pending={pending === "shareAcrossSpaces"}
                onCheckedChange={(v) => void save("shareAcrossSpaces", { shareAcrossSpaces: v })}
              />
              {s.shareAcrossSpaces ? (
                <Row label="Spaces kept out" description="Never get life events from other spaces.">
                  <SpacesPicker
                    value={s.isolatedSpaces}
                    spaces={spaces}
                    label="Spaces kept out of shared life events"
                    empty="Add a space"
                    disabled={pending === "isolatedSpaces"}
                    onChange={(next) => void save("isolatedSpaces", { isolatedSpaces: next })}
                  />
                </Row>
              ) : null}
              <Row label="Keep closed memories">
                <SmallSelect
                  value={String(s.archiveDays)}
                  label="Keep closed memories"
                  className="w-32"
                  disabled={pending === "archiveDays"}
                  options={archive.map((n) => ({
                    value: String(n),
                    label: daysLabel(n),
                  }))}
                  onChange={(v) => void save("archiveDays", { archiveDays: Number(v) })}
                />
              </Row>
              <Row label="Wait for an outcome" description="How long a past event stays open for you to say how it went.">
                <Tabs value={String(s.eventGraceDays)} onValueChange={(v) => void save("eventGraceDays", { eventGraceDays: Number(v) })}>
                  <TabsList size="sm" aria-label="Wait for an outcome">
                    {grace.map((n) => (
                      <TabsTab key={n} value={String(n)} disabled={pending === "eventGraceDays"}>
                        {daysLabel(n)}
                      </TabsTab>
                    ))}
                  </TabsList>
                </Tabs>
              </Row>
            </>
          );
        }}
      </Loader>
    </SettingsGroup>
  );
}

// ---- Profiles -----------------------------------------------------------------

function ProfileEditor({ doc, scope, label, placeholder, onChanged }: { doc: ProfileDoc; scope: string; label: string; placeholder: string; onChanged: () => Promise<void> }) {
  // `base` is what's saved: it moves the moment a save returns, so the editor never flashes "Unsaved changes" while the page reloads.
  const [base, setBase] = useState(doc.mine);
  const [draft, setDraft] = useState(doc.mine);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const dirty = draft !== base;
  // A reload (a line removed, an agent added one) refreshes the editor unless there's unsaved text in it.
  useEffect(() => {
    if (dirty || saving) return;
    setBase(doc.mine);
    setDraft(doc.mine);
  }, [doc.mine]);
  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), 1200);
    return () => clearTimeout(t);
  }, [saved]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await setProfile(scope, draft);
      setBase(r.mine);
      setDraft(r.mine);
      setSaved(true);
      void onChanged();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (line: string) => {
    setRemoving(line);
    try {
      await removeNotice(scope, line);
      await onChanged();
    } catch (e) {
      toast.error("Couldn’t remove that line", cleanMessage(e));
    } finally {
      setRemoving(null);
    }
  };
  return (
    <>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <Textarea
          aria-label={label}
          value={draft}
          rows={8}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          className="text-sm"
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "s" && (e.metaKey || e.ctrlKey) && dirty) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <FieldError>{error}</FieldError>
        <div className="flex min-h-7 flex-wrap items-center justify-end gap-2">
          {dirty ? <span className="me-auto text-muted-foreground text-xs">Unsaved changes</span> : null}
          {dirty ? (
            <Button size="xs" variant="ghost" onClick={() => setDraft(base)} disabled={saving}>
              Revert
            </Button>
          ) : null}
          <Button size="xs" onClick={() => void save()} disabled={!dirty && !saved} pending={saving} success={saved}>
            Save
          </Button>
        </div>
      </div>
      {doc.noticed.length ? (
        <div className="flex flex-col">
          <h3 className="flex h-8 items-end px-3 pb-1 type-label">What agents have noticed</h3>
          {doc.noticed.map((line) => (
            <div key={line} className="flex min-h-9 items-center gap-3 px-3 py-1.5">
              <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{line}</span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost-destructive"
                      aria-label={`Remove “${line}”`}
                      disabled={dirty || removing !== null}
                      pending={removing === line}
                      onClick={() => void remove(line)}
                    />
                  }
                >
                  <Icon icon={icons.close} />
                </TooltipTrigger>
                <TooltipPopup>{dirty ? "Save or revert your changes first" : "Remove"}</TooltipPopup>
              </Tooltip>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function ProfilesGroups({
  spaces,
  vault,
  own,
  chosen,
  setSpace,
}: {
  spaces: SpaceLite[];
  vault: Loaded<{ vault: ProfileDoc; space?: ProfileDoc }>;
  own: Loaded<{ vault: ProfileDoc; space?: ProfileDoc } | null>;
  chosen: string | null;
  setSpace: (s: string) => void;
}) {
  return (
    <>
      <SettingsGroup label="About you">
        <Loader state={vault} errorTitle="Couldn’t read your profile" skeleton={<SkeletonCard rows={3} className="rounded-none border-0" />}>
          {(p) => <ProfileEditor doc={p.vault} scope="vault" label="About you" placeholder="Who you are, how you work, what agents should know in every space." onChanged={vault.reload} />}
        </Loader>
      </SettingsGroup>
      {spaces.length ? (
        <SettingsGroup label="In a space" action={<SpaceSelect value={chosen} onChange={setSpace} spaces={spaces} label="Space profile" className="h-7 w-36 sm:min-h-6" />}>
          <Loader state={own} errorTitle="Couldn’t read the space’s profile" skeleton={<SkeletonCard rows={3} className="rounded-none border-0" />}>
            {(p) =>
              p?.space && chosen ? (
                <ProfileEditor
                  key={chosen}
                  doc={p.space}
                  scope={chosen}
                  label={`How to act in ${spaceName(spaces, chosen)}`}
                  placeholder={`How agents should act in ${spaceName(spaces, chosen)}: the role, who you write to, how formal to be.`}
                  onChanged={own.reload}
                />
              ) : (
                <EmptyRow>Choose a space.</EmptyRow>
              )
            }
          </Loader>
        </SettingsGroup>
      ) : null}
    </>
  );
}

// ---- Front burner and archive -------------------------------------------------

function timeChip(i: MemoryItem, now: number) {
  if (i.kind === "event" && i.when !== undefined && i.when < now)
    return (
      <>
        <Badge variant="secondary" className="font-normal tabular-nums">
          {dayTime(i.when, now)}
        </Badge>
        <Badge variant="warning">Waiting for how it went</Badge>
      </>
    );
  if (i.when !== undefined)
    return (
      <Badge variant="secondary" className="font-normal tabular-nums">
        {dayTime(i.when, now)}
      </Badge>
    );
  if (i.until !== undefined)
    return (
      <Badge variant="secondary" className="font-normal tabular-nums">
        until {dayTime(i.until, now)}
      </Badge>
    );
  return null;
}

function Meta({ item, spaces, now, children }: { item: MemoryItem; spaces: SpaceLite[]; now: number; children?: ReactNode }) {
  const s = spaces.find((x) => x.id === item.space);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
      {children ?? timeChip(item, now)}
      <span className="flex min-w-0 items-center gap-1.5">
        <SpaceAvatar hue={s?.hue ?? 0} />
        <span className="truncate">{s?.name ?? item.space}</span>
      </span>
      {item.scope === "vault" ? <Badge variant="info">Shared</Badge> : null}
    </div>
  );
}

type Editing = { mode: "add" } | { mode: "edit"; item: MemoryItem };

function ItemDialog({ editing, spaces, onOpenChange, onSaved }: { editing: Editing | null; spaces: SpaceLite[]; onOpenChange: (o: boolean) => void; onSaved: () => Promise<void> }) {
  const active = useNav((s) => s.activeSpace);
  const item = editing?.mode === "edit" ? editing.item : undefined;
  const [kind, setKind] = useState<MemoryKind>("event");
  const [text, setText] = useState("");
  const [time, setTime] = useState("");
  const [space, setSpace] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing) return;
    setError(null);
    if (item) {
      setKind(item.kind);
      setText(item.text);
      setTime(toLocalInput(item.kind === "state" ? item.until : item.when));
      setSpace(item.space);
      setShared(item.scope === "vault");
    } else {
      setKind("event");
      setText("");
      setTime("");
      setSpace(spaces.some((s) => s.id === active) ? active : (spaces[0]?.id ?? null));
      setShared(false);
    }
  }, [editing]);
  const timeLabel = kind === "state" ? "Until" : kind === "task" ? "Due" : kind === "event" ? "When" : null;
  const submit = async () => {
    if (!text.trim()) return setError("Write what to remember.");
    if (kind === "event" && !time) return setError("An event needs a time.");
    if (!space) return setError("Choose a space.");
    const iso = fromLocalInput(time);
    setBusy(true);
    setError(null);
    try {
      if (item) {
        const field = item.kind === "state" ? "until" : "when";
        await updateMemory(item.id, {
          text: text.trim(),
          scope: shared ? "vault" : "space",
          ...(timeLabel ? { [field]: iso ?? null } : {}),
        });
      } else {
        await addMemory({
          space,
          kind,
          text: text.trim(),
          scope: shared ? "vault" : "space",
          ...(timeLabel && iso ? (kind === "state" ? { until: iso } : { when: iso }) : {}),
        });
      }
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!editing} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{item ? "Edit memory" : "Add a memory"}</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {item ? null : (
            <Tabs value={kind} onValueChange={(v) => setKind(v as MemoryKind)}>
              <TabsList aria-label="Kind" className="self-start">
                {(Object.keys(KIND) as MemoryKind[]).map((k) => (
                  <TabsTab key={k} value={k}>
                    <Icon icon={KIND[k].icon} />
                    {KIND[k].label}
                  </TabsTab>
                ))}
              </TabsList>
            </Tabs>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="memory-text">What to remember</Label>
            <Textarea
              id="memory-text"
              autoFocus
              rows={2}
              value={text}
              maxLength={600}
              placeholder={kind === "event" ? "Team meeting with Dana" : kind === "state" ? "Home sick, not going in" : kind === "task" ? "Send Dana the slides" : "Prefers written check-ins"}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          {timeLabel ? (
            <div className="flex flex-col items-start gap-1.5">
              <Label htmlFor="memory-time">{timeLabel}</Label>
              <Input id="memory-time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} className="w-56" />
            </div>
          ) : null}
          {item ? null : (
            <div className="flex flex-col items-start gap-1.5">
              <Label>Space</Label>
              <SpaceSelect value={space} onChange={setSpace} spaces={spaces} className="w-56" />
            </div>
          )}
          <ToggleRow title="Share across spaces" description="For things that touch every space, like being sick." checked={shared} onCheckedChange={setShared} className="py-0" />
          <FieldError>{error}</FieldError>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} pending={busy}>
            {item ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DoneDialog({ item, onOpenChange, onDone }: { item: MemoryItem | null; onOpenChange: (o: boolean) => void; onDone: (outcome: string) => Promise<void> }) {
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setOutcome(""), [item]);
  const submit = async () => {
    setBusy(true);
    try {
      await onDone(outcome.trim());
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Mark as done</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-1.5">
          <Label htmlFor="memory-outcome">How did it go?</Label>
          <Input
            id="memory-outcome"
            autoFocus
            value={outcome}
            maxLength={300}
            placeholder="Optional"
            onChange={(e) => setOutcome(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} pending={busy}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ItemsGroups({ spaces, items }: { spaces: SpaceLite[]; items: Loaded<MemoryItem[]> }) {
  const openThread = useNav((s) => s.openThread);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [finishing, setFinishing] = useState<MemoryItem | null>(null);
  const [deleting, setDeleting] = useState<MemoryItem | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const now = Date.now();

  const change = async (item: MemoryItem, patch: Parameters<typeof updateMemory>[1], failure: string) => {
    setBusy(item.id);
    try {
      await updateMemory(item.id, patch);
      await items.reload();
    } catch (e) {
      toast.error(failure, cleanMessage(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (item: MemoryItem) => {
    await change(item, { status: "dismissed" }, "Couldn’t dismiss that").catch(() => {});
    toast.show({
      type: "success",
      title: "Dismissed",
      description: item.text,
      timeout: 8000,
      action: {
        label: "Undo",
        onClick: () => void change(item, { status: "active" }, "Couldn’t bring it back").catch(() => {}),
      },
    });
  };
  // A state (sick, travelling) just ends; there's nothing to ask about how it went.
  const end = async (item: MemoryItem) => {
    await change(item, { status: "done" }, "Couldn’t end that").catch(() => {});
    toast.show({
      type: "success",
      title: "Ended",
      description: item.text,
      timeout: 8000,
      action: { label: "Undo", onClick: () => void change(item, { status: "active" }, "Couldn’t bring it back").catch(() => {}) },
    });
  };
  const remove = async (item: MemoryItem) => {
    setBusy(item.id);
    try {
      await deleteMemory(item.id);
      await items.reload();
    } catch (e) {
      toast.error("Couldn’t delete that", cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const add = (
    <Button size="xs" variant="ghost" onClick={() => setEditing({ mode: "add" })} disabled={!spaces.length}>
      <Icon icon={icons.add} />
      Add
    </Button>
  );

  return (
    <>
      <SettingsGroup label="Front burner" action={add}>
        <Loader state={items} errorTitle="Couldn’t read your memories" skeleton={<SkeletonCard rows={3} className="rounded-none border-0" />}>
          {(all) => {
            const open = all.filter((i) => i.status === "active");
            if (!open.length) return <EmptyRow>Nothing on the front burner.</EmptyRow>;
            return open.map((i) => (
              <div key={i.id} className="flex min-h-11 items-start gap-3 px-3 py-2">
                <KindIcon kind={i.kind} />
                <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                  <p className="text-sm [overflow-wrap:anywhere]">{i.text}</p>
                  <Meta item={i} spaces={spaces} now={now} />
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  {i.kind === "event" || i.kind === "task" ? (
                    <Button size="xs" variant="outline" onClick={() => setFinishing(i)} disabled={busy === i.id}>
                      Done
                    </Button>
                  ) : i.kind === "state" ? (
                    <Button size="xs" variant="outline" onClick={() => void end(i)} disabled={busy === i.id}>
                      End now
                    </Button>
                  ) : null}
                  <Menu>
                    <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`More for “${i.text}”`} pending={busy === i.id} />}>
                      <Icon icon={icons.more} />
                    </MenuTrigger>
                    <MenuPopup align="end" className="w-44">
                      <MenuItem onClick={() => setEditing({ mode: "edit", item: i })}>
                        <Icon icon={icons.edit} />
                        Edit
                      </MenuItem>
                      <MenuItem onClick={() => void dismiss(i)}>
                        <Icon icon={icons.close} />
                        Dismiss
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem variant="destructive" onClick={() => setDeleting(i)}>
                        <Icon icon={icons.delete} />
                        Delete
                      </MenuItem>
                    </MenuPopup>
                  </Menu>
                </div>
              </div>
            ));
          }}
        </Loader>
      </SettingsGroup>

      {items.data?.some((i) => i.status !== "active") ? (
        <SettingsGroup>
          <Collapsible open={archiveOpen} onOpenChange={setArchiveOpen}>
            <CollapsibleTrigger
              render={<button type="button" />}
              className="group flex min-h-10 w-full items-center gap-3 px-3 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
                <Icon icon={icons.archive} className="size-4" />
              </span>
              <span className="flex-1">Archive</span>
              <span className="type-meta">{items.data.filter((i) => i.status !== "active").length}</span>
              <Icon icon={icons.chevronDown} className="-rotate-90 size-4 text-subtle-foreground transition-transform group-data-panel-open:rotate-0" />
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="divide-y border-t">
                {items.data
                  .filter((i) => i.status !== "active")
                  .sort((a, b) => (b.closed ?? b.updated) - (a.closed ?? a.updated))
                  .map((i) => (
                    <div key={i.id} className="flex min-h-11 items-start gap-3 px-3 py-2">
                      <KindIcon kind={i.kind} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
                        <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">{i.text}</p>
                        <Meta item={i} spaces={spaces} now={now}>
                          <span className={cn("min-w-0 [overflow-wrap:anywhere]", i.status === "done" && "text-foreground")}>
                            {STATUS[i.status]}
                            {i.outcome ? `: ${i.outcome}` : ""}
                            {i.closed ? <span className="text-subtle-foreground tabular-nums"> · {shortDate(i.closed, now)}</span> : null}
                          </span>
                        </Meta>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5">
                        {i.source ? (
                          <Tooltip>
                            <TooltipTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label="Open conversation" onClick={() => void openThread(i.source!.space, i.source!.thread)} />}>
                              <Icon icon={icons.chat} />
                            </TooltipTrigger>
                            <TooltipPopup>Open conversation</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                size="icon-xs"
                                variant="ghost-muted"
                                aria-label={`Reopen “${i.text}”`}
                                pending={busy === i.id}
                                onClick={() => void change(i, { status: "active" }, "Couldn’t reopen that").catch(() => {})}
                              />
                            }
                          >
                            <Icon icon={icons.undo} />
                          </TooltipTrigger>
                          <TooltipPopup>Reopen</TooltipPopup>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger render={<Button size="icon-xs" variant="ghost-destructive" aria-label={`Delete “${i.text}”`} onClick={() => setDeleting(i)} />}>
                            <Icon icon={icons.delete} />
                          </TooltipTrigger>
                          <TooltipPopup>Delete</TooltipPopup>
                        </Tooltip>
                      </div>
                    </div>
                  ))}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </SettingsGroup>
      ) : null}

      <ItemDialog editing={editing} spaces={spaces} onOpenChange={(o) => !o && setEditing(null)} onSaved={items.reload} />
      <DoneDialog
        item={finishing}
        onOpenChange={(o) => !o && setFinishing(null)}
        onDone={async (outcome) => {
          if (finishing) await change(finishing, { status: "done", ...(outcome ? { outcome } : {}) }, "Couldn’t mark it done");
        }}
      />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} title="Delete this memory?" confirm="Delete" destructive onConfirm={() => deleting && void remove(deleting)}>
        <p className="[overflow-wrap:anywhere]">“{deleting?.text}” is gone for good, from the archive and from search.</p>
      </ConfirmDialog>
    </>
  );
}

// ---- Try a message ------------------------------------------------------------

function TryGroup({ spaces }: { spaces: SpaceLite[] }) {
  const active = useNav((s) => s.activeSpace);
  const [text, setText] = useState("");
  const [space, setSpace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    text: string;
    items: Preview[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = space ?? (spaces.some((s) => s.id === active) ? active : spaces[0]?.id) ?? null;
  const run = async () => {
    if (!text.trim() || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      setResult({
        text: text.trim(),
        items: await previewMemory(chosen, text.trim()),
      });
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!spaces.length) return null;
  return (
    <SettingsGroup label="Try a message" note="Shows which memories an agent would be given for it.">
      <form
        className="flex flex-wrap items-center gap-2 px-3 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <Input size="sm" value={text} aria-label="Message to try" placeholder="What’s my Saturday morning look like?" className="min-w-48 flex-1" onChange={(e) => setText(e.target.value)} />
        <SpaceSelect value={chosen} onChange={setSpace} spaces={spaces} label="Space to try it in" className="w-36" />
        <Button size="xs" variant="outline" type="submit" pending={busy} disabled={!text.trim()}>
          Try
        </Button>
      </form>
      {error ? <RowError message={error} onRetry={() => void run()} className="px-3 py-2" /> : null}
      {result && !error ? (
        result.items.length === 0 ? (
          <EmptyRow>Nothing would come up for this message.</EmptyRow>
        ) : (
          result.items.map((p) => (
            <div key={p.id} className="flex min-h-11 items-start gap-3 px-3 py-2">
              <KindIcon kind={p.kind} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                <p className="text-sm [overflow-wrap:anywhere]">{p.text}</p>
                {p.reasons.length ? <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{p.reasons.join(" · ")}</p> : null}
              </div>
              <span className="shrink-0 pt-1 type-meta" title="Relevance score">
                {p.score}
              </span>
            </div>
          ))
        )
      ) : null}
    </SettingsGroup>
  );
}

/**
 * Everything the page shows is loaded together and drawn once it's all in, so
 * no group arrives late and pushes the others down.
 */
export function MemorySection() {
  const spaces = useSpaceList();
  const active = useNav((s) => s.activeSpace);
  const [space, setSpace] = useState<string | null>(null);
  const chosen = space ?? (spaces.some((s) => s.id === active) ? active : spaces[0]?.id) ?? null;
  const settings = useLoad(memorySettings, [], "memory:settings");
  const vault = useLoad(() => getProfiles(), [], "memory:profile");
  const own = useLoad(() => (chosen ? getProfiles(chosen) : Promise.resolve(null)), [chosen], "memory:profile");
  const items = useLoad(() => memoryItems({ includeClosed: true }), [], "memory:items");
  const shown = useRef(false);
  const arrived = (l: { data: unknown; error: string | null }) => l.data !== undefined || !!l.error;
  if (!shown.current && !(arrived(settings) && arrived(vault) && arrived(items) && (arrived(own) || !chosen))) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading memory settings">
        <SkeletonCard rows={4} />
        <SkeletonCard rows={3} />
        <SkeletonCard rows={3} />
      </div>
    );
  }
  shown.current = true;
  return (
    <>
      <PrivacyGroup spaces={spaces} state={settings} />
      <ProfilesGroups spaces={spaces} vault={vault} own={own} chosen={chosen} setSpace={setSpace} />
      <ItemsGroups spaces={spaces} items={items} />
      <TryGroup spaces={spaces} />
    </>
  );
}
