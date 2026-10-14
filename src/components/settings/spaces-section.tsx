import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { SPACE_HUES, spaceSwatch, spaceSwatchCheck } from "@/components/shell/new-space-dialog";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { getSettings } from "@/lib/backend";
import { grantDate, grantLabel, scheduleRevoke, spaceInfo, undoRevoke, useGrants, usePendingRevokes } from "@/lib/grants";
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, updateSpace, useSpaces, type Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { HueSwatches, PathText, SectionHeader, SettingGroup } from "./controls";
import { SpaceCourses } from "./space-courses";
import { useStatus } from "./status";

/** "line 3 column 5" in a parser message, as "line 3". */
function lineOf(message: string): string | null {
  const m = /line (\d+)/i.exec(message);
  return m ? `line ${m[1]}` : null;
}

/**
 * Settings > Spaces: every space in the vault, with its name, description and
 * colour editable in place, and under each, what it may read in other spaces
 * and which other spaces may read it (saved read-only grants), with Remove
 * and Undo. Modelled on the
 * per-app lists of macOS Privacy & Security and the "third-party access" pages
 * of GitHub and Google: who has access to what, since when, and one button to
 * take it back. Nothing here grants access; that only happens in a
 * conversation, when Phaethon asks.
 *
 * Problems with grants.json are about the whole file, so they are shown once,
 * above the list, not repeated under every space.
 */
export function SpacesSection({ headingId }: { headingId: string }) {
  const [vaultPath, setVaultPath] = useState<string | undefined>();
  useEffect(() => {
    getSettings().then(
      (s) => setVaultPath(s.vaultPath),
      () => {},
    );
  }, []);
  const { spaces, status: spacesStatus } = useSpaces();
  // grants.json problems are about the whole file; every space reports the same list.
  const { state } = useGrants(spaces[0]?.id ?? "");
  const problems = state.status === "ready" ? state.problems : [];
  const fileError = state.status === "error" ? state.error : null;
  const grantsFile = vaultPath ? <PathText path={`${vaultPath}/.phaethon/grants.json`} /> : ".phaethon/grants.json in your Phaethon folder";

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Spaces"
        description="A space only sees its own files. When Phaethon needs something from another space, it asks you in the conversation. Under each space is the access you chose to keep: what it can read in other spaces, and which other spaces can read it. It is read-only: one space can never change another’s files."
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
      <SettingGroup title="Your spaces">
        <ul className="flex flex-col divide-y divide-line" aria-label="Your spaces">
          {spaces.map((s) => (
            <SpaceRow key={s.id} space={s} fileError={fileError} />
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
      <p className="flex items-start gap-2 text-sm text-ink-secondary">
        <Icon name="info" className="mt-0.5 shrink-0 text-ink-tertiary" />
        <span className="max-w-(--ph-measure)">
          Names and descriptions save when you press Enter or leave the field; Escape undoes an unsaved edit. Renaming a space changes only the name you see: its folder keeps the name it was created with. To add a space, use New space in the sidebar.
        </span>
      </p>
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

/**
 * Under each space: what it can read in other spaces, and which other spaces
 * can read it. Remove takes access away at once and leaves the row, struck
 * through, with Undo until Settings closes (the same revoke-with-Undo as the
 * title bar's popover, src/lib/grants.ts). Focus moves from Remove to Undo and
 * back; when a row goes, to the row that took its place.
 */
function SpaceRow({ space, fileError }: { space: Space; fileError: string | null }) {
  const { state } = useGrants(space.id);
  const { pending, revoked } = usePendingRevokes();
  const { say, fail } = useStatus();
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

  return (
    <li data-space-row={space.id} className="flex flex-col gap-3 px-4 py-3.5">
      <SpaceEditor space={space} />

      <div ref={listRef} className="ms-(--ph-space-mark-size) flex flex-col gap-3 ps-3">
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
        <SpaceCourses space={space} />
      </div>
    </li>
  );
}

/**
 * A space's name, description and colour, edited in place. Text fields save
 * on Enter or when focus leaves them, and Escape puts back the saved text
 * (Settings stays open while a field has unsaved text). A colour saves when
 * chosen. Each save is said in the Settings status region and shown under
 * the fields.
 */
function SpaceEditor({ space }: { space: Space }) {
  const { say, fail } = useStatus();
  const [saved, setSaved] = useState("");

  async function save(patch: { name?: string; description?: string; hue?: number }, done: (s: Space) => string): Promise<string | null> {
    try {
      const message = done(await updateSpace(space.id, patch));
      setSaved(message);
      say(message);
      return null;
    } catch (e) {
      fail(`${space.name} couldn’t be changed: ${String(e)}`);
      return String(e);
    }
  }

  // A hue that is not a preset (the built-in School and Work, or one set by hand) shows first as "Current".
  const presets = SPACE_HUES.some((p) => p.value === space.hue) ? SPACE_HUES : [{ label: "Current", value: space.hue }, ...SPACE_HUES];
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <SpaceMark hue={space.hue} />
        <h5 className="min-w-0 flex-1 truncate text-base font-medium text-ink">{space.name}</h5>
        {/* Where its files are, in words rather than a path. */}
        <span className="text-xs text-ink-secondary" data-space-folder="">
          Kept in the folder named “{space.id}”, inside the spaces folder of your Phaethon folder.
        </span>
      </div>
      <div className="ms-(--ph-space-mark-size) flex flex-wrap gap-x-4 gap-y-3 ps-3">
        <InlineField
          label="Name"
          spaceName={space.name}
          value={space.name}
          maxLength={SPACE_NAME_MAX}
          required
          className="flex-[1_1_12em]"
          onSave={(name) => save({ name }, (s) => `Renamed to ${s.name}.`)}
        />
        <InlineField
          label="Description"
          spaceName={space.name}
          value={space.description}
          maxLength={SPACE_DESCRIPTION_MAX}
          className="flex-[2_1_18em]"
          onSave={(description) => save({ description }, (s) => (s.description ? `${s.name}’s description saved.` : `${s.name}’s description removed.`))}
        />
        <div className="flex w-full flex-col gap-1">
          <span aria-hidden="true" className="text-sm font-medium text-ink">
            Colour <span className="font-normal text-ink-secondary">({colourName(space.hue)})</span>
          </span>
          <HueSwatches
            label={`Colour, ${space.name}`}
            presets={presets}
            value={space.hue}
            onPick={(hue) => void save({ hue }, (s) => `${s.name}’s colour is now ${colourName(s.hue)}.`)}
            swatchColour={spaceSwatch}
            checkColour={spaceSwatchCheck}
          />
        </div>
        {saved && (
          // Seen here; heard through the Settings status region.
          <p aria-hidden="true" data-space-saved="" className="flex w-full items-center gap-1.5 text-sm text-ink-secondary">
            <Icon name="check" className="size-(--ph-icon-size-sm) shrink-0" />
            {saved}
          </p>
        )}
      </div>
    </>
  );
}

/** A preset's name ("Rose"), or the angle for any other hue, so it never claims a preset it only resembles. */
function colourName(h: number): string {
  return SPACE_HUES.find((p) => p.value === h)?.label ?? `custom, hue ${h}`;
}

function InlineField({
  label,
  spaceName,
  value,
  maxLength,
  required,
  className,
  onSave,
}: {
  label: string;
  spaceName: string;
  value: string;
  maxLength: number;
  required?: boolean;
  className?: string;
  /** Resolves with an error message, or null once saved. */
  onSave: (value: string) => Promise<string | null>;
}) {
  const id = useId();
  const errorId = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const { say } = useStatus();
  const dirty = draft !== value;

  // A saved change (here, or in space.json by hand) shows unless this field holds unsaved text.
  const last = useRef(value);
  useEffect(() => {
    if (last.current === value) return;
    const before = last.current;
    last.current = value;
    setDraft((d) => (d === before ? value : d));
  }, [value]);

  async function commit() {
    if (busy.current) return;
    const next = draft.trim();
    if (next === value) {
      setDraft(value);
      setError("");
      return;
    }
    if (required && !next) {
      setError("A space needs a name. Type one, or press Escape to keep the old one.");
      return;
    }
    busy.current = true;
    const problem = await onSave(next);
    busy.current = false;
    setError(problem ?? "");
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commit();
    } else if (e.key === "Escape" && (dirty || error)) {
      // Settings sees data-dirty on this field and stays open for this Escape.
      setDraft(value);
      setError("");
      say(`${label} change undone.`);
    }
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
        <span className="sr-only">, {spaceName}</span>
      </label>
      <Input
        id={id}
        value={draft}
        maxLength={maxLength}
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-required={required ? true : undefined}
        data-dirty={dirty || error ? "" : undefined}
        data-space-field={label.toLowerCase()}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError("");
        }}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
      {error && (
        <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger-ink">
          <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
