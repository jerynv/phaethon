import { Badge, NativeSelect } from "vic-ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { SPACE_HUES, spaceSwatch, spaceSwatchCheck } from "@/components/shell/new-space-dialog";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { getSettings } from "@/lib/backend";
import { setFullAccess, useFullAccess } from "@/lib/full-access";
import { grantDate, grantLabel, grantNoun, scheduleRevoke, spaceInfo, undoRevoke, useGrants, usePendingRevokes } from "@/lib/grants";
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, updateSpace, useSpaces, type Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { HueSwatches, PathText, SectionHeader, SettingGroup, SettingRow, SwitchRow } from "./controls";
import { coursesSeen, SpaceCourses, useSpaceCourses } from "./space-courses";
import { useStatus } from "./status";

/** "line 3 column 5" in a parser message, as "line 3". */
function lineOf(message: string): string | null {
  const m = /line (\d+)/i.exec(message);
  return m ? `line ${m[1]}` : null;
}

/** T3 Code's project settings separate the project list from one project's editor. */
export function SpacesSection({ headingId, editSpace }: { headingId: string; editSpace?: { id: string; n: number } | null }) {
  const [vaultPath, setVaultPath] = useState<string | undefined>();
  const [selected, setSelected] = useState<string | null>(editSpace?.id ?? null);
  useEffect(() => { if (editSpace?.id) setSelected(editSpace.id); }, [editSpace?.id, editSpace?.n]);
  useEffect(() => {
    getSettings().then(
      (s) => setVaultPath(s.vaultPath),
      () => {},
    );
  }, []);
  const { spaces, status: spacesStatus } = useSpaces();
  function openEditor(id: string) {
    setSelected(id);
    requestAnimationFrame(() => {
      const field = document.querySelector<HTMLInputElement>(`[data-space-details="${CSS.escape(id)}"] [data-space-field="name"]`);
      field?.focus();
      const panel = field?.closest<HTMLElement>('[role="tabpanel"]');
      if (panel) panel.scrollTop = 0;
    });
  }
  function back() {
    const previous = selected;
    setSelected(null);
    requestAnimationFrame(() => { if (previous) document.querySelector<HTMLElement>(`[data-space-edit="${CSS.escape(previous)}"]`)?.focus(); });
  }
  // grants.json problems are about the whole file; every space reports the same list.
  const { state } = useGrants(spaces[0]?.id ?? "");
  const problems = state.status === "ready" ? state.problems : [];
  const fileError = state.status === "error" ? state.error : null;
  const grantsFile = vaultPath ? <PathText path={`${vaultPath}/.phaethon/grants.json`} /> : ".phaethon/grants.json in your Phaethon folder";

  return (
    <>
      <SectionHeader
        id={headingId}
        title={selected ? (spaces.find((s) => s.id === selected)?.name ?? "Space") : "Spaces"}
        action={selected ? <Button variant="ghost" size="sm" data-spaces-back="" onClick={back}><Icon name="chevron-left" />All spaces</Button> : undefined}
      />
      {fileError && (
        <FileNotice tone="danger" icon="error" title="Phaethon can’t read its list of access between spaces, so no space can read another.">
          <p>
            The file that lists access between spaces has a mistake in it{lineOf(fileError) ? `, on ${lineOf(fileError)}` : ""}. Fix it, or delete the file: each space then asks again before reading another.
          </p>
          <p>
            The file is <span className="font-mono wrap-anywhere">{grantsFile}</span>
          </p>
          <Details className="text-danger-ink">
            <p className="font-mono wrap-anywhere">{fileError}</p>
          </Details>
        </FileNotice>
      )}
      <SettingGroup title={selected ? "Workspace" : "Your spaces"} bare>
        <ul className={cn("flex flex-col gap-0.5 p-1", !selected && "rounded-lg border border-line bg-raised")} aria-label="Your spaces">
          {spaces.map((s) => (
            <SpaceRow key={s.id} space={s} fileError={fileError} open={selected === s.id} hidden={selected !== null && selected !== s.id} onEdit={() => openEditor(s.id)} />
          ))}
        </ul>
        {spacesStatus === "ready" && spaces.length === 0 && <p className="px-4 py-3.5 text-sm text-ink-secondary">You have no spaces yet.</p>}
      </SettingGroup>
      {problems.length > 0 && (
        // The headline and what to do are written here; the core's line for each problem shows as it arrives.
        <FileNotice tone="warning" icon="warning" title="Some saved access between spaces can’t be used, so it gives no access.">
          <p>The access listed above still works. What is wrong:</p>
          <ul data-grant-problems="" className="flex list-disc flex-col gap-0.5 ps-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p>
            To fix this, correct or delete those entries in the access file, or delete the whole file: each space then asks again before reading another. The file is{" "}
            <span className="font-mono wrap-anywhere">{grantsFile}</span>
          </p>
        </FileNotice>
      )}

    </>
  );
}

function FileNotice({ tone, icon, title, children }: { tone: "danger" | "warning"; icon: "error" | "warning"; title: string; children: ReactNode }) {
  return (
    <div
      className={
        tone === "danger"
          ? "flex items-start gap-2.5 rounded-md bg-danger-soft px-3.5 py-3 text-sm text-danger-ink"
          : "flex items-start gap-2.5 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning-ink"
      }
    >
      <Icon name={icon} className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1">
        <p className="font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

/**
 * How long a Remove made in Settings can be undone: until Settings closes
 * (settings-dialog.tsx ends every Undo window then), and never past the
 * core's own ten minutes.
 */
const SETTINGS_UNDO_MS = 9 * 60 * 1000;

/** One access between two spaces, from either side: `who` reads `what`. */
type AccessRow = { id: string; other: string; path: string; created: string; scope: "always" | "once"; who: string; what: string };

const listOf = (names: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(names);

/**
 * A folded space's access in one line: "Reads 1 folder in Work · Read by Art
 * · Sees 2 courses", or "Only its own files" when there is none. Nothing while
 * it is being checked or could not be (the details say why).
 */
function accessSummary({ status, reads, readBy, courses }: { status: string; reads: AccessRow[]; readBy: AccessRow[]; courses: number }): string {
  if (status !== "ready") return "";
  const parts: string[] = [];
  if (reads.length) {
    const byOther = new Map<string, AccessRow[]>();
    for (const r of reads) byOther.set(r.other, [...(byOther.get(r.other) ?? []), r]);
    const each = [...byOther].map(([other, rows]) => {
      const name = spaceInfo(other).name;
      if (rows.some((r) => !r.path)) return `all of ${name}`;
      return `${rows.length} ${grantNoun(rows, rows.length > 1)} in ${name}`;
    });
    parts.push(`Reads ${listOf(each)}`);
  }
  if (readBy.length) parts.push(`Read by ${listOf([...new Set(readBy.map((r) => spaceInfo(r.other).name))])}`);
  if (courses) parts.push(courses === 1 ? "Sees 1 course" : `Sees ${courses} courses`);
  return parts.length ? parts.join(" · ") : "Only its own files";
}

/** List identity and the selected editor share mounted state, including unsaved drafts and grant Undo. */
function SpaceRow({ space, fileError, open, hidden, onEdit }: { space: Space; fileError: string | null; open: boolean; hidden: boolean; onEdit: () => void }) {
  const { state } = useGrants(space.id);
  const { pending, revoked } = usePendingRevokes();
  const { say, fail } = useStatus();
  const courses = useSpaceCourses(space.id);
  const fullAccess = useFullAccess(space.id);
  const [unsaved, setUnsaved] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNext = useRef<{ undo: string } | { revoke: string } | { index: number } | null>(null);
  const emptyId = `space-${space.id}-grants`;
  const ready = state.status === "ready";
  const reads: AccessRow[] = ready
    ? state.grants.filter((g) => !revoked.has(g.id)).map((g) => ({ ...g, other: g.from, who: space.name, what: grantLabel(g) }))
    : [];
  const readBy: AccessRow[] = ready
    ? state.incoming
        .filter((g) => !revoked.has(g.id))
        .map((g) => ({ ...g, other: g.to, who: spaceInfo(g.to).name, what: g.path ? `${space.name} / ${g.path}` : `All of ${space.name}` }))
    : [];

  // After Remove, Undo, or a row going away: put focus where it belongs.
  useLayoutEffect(() => {
    const want = focusNext.current;
    const root = listRef.current;
    if (!want || !root) return;
    focusNext.current = null;
    const q = (sel: string) => root.querySelector<HTMLElement>(sel);
    if ("undo" in want) return void q(`[data-undo="${want.undo}"]`)?.focus();
    if ("revoke" in want) return void q(`[data-revoke="${want.revoke}"]`)?.focus();
    const buttons = root.querySelectorAll<HTMLElement>("[data-row-action]");
    if (buttons.length) buttons[Math.min(want.index, buttons.length - 1)]?.focus();
    else document.getElementById(emptyId)?.focus();
  });

  /** Focus is on this row's Undo (or Remove) for `id`: only then does a late result move it. */
  const focusOn = (id: string) => listRef.current?.contains(document.activeElement) && document.activeElement?.closest("[data-grant-row]")?.getAttribute("data-grant-row") === id;

  function remove(r: AccessRow, index: number) {
    focusNext.current = { undo: r.id };
    scheduleRevoke(
      r.id,
      (result) => {
        if ("error" in result) {
          if (focusOn(r.id)) focusNext.current = { revoke: r.id };
          fail(`Couldn’t remove ${r.who}’s access to ${r.what}: ${String(result.error)}`);
          return;
        }
        if (!result.removed) {
          if (focusOn(r.id)) focusNext.current = { index };
          say(`${r.what} was already removed.`);
        }
      },
      SETTINGS_UNDO_MS,
    );
    say(`Removed. ${r.who} can no longer read ${r.what}. What was already read stays in that conversation. Undo is next to it until you close Settings.`);
  }

  function undo(r: AccessRow) {
    if (!undoRevoke(r.id)) return;
    focusNext.current = { revoke: r.id };
    say(`Undone. ${r.who} can read ${r.what} again.`);
  }

  const row = (r: AccessRow, index: number, direction: "out" | "in") => {
    const other = spaceInfo(r.other);
    const date = grantDate(r.created);
    const waiting = pending.has(r.id);
    const tone = waiting ? "text-ink-secondary" : "text-ink";
    return (
      // Same two-line layout as the title bar's grants popover: where from, then how long.
      <li key={r.id} data-grant-row={r.id} className="flex items-center gap-3 py-2 ps-3 pe-1.5 not-first:border-t not-first:border-line">
        <div className="flex min-w-0 flex-1 items-start gap-x-2">
          {/* One line tall, so the dot sits on the first line however the path wraps. */}
          <span className="flex h-[1lh] shrink-0 items-center text-base">
            <SpaceMark hue={other.hue} />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* The path wraps anywhere, and the name sits on the path's first line: it never stands alone on a line. */}
            <span data-grant-where="" className={cn("text-base wrap-anywhere", waiting && "line-through")}>
              {direction === "out" ? (
                r.path ? (
                  <>
                    <span className={cn("font-medium whitespace-nowrap", tone)}>{other.name}</span>
                    <span aria-hidden="true" className="text-ink-secondary">
                      {" / "}
                    </span>
                    <span className={cn("font-mono text-sm", tone)}>{r.path}</span>
                  </>
                ) : (
                  <span className={cn("font-medium", tone)}>All of {other.name}</span>
                )
              ) : (
                <>
                  <span className={cn("font-medium whitespace-nowrap", tone)}>{other.name}</span>
                  <span className="text-ink-secondary">{" reads "}</span>
                  {r.path ? <span className={cn("font-mono text-sm", tone)}>{r.path}</span> : <span className={tone}>{`all of ${space.name}`}</span>}
                </>
              )}
            </span>
            <span className="text-xs text-ink-secondary">
              {waiting ? (
                "Removed. You can undo this until you close Settings."
              ) : (
                <>
                  {r.scope === "once" ? "This time only" : "Always"}
                  {date && ` · since ${date}`}
                </>
              )}
            </span>
          </span>
        </div>
        {waiting ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-undo={r.id}
            data-row-action=""
            aria-label={`Undo removing ${r.who}’s access to ${r.what}`}
            onClick={() => undo(r)}
            className="min-h-(--ph-target-min)"
          >
            Undo
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            data-revoke={r.id}
            data-row-action=""
            aria-label={`Remove ${r.who}’s access to ${r.what}`}
            onClick={() => remove(r, index)}
            className="min-h-(--ph-target-min)"
          >
            Remove
          </Button>
        )}
      </li>
    );
  };

  const summary = accessSummary({
    status: state.status,
    // Access taken away (even with Undo still open) no longer counts.
    reads: reads.filter((r) => !pending.has(r.id)),
    readBy: readBy.filter((r) => !pending.has(r.id)),
    courses: courses ? coursesSeen(courses, space.id).length : 0,
  });
  const undoable = [...reads, ...readBy].filter((r) => pending.has(r.id)).length;
  const notes = [unsaved ? "Unsaved changes" : "", undoable ? `${undoable} pending removal${undoable === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");

  return (
    <li data-space-row={space.id} data-open={open ? "" : undefined} hidden={hidden} className={cn("flex flex-col gap-4", open ? "p-0" : "px-3.5 py-3")} >
      <div hidden={open} className="flex items-center gap-3">
        {/* One line tall, so the dot sits on the name's first line however it wraps. */}
        <span className="flex h-[1lh] shrink-0 items-center text-base">
          <SpaceMark hue={space.hue} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* The name has the row to itself: it wraps rather than being cut short. */}
          <h5 data-space-name="" className="text-base font-medium wrap-anywhere text-ink">
            {space.name}
          </h5>
          {space.description && (
            <p data-space-description="" className="truncate text-sm text-ink-secondary" title={space.description}>
              {space.description}
            </p>
          )}
          {summary && summary !== "Only its own files" && (
            <p data-space-summary="" className="text-sm text-ink-secondary">
              {summary}
            </p>
          )}
          {notes && <p data-space-notes="" className="text-xs text-ink-secondary">{notes}</p>}

        </div>
        <Badge data-space-full-access="" tone={fullAccess ? "danger" : "neutral"} dot={fullAccess} className={fullAccess ? "border-transparent bg-danger-soft" : "border-transparent"}>{fullAccess ? "Full access" : "Workspace"}</Badge>
        {space.educationEnabled && <span className="shrink-0 rounded-md bg-accent-soft px-2 py-0.5 text-xs text-accent-ink">Education</span>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          data-space-edit={space.id}
          onClick={onEdit}
          className="min-h-(--ph-target-min) shrink-0"
        >
          Edit<span className="sr-only"> {space.name}</span>
        </Button>
      </div>

      <div hidden={!open} data-space-details={space.id} className="flex flex-col gap-5">
        <SpaceEditor space={space} onDirty={setUnsaved} />
        <FullAccess space={space} on={fullAccess} />

        <Details summary="Shared access" className="flex flex-col gap-3"><div ref={listRef} className="flex flex-col gap-3">
          {state.status === "loading" && <p className="text-sm text-ink-secondary">Checking what {space.name} can read…</p>}
          {state.status === "error" &&
            (state.error === fileError ? (
              <p className="flex items-start gap-1.5 text-sm text-ink-secondary">
                <Icon name="lock" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                Can’t read anything outside {space.name} until the access file is fixed.
              </p>
            ) : (
              <div className="flex items-start gap-1.5 text-sm text-danger-ink">
                <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                <div className="flex min-w-0 flex-col items-start">
                  <p>Couldn’t check what {space.name} can read. Close Settings and open it again to retry.</p>
                  <Details className="text-danger-ink">
                    <p className="font-mono wrap-anywhere">{state.error}</p>
                  </Details>
                </div>
              </div>
            ))}
          {ready &&
            (reads.length === 0 ? (
              <p id={emptyId} tabIndex={-1} className="flex items-center gap-1.5 text-sm text-ink-secondary outline-none">
                <Icon name="lock" className="size-(--ph-icon-size-sm) shrink-0" />
                Can’t read anything outside {space.name}.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-ink-secondary">{space.name} can also read, without asking:</p>
                <ul aria-label={`What ${space.name} can read in other spaces`} className="flex flex-col rounded-md bg-surface-sunken">
                  {reads.map((r, i) => row(r, i, "out"))}
                </ul>
              </div>
            ))}
          {ready &&
            (readBy.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
                <Icon name="lock" className="size-(--ph-icon-size-sm) shrink-0" />
                No other space can read {space.name}.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="text-sm text-ink-secondary">Other spaces that can read {space.name}, without asking:</p>
                <ul aria-label={`Who can read ${space.name}`} className="flex flex-col rounded-md bg-surface-sunken">
                  {readBy.map((r, i) => row(r, reads.length + i, "in"))}
                </ul>
              </div>
            ))}
        </div></Details>
        {space.educationEnabled && <SpaceCourses space={space} view={courses} />}
      </div>
    </li>
  );
}

/** The CLI access setting is explicit and persisted for this space. */
function FullAccess({ space, on }: { space: Space; on: boolean }) {
  const { say, fail } = useStatus();
  const [busy, setBusy] = useState(false);
  const id = useId();
  async function change(next: boolean) {
    if (busy || next === on) return;
    setBusy(true);
    try {
      const now = await setFullAccess(space.id, next);
      say(`${space.name}: ${now ? "full access" : "workspace access"}.`);
    } catch (e) {
      fail(`Couldn’t change access for ${space.name}: ${String(e)}`);
    } finally { setBusy(false); }
  }
  return (
    <SettingGroup title="Permissions">
      <SettingRow label="Agent access" htmlFor={id} description="Applies to CLI agents on this Mac.">
        <NativeSelect id={id} data-full-access={space.id} data-full-access-toggle={on ? "off" : "on"} value={on ? "full" : "workspace"} disabled={busy} onChange={(e) => void change(e.target.value === "full")}>
          <option value="workspace">Workspace only</option>
          <option value="full">Full access</option>
        </NativeSelect>
      </SettingRow>
    </SettingGroup>
  );
}

/** One explicit transaction keeps names, descriptions, colour and enabled views together. */
function SpaceEditor({ space, onDirty }: { space: Space; onDirty: (dirty: boolean) => void }) {
  const { say, fail } = useStatus();
  const draftOf = () => ({ name: space.name, description: space.description, hue: space.hue, educationEnabled: space.educationEnabled });
  const [draft, setDraft] = useState(draftOf);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const nameId = useId();
  const descId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const dirty = draft.name !== space.name || draft.description !== space.description || draft.hue !== space.hue || draft.educationEnabled !== space.educationEnabled;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const presets = SPACE_HUES.some((p) => p.value === draft.hue) ? SPACE_HUES : [{ label: "Current", value: draft.hue }, ...SPACE_HUES];
  const reset = () => { setDraft(draftOf()); setError(""); setSaved(false); };
  async function save() {
    if (busy || !dirty) return;
    if (!draft.name.trim()) { setError("Enter a name."); nameRef.current?.focus(); return; }
    setBusy(true);
    setError("");
    try {
      const result = await updateSpace(space.id, { ...draft, name: draft.name.trim(), description: draft.description.trim() });
      setDraft({ name: result.name, description: result.description, hue: result.hue, educationEnabled: result.educationEnabled });
      setSaved(true);
      say(`${result.name} saved.`);
    } catch (e) { setError(String(e)); fail(`Couldn’t save ${space.name}: ${String(e)}`); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex flex-col gap-4" data-space-editor="">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-normal text-ink">Name</label>
        <Input ref={nameRef} id={nameId} value={draft.name} placeholder="Home" maxLength={SPACE_NAME_MAX} autoComplete="off" data-space-field="name" data-dirty={dirty ? "" : undefined} aria-invalid={!!error && !draft.name.trim() || undefined} onChange={(e) => { setDraft((d) => ({ ...d, name: e.target.value })); setSaved(false); }} onKeyDown={(e) => { if (e.key === "Escape" && dirty) { e.preventDefault(); e.stopPropagation(); reset(); } }} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={descId} className="text-sm font-normal text-ink">Description <span className="font-normal text-ink-tertiary">Optional</span></label>
        <Input id={descId} value={draft.description} placeholder="Projects, notes and plans" maxLength={SPACE_DESCRIPTION_MAX} autoComplete="off" data-space-field="description" data-dirty={dirty ? "" : undefined} onChange={(e) => { setDraft((d) => ({ ...d, description: e.target.value })); setSaved(false); }} onKeyDown={(e) => { if (e.key === "Escape" && dirty) { e.preventDefault(); e.stopPropagation(); reset(); } }} />
      </div>
      <div className="flex flex-col gap-2"><span className="text-sm font-normal text-ink">Colour</span><HueSwatches label={`Colour, ${space.name}`} presets={presets} value={draft.hue} onPick={(hue) => { setDraft((d) => ({ ...d, hue })); setSaved(false); }} swatchColour={spaceSwatch} checkColour={spaceSwatchCheck} /></div>
      <div className="rounded-lg border border-line"><SwitchRow label="Education" description="Study, grades and planning for this space." checked={draft.educationEnabled} onChange={(educationEnabled) => { setDraft((d) => ({ ...d, educationEnabled })); setSaved(false); }} status={draft.educationEnabled ? "On" : "Off"} /></div>
      <div data-space-folder="" className="flex items-center gap-2 text-xs text-ink-secondary"><Icon name="folder" className="size-(--ph-icon-size-sm)" /><code className="min-w-0 wrap-anywhere">spaces/{space.id}/</code></div>
      {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
      <div className="flex items-center gap-2">
        <Button data-space-save="" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button>
        <Button variant="ghost" disabled={busy || !dirty} onClick={reset}>Cancel</Button>
        {saved && !dirty && <span data-space-saved="" className="ms-auto flex items-center gap-1 text-xs text-ink-secondary"><Icon name="check" className="size-(--ph-icon-size-sm)" />Saved</span>}
      </div>
    </div>
  );
}
