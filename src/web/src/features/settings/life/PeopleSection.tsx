import { useCallback, useEffect, useMemo, useState } from "react";
import { useNav } from "@/app/store";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { createPerson, deletePerson, getPerson, listPeople, savePerson, type Interaction, type Person, type PersonListed } from "@/features/life/api";
import { cn } from "@/lib/utils";
import { ConfirmDialog, EmptyRow, Loader, Row, SettingsGroup, useCrumb, useLoad } from "../ui";
import { Avatar, ChipList, SpaceSelect, SpacesPicker, shortDate, useSpaceList, type SpaceLite } from "./shared";

/**
 * Settings › People: one card per person (names and aliases, how you know
 * them, how to reach them, which spaces may see them, notes on the dynamic)
 * and what has passed between you, across chat and mail.
 */

const SOURCE: Partial<Record<Person["source"], string>> = {
  mail: "Added from mail",
  agent: "Added by an agent",
  review: "Added by a review",
};

const CHANNEL: Record<Interaction["channel"], { icon: IconData; label: string }> = {
  email: { icon: icons.mail, label: "Email" },
  chat: { icon: icons.chat, label: "Chat" },
  meeting: { icon: icons.event, label: "Meeting" },
  call: { icon: icons.message, label: "Call" },
  message: { icon: icons.message, label: "Message" },
  other: { icon: icons.time, label: "Other" },
};

const SEARCH_FROM = 6;
const HISTORY_PAGE = 30;

const subtitle = (p: Pick<Person, "relation" | "org" | "title">) => [p.relation, p.title && p.org ? `${p.title}, ${p.org}` : (p.org ?? p.title)].filter(Boolean).join(" · ");

function matches(p: PersonListed, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [p.name, ...p.aliases, p.relation, p.org, p.title, ...p.emails].some((x) => x?.toLowerCase().includes(s));
}

// ---- New person ---------------------------------------------------------------

function NewPerson({ open, onOpenChange, spaces, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; spaces: SpaceLite[]; onCreated: (p: Person) => void }) {
  const active = useNav((s) => s.activeSpace);
  const [name, setName] = useState("");
  const [space, setSpace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName("");
    setError(null);
    setSpace(spaces.some((s) => s.id === active) ? active : (spaces[0]?.id ?? null));
  }, [open]);
  const submit = async () => {
    if (!name.trim()) return setError("Give them a name.");
    if (!space) return setError("Choose a space.");
    setBusy(true);
    setError(null);
    try {
      const p = await createPerson(name.trim(), space);
      onOpenChange(false);
      onCreated(p);
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
          <DialogTitle>Add person</DialogTitle>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="person-name">Name</Label>
            <Input
              id="person-name"
              autoFocus
              value={name}
              maxLength={120}
              placeholder="Dana Reyes"
              aria-invalid={error && !name.trim() ? true : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Seen in</Label>
            <SpaceSelect value={space} onChange={setSpace} spaces={spaces} className="w-full" />
          </div>
          <FieldError>{error}</FieldError>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void submit()} pending={busy}>
            Add person
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

// ---- Detail -------------------------------------------------------------------

/** A text field that saves on Enter or blur; Esc puts the saved value back. */
function SavedText({ id, value, placeholder, onSave, className, type }: { id: string; value: string; placeholder?: string; onSave: (v: string) => Promise<void>; className?: string; type?: string }) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const save = async () => {
    if (draft.trim() === value) return setDraft(value);
    setBusy(true);
    try {
      await onSave(draft.trim());
    } catch {
      setDraft(value);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("relative", className)}>
      <Input
        id={id}
        size="sm"
        type={type}
        value={draft}
        maxLength={200}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value);
        }}
        className={busy ? "pr-7" : undefined}
      />
      {busy ? <Spinner size="sm" tone="muted" className="absolute top-1/2 right-2 -translate-y-1/2" /> : null}
    </div>
  );
}

function linkIcon(l: { label: string; url: string }): IconData {
  return /linkedin\./i.test(l.url) || /linkedin/i.test(l.label) ? icons.linkedin : icons.external;
}

function LinksRows({ person, commit }: { person: Person; commit: (patch: Partial<Person>) => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    let u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
    try {
      new URL(u);
    } catch {
      return setError("That isn’t a web address.");
    }
    const l = label.trim() || (/linkedin\./i.test(u) ? "LinkedIn" : new URL(u).hostname.replace(/^www\./, ""));
    setError(null);
    try {
      await commit({ links: [...person.links, { label: l, url: u }] });
      setLabel("");
      setUrl("");
    } catch {
      // the toast says why
    }
  };
  return (
    <>
      {person.links.map((l) => (
        <div key={l.url} className="flex min-h-10 items-center gap-3 px-3 py-1.5">
          <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
            <Icon icon={linkIcon(l)} className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <Truncate className="text-sm">{l.label}</Truncate>
            <a href={l.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-primary text-xs underline-offset-2 hover:underline">
              {l.url.replace(/^https?:\/\/(www\.)?/i, "")}
            </a>
          </div>
          <Button size="icon-xs" variant="ghost-destructive" aria-label={`Remove ${l.label}`} onClick={() => void commit({ links: person.links.filter((x) => x !== l) }).catch(() => {})}>
            <Icon icon={icons.close} />
          </Button>
        </div>
      ))}
      <form
        className="flex flex-col gap-1.5 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Input size="sm" value={label} aria-label="Link name" placeholder="Name" className="w-28 min-w-0" onChange={(e) => setLabel(e.target.value)} />
          <Input
            size="sm"
            value={url}
            aria-label="Link address"
            placeholder="linkedin.com/in/…"
            aria-invalid={error ? true : undefined}
            className="min-w-40 flex-1"
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
          />
          <Button size="xs" variant="outline" type="submit" disabled={!url.trim()}>
            Add link
          </Button>
        </div>
        <FieldError>{error}</FieldError>
      </form>
    </>
  );
}

function NotesRows({ person, commit }: { person: Person; commit: (patch: Partial<Person>) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const add = async () => {
    const t = draft.trim();
    if (!t) return;
    try {
      await commit({ notes: [...person.notes, t] });
      setDraft("");
    } catch {
      // the toast says why
    }
  };
  return (
    <>
      {person.notes.map((n, i) => (
        <div key={`${i}-${n}`} className="flex min-h-10 items-start gap-3 px-3 py-2">
          <span className="min-w-0 flex-1 pt-0.5 text-sm [overflow-wrap:anywhere]">{n}</span>
          <Button
            size="icon-xs"
            variant="ghost-destructive"
            aria-label={`Remove note “${n}”`}
            onClick={() =>
              void commit({
                notes: person.notes.filter((_, j) => j !== i),
              }).catch(() => {})
            }
          >
            <Icon icon={icons.close} />
          </Button>
        </div>
      ))}
      <form
        className="flex items-center gap-2 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input size="sm" value={draft} maxLength={400} aria-label="New note" placeholder="Add a note" className="min-w-0 flex-1" onChange={(e) => setDraft(e.target.value)} />
        <Button size="xs" variant="outline" type="submit" disabled={!draft.trim()}>
          Add
        </Button>
      </form>
    </>
  );
}

function History({ interactions }: { interactions: Interaction[] }) {
  const openThread = useNav((s) => s.openThread);
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const list = useMemo(() => [...interactions].sort((a, b) => b.at - a.at), [interactions]);
  if (!list.length) return <EmptyRow>Nothing yet. Chats and mail with them show up here.</EmptyRow>;
  return (
    <>
      {list.slice(0, limit).map((i, n) => {
        const c = CHANNEL[i.channel];
        const thread = i.ref && "thread" in i.ref ? i.ref : undefined;
        return (
          <div key={`${i.at}-${n}`} className="flex min-h-10 items-start gap-3 px-3 py-2">
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
              <Icon icon={c.icon} label={c.label} className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
              <p className="text-sm [overflow-wrap:anywhere]">{i.summary}</p>
              <p className="text-muted-foreground text-xs">
                {c.label}
                {i.direction ? ` · ${i.direction === "in" ? "From them" : "To them"}` : ""}
              </p>
            </div>
            {thread ? (
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label="Open conversation" onClick={() => void openThread(thread.space, thread.thread)} />}>
                  <Icon icon={icons.chat} />
                </TooltipTrigger>
                <TooltipPopup>Open conversation</TooltipPopup>
              </Tooltip>
            ) : null}
            <span className="shrink-0 pt-1 type-meta">{shortDate(i.at)}</span>
          </div>
        );
      })}
      {list.length > limit ? (
        <div className="flex h-10 items-center px-2">
          <Button variant="ghost-muted" size="xs" shape="rect" onClick={() => setLimit((n) => n + HISTORY_PAGE * 2)}>
            Show {list.length - limit} more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function PersonDetail({ id, spaces, onBack, onDeleted }: { id: string; spaces: SpaceLite[]; onBack: () => void; onDeleted: () => void }) {
  const state = useLoad(() => getPerson(id), [id], "people:person");
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useCrumb({ label: state.data?.name ?? "Person", onBack });

  const commit = async (patch: Partial<Person>) => {
    const before = state.data;
    if (!before) return;
    state.setData({ ...before, ...patch });
    try {
      state.setData(await savePerson({ ...before, ...patch }));
    } catch (e) {
      state.setData(before);
      toast.error("Couldn’t save that", cleanMessage(e));
      throw e;
    }
  };
  const remove = async () => {
    setDeleting(true);
    try {
      await deletePerson(id);
      toast.success(`${state.data?.name ?? "Person"} deleted`);
      onDeleted();
    } catch (e) {
      toast.error("Couldn’t delete them", cleanMessage(e));
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="-mb-3 flex min-w-0 items-center justify-between gap-2">
        <button
          type="button"
          onClick={onBack}
          className="flex h-7 items-center gap-1.5 rounded-md px-1 text-muted-foreground text-sm outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon icon={icons.arrowLeft} className="size-4" />
          People
        </button>
        {state.data && SOURCE[state.data.source] ? <Badge variant="info">{SOURCE[state.data.source]}</Badge> : null}
      </div>
      <Loader state={state} errorTitle="Couldn’t read this person" skeleton={<SkeletonCard rows={4} className="rounded-card" />}>
        {(p) => (
          <>
            <SettingsGroup label="Person">
              <Row label="Name" htmlFor="person-f-name">
                <SavedText id="person-f-name" className="w-64" value={p.name} onSave={(name) => (name ? commit({ name }) : Promise.reject(new Error("empty")))} />
              </Row>
              <Row
                label="Also called"
                description={p.aliases.length ? undefined : "How you refer to them, like “my boss”."}
                below={<ChipList value={p.aliases} label="Add a name they go by" placeholder="Add a name" onChange={(aliases) => void commit({ aliases }).catch(() => {})} />}
              />
              <Row label="Relation" htmlFor="person-f-relation">
                <SavedText id="person-f-relation" className="w-64" value={p.relation ?? ""} placeholder="Manager, classmate, sister…" onSave={(v) => commit({ relation: v || undefined })} />
              </Row>
              <Row label="Organisation" htmlFor="person-f-org">
                <SavedText id="person-f-org" className="w-64" value={p.org ?? ""} onSave={(v) => commit({ org: v || undefined })} />
              </Row>
              <Row label="Title" htmlFor="person-f-title">
                <SavedText id="person-f-title" className="w-64" value={p.title ?? ""} onSave={(v) => commit({ title: v || undefined })} />
              </Row>
            </SettingsGroup>

            <SettingsGroup label="Contact">
              <Row label="Email" below={<ChipList mono value={p.emails} label="Add an email address" placeholder="Add an address" onChange={(emails) => void commit({ emails }).catch(() => {})} />} />
              <Row label="Phone" below={<ChipList value={p.phones} label="Add a phone number" placeholder="Add a number" onChange={(phones) => void commit({ phones }).catch(() => {})} />} />
              <LinksRows person={p} commit={commit} />
            </SettingsGroup>

            <SettingsGroup label="Privacy">
              <Row label="Seen in" description={p.spaces.length ? undefined : "No space can see them yet."}>
                <SpacesPicker every value={p.spaces} spaces={spaces} label={`Spaces that may see ${p.name}`} onChange={(next) => void commit({ spaces: next }).catch(() => {})} />
              </Row>
            </SettingsGroup>

            <SettingsGroup label="Notes">
              <NotesRows person={p} commit={commit} />
            </SettingsGroup>

            <SettingsGroup label="History">
              <History interactions={p.interactions} />
            </SettingsGroup>

            <SettingsGroup>
              <Row label="Delete person" description="Their card and history. Conversations and mail stay.">
                <Button size="xs" variant="ghost-destructive" onClick={() => setConfirm(true)} pending={deleting}>
                  Delete…
                </Button>
              </Row>
            </SettingsGroup>
            <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Delete ${p.name}?`} confirm="Delete" destructive onConfirm={() => void remove()}>
              <p>Agents won’t know who {p.name} is anymore.</p>
            </ConfirmDialog>
          </>
        )}
      </Loader>
    </>
  );
}

// ---- List ---------------------------------------------------------------------

export function PeopleSection() {
  const spaces = useSpaceList();
  const people = useLoad(() => listPeople(), [], "people:list");
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const back = useCallback(() => {
    setEditing(null);
    void people.reload();
  }, [people.reload]);

  if (editing) return <PersonDetail key={editing} id={editing} spaces={spaces} onBack={back} onDeleted={back} />;

  const add = (
    <Button size="xs" variant="ghost" onClick={() => setCreating(true)} disabled={!spaces.length}>
      <Icon icon={icons.add} />
      Add person
    </Button>
  );
  const list = people.data ?? [];
  const shown = list.filter((p) => matches(p, query)).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      {list.length > SEARCH_FROM ? (
        <div className="relative">
          <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input size="sm" value={query} placeholder="Search people" aria-label="Search people" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
        </div>
      ) : null}
      <SettingsGroup label="People" action={add}>
        <Loader state={people} errorTitle="Couldn’t read the people you know" skeleton={<SkeletonCard rows={3} className="rounded-none border-0" />}>
          {() =>
            list.length === 0 ? (
              <EmptyRow>No one yet. Agents add people as they come up, or add one yourself.</EmptyRow>
            ) : shown.length === 0 ? (
              <EmptyRow>No one matches “{query.trim()}”.</EmptyRow>
            ) : (
              shown.map((p) => {
                const last = p.interactions.at(-1)?.at;
                const sub = subtitle(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setEditing(p.id)}
                    className="group flex min-h-11 w-full items-center gap-3 px-3 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  >
                    <Avatar name={p.name} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <Truncate className="min-w-0 text-sm">{p.name}</Truncate>
                      {sub ? <Truncate className="text-muted-foreground text-xs">{sub}</Truncate> : null}
                    </span>
                    {p.interactionCount ? (
                      <span className="hidden shrink-0 flex-col items-end @lg/settings:flex">
                        <span className="type-meta">{last ? shortDate(last) : ""}</span>
                        <span className="type-meta">
                          {p.interactionCount} {p.interactionCount === 1 ? "interaction" : "interactions"}
                        </span>
                      </span>
                    ) : null}
                    {p.interactionCount ? <span className="shrink-0 type-meta @lg/settings:hidden">{last ? shortDate(last) : ""}</span> : null}
                    <Icon icon={icons.chevronRight} className="size-4 shrink-0 text-subtle-foreground transition-[color,translate] group-hover:translate-x-0.5 group-hover:text-foreground" />
                  </button>
                );
              })
            )
          }
        </Loader>
      </SettingsGroup>
      <NewPerson open={creating} onOpenChange={setCreating} spaces={spaces} onCreated={(p) => setEditing(p.id)} />
    </>
  );
}
