import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { SPACE_HUES, spaceSwatch, spaceSwatchCheck } from "@/components/shell/new-space-dialog";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { getSettings } from "@/lib/backend";
import { grantDate, grantLabel, revokeGrant, spaceInfo, useGrants, type GrantView } from "@/lib/grants";
import { SPACE_DESCRIPTION_MAX, SPACE_NAME_MAX, updateSpace, useSpaces, type Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { HueSwatches, PathText, SectionHeader, SettingGroup } from "./controls";
import { useStatus } from "./status";

/** "line 3 column 5" in a parser message, as "line 3". */
function lineOf(message: string): string | null {
  const m = /line (\d+)/i.exec(message);
  return m ? `line ${m[1]}` : null;
}

/**
 * Settings > Spaces: every space in the vault, with its name, description and
 * colour editable in place, and under each, what it may read in other spaces
 * (saved read-only grants), with Revoke. Modelled on the
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
  const grantsFile = vaultPath ? <PathText path={`${vaultPath}/.phaethon/grants.json`} /> : ".phaethon/grants.json in your vault";

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Spaces"
        description="A space only sees its own files. When Phaethon needs something from another space, it asks you in the conversation. Grants you choose to keep are listed here; they are read-only."
      />
      {fileError && (
        <FileNotice tone="danger" icon="error" title="Saved grants can’t be read, so no space can read another.">
          <p>
            The grants file has a mistake in it{lineOf(fileError) ? `, on ${lineOf(fileError)}` : ""}. Fix it, or delete the file: each space then asks again before reading another.
          </p>
          <p>
            The file is <span className="font-mono wrap-anywhere">{grantsFile}</span>
          </p>
          <Details className="text-danger-ink">
            <p className="font-mono wrap-anywhere">{fileError}</p>
          </Details>
        </FileNotice>
      )}
      <SettingGroup title="In this vault">
        <ul className="flex flex-col divide-y divide-line" aria-label="Spaces in this vault">
          {spaces.map((s) => (
            <SpaceRow key={s.id} space={s} fileError={fileError} />
          ))}
        </ul>
        {spacesStatus === "ready" && spaces.length === 0 && <p className="px-4 py-3.5 text-sm text-ink-secondary">This vault has no spaces yet.</p>}
      </SettingGroup>
      {problems.length > 0 && (
        // The headline and what to do are written here; the core's line for each problem shows as it arrives.
        <FileNotice tone="warning" icon="warning" title="Some saved grants can’t be used, so they give no access.">
          <p>The grants listed above still work. What is wrong:</p>
          <ul data-grant-problems="" className="flex list-disc flex-col gap-0.5 ps-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p>
            To fix this, correct or delete those entries in the grants file, or delete the whole file: each space then asks again before reading another. The file is{" "}
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

function SpaceRow({ space, fileError }: { space: Space; fileError: string | null }) {
  const { state } = useGrants(space.id);
  const { say, fail } = useStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  const emptyId = `space-${space.id}-grants`;
  const grants = state.status === "ready" ? state.grants : [];

  // After a revoke, focus the Revoke that took the removed one's place, or the empty-state line.
  useEffect(() => {
    const i = focusAfter.current;
    if (i === null || state.status !== "ready") return;
    focusAfter.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-revoke]");
    if (buttons?.length) buttons[Math.min(i, buttons.length - 1)]?.focus();
    else document.getElementById(emptyId)?.focus();
  }, [state, emptyId]);

  async function revoke(g: GrantView, index: number) {
    setBusy(g.id);
    try {
      const removed = await revokeGrant(g.id);
      focusAfter.current = index;
      say(removed ? `${space.name} can no longer read ${grantLabel(g)}.` : `${grantLabel(g)} was already removed.`);
    } catch (e) {
      fail(`Could not revoke ${space.name}’s access to ${grantLabel(g)}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li data-space-row={space.id} className="flex flex-col gap-3 px-4 py-3.5">
      <SpaceEditor space={space} />

      <div ref={listRef} className="ms-(--ph-space-mark-size) ps-3">
        {state.status === "loading" && <p className="text-sm text-ink-secondary">Checking what {space.name} can read…</p>}
        {state.status === "error" &&
          (state.error === fileError ? (
            <p className="flex items-start gap-1.5 text-sm text-ink-secondary">
              <Icon name="lock" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              Can’t read anything outside {space.name} until the grants file is fixed.
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
        {state.status === "ready" && grants.length === 0 && (
          <p id={emptyId} tabIndex={-1} className="flex items-center gap-1.5 text-sm text-ink-secondary outline-none">
            <Icon name="lock" className="size-(--ph-icon-size-sm) shrink-0" />
            Can’t read anything outside {space.name}.
          </p>
        )}
        {grants.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-secondary">{space.name} can also read, without asking:</p>
            <ul aria-label={`What ${space.name} can read in other spaces`} className="flex flex-col rounded-md bg-surface-sunken">
              {grants.map((g, i) => {
                const from = spaceInfo(g.from);
                const date = grantDate(g.created);
                return (
                  // Same two-line layout as the title bar's grants popover: where from, then how long.
                  <li key={g.id} data-grant-row="" className="flex items-center gap-3 py-2 ps-3 pe-1.5 not-first:border-t not-first:border-line">
                    <div className="flex min-w-0 flex-1 items-start gap-x-2">
                      {/* One line tall, so the dot sits on the first line however the path wraps. */}
                      <span className="flex h-[1lh] shrink-0 items-center text-base">
                        <SpaceMark hue={from.hue} />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        {/* The path wraps anywhere, and a no-break space ties it to "Work /": the space name never sits alone on a line. */}
                        <span data-grant-where="" className="text-base wrap-anywhere">
                          {g.path ? (
                            <>
                              <span className="font-medium whitespace-nowrap text-ink">{from.name}</span>
                              <span aria-hidden="true" className="text-ink-secondary">
                                {" / "}
                              </span>
                              <span className="font-mono text-sm text-ink">{g.path}</span>
                            </>
                          ) : (
                            <span className="font-medium text-ink">All of {from.name}</span>
                          )}
                        </span>
                        <span className="text-xs text-ink-secondary">
                          {g.scope === "once" ? "This time only" : "Always"}
                          {date && ` · since ${date}`}
                        </span>
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-revoke=""
                      disabled={busy !== null}
                      aria-label={`Revoke ${space.name}’s access to ${grantLabel(g)}`}
                      onClick={() => void revoke(g, i)}
                      className="min-h-(--ph-target-min)"
                    >
                      {busy === g.id ? "Revoking…" : "Revoke"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
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
        <span className="font-mono text-xs text-ink-secondary">
          <span className="sr-only">Folder: </span>
          spaces/{space.id}
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
