import { Popover } from "radix-ui";
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import {
  commitRevokes,
  grantDate,
  grantNoun,
  revokeGrant,
  scheduleRevoke,
  shortPath,
  spaceInfo,
  undoRevoke,
  usePendingRevokes,
  useGrants,
} from "@/lib/grants";
import { openSettings } from "@/lib/open-settings";
import { useSpaces, type Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { announce } from "./announcer";
import { SpaceMark } from "./space-mark";

/** Below this width the chips show only a count and what it counts. */
const NARROW_QUERY = "(max-width: 767px)";

/** True while the window is narrower than NARROW_QUERY. */
function useNarrowWindow() {
  const [narrow, setNarrow] = useState(() => {
    try {
      return window.matchMedia(NARROW_QUERY).matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(NARROW_QUERY);
    } catch {
      return;
    }
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return narrow;
}

/** A path with a line-break opportunity after each slash, so a long one wraps between folders, not mid-name. */
function breakAfterSlashes(path: string): ReactNode {
  const parts = path.split("/");
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          /<wbr />
        </>
      )}
    </Fragment>
  ));
}

/**
 * One grant as a row of either chip. `other` is the space on the far side
 * (the one read, for "Also reads"; the one reading, for "Read by"). `who` and
 * `what` make the sentences: "<who> can no longer read <what>."
 */
type Row = {
  id: string;
  other: string;
  path: string;
  created: string;
  scope: "always" | "once";
  who: string;
  what: string;
};

type Direction = "out" | "in";

/**
 * The title bar's grant chips. "Also reads" (direction "out") shows when the
 * space can read places in other spaces; "Read by" (direction "in", quieter)
 * shows when other spaces can read places in this one, so the space being read
 * says so too. Both list the most recent grant first.
 *
 * Each chip is a button named by its visible text (WCAG 2.5.3) and described
 * by the whole sentence. In a narrow window it collapses to a count ("Also
 * reads 2 places"), so the space's name keeps its room. It opens a popover
 * listing each grant with Remove; only the list scrolls when it is taller than
 * the window.
 *
 * Remove is made at once (the grant stops working immediately); the row then
 * offers Undo, which puts the same grant back, for as long as the popover is
 * open (no timer takes it away while you are looking at it). Both are
 * announced, with what happens to what was already read: it stays in the
 * conversation that read it. "Remove all" asks first, inline, and is made at
 * once. One verb everywhere: Remove.
 *
 * Keyboard: Enter/Space opens; focus moves to the popover's heading (not to a
 * Remove button, so a second Enter cannot remove by accident); Tab moves
 * through the rows' buttons, Remove all and Manage in Settings; Escape closes
 * and returns focus to the chip. Remove moves focus to that row's Undo; Undo
 * moves it back to Remove; closing the popover ends the Undo time and its
 * rows go. When none are left and the chip goes away, focus moves to the
 * conversation.
 */
export function GrantsChip({ space, direction = "out" }: { space: Space; direction?: Direction }) {
  const { state } = useGrants(space.id);
  // Labels name other spaces by their display name: redraw when one is renamed.
  useSpaces();
  const { pending, revoked } = usePendingRevokes();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [confirmAll, setConfirmAll] = useState(false);
  const [busyAll, setBusyAll] = useState(false);
  const headingId = useId();
  const descId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  // Where focus goes after the next render: a row's Undo or Revoke, or the row at an index.
  const focusNext = useRef<{ undo: string } | { revoke: string } | { index: number } | "cancel-all" | "revoke-all" | null>(null);
  const toSettings = useRef(false);
  // Removes made from this chip still offering Undo; their Undo ends when the popover closes.
  const mine = useRef(new Set<string>());
  // The popover closed with every row removed: the chip goes, so focus goes to the conversation.
  const closingToMain = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const own = mine.current;
    return () => {
      mounted.current = false;
      commitRevokes(own);
    };
  }, []);
  const narrow = useNarrowWindow();
  const out = direction === "out";

  const all: Row[] =
    state.status !== "ready"
      ? []
      : out
        ? state.grants.map((g) => {
            const from = spaceInfo(g.from).name;
            return { ...g, other: g.from, who: space.name, what: g.path ? `${from} / ${g.path}` : `All of ${from}` };
          })
        : state.incoming.map((g) => ({
            ...g,
            other: g.to,
            who: spaceInfo(g.to).name,
            what: g.path ? `${space.name} / ${g.path}` : `All of ${space.name}`,
          }));
  // A grant revoked from here goes at once, before the list has reloaded.
  const rows = all.filter((r) => !revoked.has(r.id));

  // The rows as they are when a delayed revoke lands (its callback was made earlier).
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });

  // Close and clear when the space changes.
  useEffect(() => {
    setOpen(false);
    setError("");
    setConfirmAll(false);
  }, [space.id]);
  // Closed (by the user, or by moving to another space): Undo ends and the removed rows go.
  useEffect(() => {
    if (open) return;
    setConfirmAll(false);
    commitRevokes(mine.current);
    mine.current.clear();
  }, [open]);

  function onOpenChange(next: boolean) {
    // Every row removed: once the Undo ends, the chip goes with the popover.
    if (!next && rowsRef.current.length > 0 && rowsRef.current.every((r) => mine.current.has(r.id) && pending.has(r.id))) {
      closingToMain.current = true;
    }
    setOpen(next);
  }

  // After a revoke, an undo, or a row going away: put focus where it belongs.
  const rowIds = rows.map((r) => r.id).join();
  useLayoutEffect(() => {
    const want = focusNext.current;
    const root = contentRef.current;
    if (!want || !open || !root) return;
    focusNext.current = null;
    const q = (sel: string) => root.querySelector<HTMLElement>(sel);
    if (want === "cancel-all") return void q("[data-revoke-all-cancel]")?.focus();
    if (want === "revoke-all") return void q("[data-revoke-all]")?.focus();
    if ("undo" in want) return void (q(`[data-undo="${want.undo}"]`) ?? root).focus();
    if ("revoke" in want) return void (q(`[data-revoke="${want.revoke}"]`) ?? root).focus();
    const buttons = root.querySelectorAll<HTMLButtonElement>("li [data-row-action]");
    if (buttons.length) buttons[Math.min(want.index, buttons.length - 1)]?.focus();
    else document.getElementById(headingId)?.focus();
  }, [rowIds, pending, open, confirmAll, headingId]);

  if (rows.length === 0) return null;

  const first = rows[0];
  const more = rows.length - 1;
  const noun = grantNoun(rows, rows.length !== 1);
  const readers = [...new Set(rows.map((r) => r.other))];
  const sentence = out
    ? `${space.name} can also read ${rows.length} ${noun} in ${new Set(rows.map((r) => r.other)).size === 1 ? "another space" : "other spaces"}.`
    : `${readers.length === 1 ? spaceInfo(readers[0]).name : `${readers.length} other spaces`} can read ${rows.length} ${noun} in ${space.name}.`;

  function revoke(r: Row) {
    setError("");
    focusNext.current = { undo: r.id };
    mine.current.add(r.id);
    scheduleRevoke(r.id, (result) => {
      mine.current.delete(r.id);
      if ("error" in result) {
        // The only way a revoke fails is grants.json refusing the write; the raw OS error helps nobody here.
        console.error("grant_revoke failed:", result.error);
        const message = `Couldn’t remove access to ${r.what}. Phaethon couldn’t save the change in your Phaethon folder: check that the folder isn’t read-only, then try again.`;
        // Shown (and read, as an alert) in the popover; said by the shell when the popover is gone.
        if (contentRef.current) {
          if (document.activeElement?.getAttribute("data-undo") === r.id) focusNext.current = { revoke: r.id };
          setError(message);
        } else announce(message);
        return;
      }
      // Already said when Revoke was pressed; nothing more to announce here.
      if (!mounted.current) return;
      const now = rowsRef.current;
      const at = now.findIndex((x) => x.id === r.id);
      const focusWasHere = document.activeElement?.getAttribute("data-undo") === r.id;
      if (now.every((x) => x.id === r.id)) {
        // The chip is about to go: focus would fall to the page.
        if (contentRef.current?.contains(document.activeElement) || focusWasHere) document.getElementById("main")?.focus();
        setOpen(false);
      } else if (focusWasHere) {
        focusNext.current = { index: Math.max(0, at) };
      }
    });
    announce(`${r.who} can no longer read ${r.what}. Anything already read stays in ${r.who}’s conversation. Undo is next to it until you close this list.`);
  }

  function undo(r: Row) {
    if (!undoRevoke(r.id)) return;
    mine.current.delete(r.id);
    focusNext.current = { revoke: r.id };
    announce(`Undone. ${r.who} can still read ${r.what}.`);
  }

  async function revokeAll() {
    setBusyAll(true);
    setError("");
    let failed = 0;
    for (const r of rows) {
      // A row waiting out its Undo time is already revoked; revoking it again just finds it gone.
      try {
        await revokeGrant(r.id);
      } catch (e) {
        console.error("grant_revoke failed:", e);
        failed++;
      }
    }
    if (!mounted.current) return;
    setBusyAll(false);
    setConfirmAll(false);
    if (failed) {
      const message = `Couldn’t remove ${failed === rows.length ? "them" : `${failed} of them`}. Phaethon couldn’t save the change in your Phaethon folder: check that the folder isn’t read-only, then try again.`;
      setError(message);
      focusNext.current = { index: 0 };
      return;
    }
    announce(
      out
        ? `${space.name} can no longer read anything in other spaces. Anything already read stays in ${space.name}’s conversations.`
        : `No other space can read anything in ${space.name} now. Anything already read stays in their conversations.`,
    );
    setOpen(false);
    document.getElementById("main")?.focus();
  }

  const otherHue = (id: string) => spaceInfo(id).hue;

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-describedby={descId}
          {...(out ? { "data-grants-chip": "" } : { "data-grants-in-chip": "" })}
          className={cn(
            "flex min-h-(--ph-control-height-sm) min-w-0 items-center overflow-hidden gap-1.5 rounded-full border ps-2 pe-2.5 text-sm text-ink-secondary",
            "transition-colors duration-(--ph-duration-fast) hover:bg-hover hover:text-ink active:bg-selected",
            "data-[state=open]:bg-selected data-[state=open]:text-ink group-data-[inactive]/titlebar:text-ink-tertiary",
            // "Read by" is the quieter of the two: no fill, no shadow.
            out ? "ms-1 border-line-strong bg-raised shadow-sm" : "border-line bg-transparent",
          )}
        >
          <Icon name="link" className="size-(--ph-icon-size-sm) shrink-0" />
          {/* Each part carries its own separating space (inside the span, not as a loose text node
              between flex items), so the name reads as the visible text does. */}
          <span className="shrink-0">{out ? "Also reads " : "Read by "}</span>
          {out && narrow ? (
            // A narrow window: the count and what it counts ("2 places"), so the space's name keeps its room.
            <span className="min-w-0 truncate font-medium text-ink tabular-nums group-data-[inactive]/titlebar:text-ink-secondary">
              {`${rows.length} ${noun}`}
            </span>
          ) : !out && narrow && readers.length > 1 ? (
            <span className="min-w-0 truncate font-medium text-ink tabular-nums group-data-[inactive]/titlebar:text-ink-secondary">
              {`${readers.length} spaces`}
            </span>
          ) : (
            <>
              <SpaceMark hue={otherHue(first.other)} />
              <span className="max-w-(--ph-chip-name-width) min-w-0 truncate font-medium text-ink group-data-[inactive]/titlebar:text-ink-secondary">
                {out ? (first.path ? `${spaceInfo(first.other).name} / ${shortPath(first.path)}` : first.what) : spaceInfo(first.other).name}
              </span>
              {out
                ? more > 0 && <span className="shrink-0 tabular-nums">{` +${more} more`}</span>
                : readers.length > 1 && <span className="shrink-0 tabular-nums">{` +${readers.length - 1} more`}</span>}
            </>
          )}
        </button>
      </Popover.Trigger>
      {/* Outside the button, so it describes the chip without also becoming part of its name. */}
      <span id={descId} className="sr-only">
        {sentence}
      </span>
      <Popover.Portal>
        <Popover.Content
          ref={contentRef}
          tabIndex={-1}
          aria-labelledby={headingId}
          align="start"
          sideOffset={6}
          collisionPadding={8}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            // The heading, not the whole panel: a screen reader reads it, and the ring stays small.
            document.getElementById(headingId)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // The chip is going (every row removed): the conversation takes focus, not the page.
            if (closingToMain.current) {
              closingToMain.current = false;
              e.preventDefault();
              document.getElementById("main")?.focus();
              return;
            }
            // Going to Settings: the settings window takes focus.
            if (!toSettings.current) return;
            toSettings.current = false;
            e.preventDefault();
            openSettings("spaces");
          }}
          className={cn(
            // As wide as 320px at the default text size, growing with it; never wider or taller than the room.
            // The list scrolls first; if even the heading and footer do not fit (very large text), the whole panel scrolls.
            "z-50 flex max-h-(--radix-popover-content-available-height) w-[calc(320px*var(--ph-ui-scale))] max-w-(--radix-popover-content-available-width) flex-col overflow-y-auto rounded-lg border border-line bg-raised text-ink shadow-lg outline-none",
            "origin-(--radix-popover-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97]",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          )}
        >
          <div className="flex shrink-0 flex-col gap-0.5 px-4 pt-3.5 pb-2.5">
            <h2 id={headingId} tabIndex={-1} className="self-start rounded-xs text-md font-semibold text-ink">
              {out ? `${space.name} can also read` : `Who can read ${space.name}`}
            </h2>
            <p className="text-sm text-ink-secondary">
              {out
                ? "Read-only. For anything else in another space, Phaethon asks you first. Removing access stops future reads; anything already read stays in this space’s conversation."
                : "Read-only, and only these places. Removing access stops future reads; anything already read stays in that space’s conversation."}
            </p>
          </div>
          {/* The list scrolls; the heading and the footer stay in view. */}
          <ul
            className={cn(
              // One grant never shrinks; more keep at least about two rows in view before the panel itself scrolls.
              rows.length > 1 ? "min-h-[calc(var(--ph-control-height-lg)*2.5)]" : "shrink-0",
              "flex flex-col divide-y divide-line overflow-y-auto overscroll-contain border-t border-line",
            )}
            aria-label={out ? `What ${space.name} can read` : `Who can read ${space.name}`}
          >
            {rows.map((r) => {
              const date = grantDate(r.created);
              const other = spaceInfo(r.other);
              const waiting = pending.has(r.id);
              return (
                <li key={r.id} data-grant-row={r.id} className="flex shrink-0 items-center gap-3 px-4 py-2.5">
                  {/* items-start: when the path wraps, the dot stays on the first line, beside the space's name. */}
                  <div
                    className={cn(
                      "grid min-w-0 flex-1 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 text-base",
                      waiting && "text-ink-secondary",
                    )}
                  >
                    {/* One line tall, so the dot centres on the first line at any text size. */}
                    <span data-grant-dot="" className="flex h-[1lh] items-center">
                      <SpaceMark hue={other.hue} />
                    </span>
                    {out ? (
                      r.path ? (
                        // The path wraps rather than truncates: its end is often what tells two grants apart.
                        // No-break spaces join the name, the slash and the path, so the name never sits alone
                        // on a line; the path then breaks after a slash where it can.
                        <span data-grant-label="" className={cn("min-w-0", waiting && "line-through")}>
                          <span className={cn("font-medium", waiting ? "text-ink-secondary" : "text-ink")}>{other.name}</span>
                          {" "}
                          <span aria-hidden="true" className="text-ink-secondary">
                            /
                          </span>
                          {" "}
                          <span className={cn("font-mono text-sm wrap-anywhere", waiting ? "text-ink-secondary" : "text-ink")}>
                            {breakAfterSlashes(r.path)}
                          </span>
                        </span>
                      ) : (
                        <span data-grant-label="" className={cn("min-w-0 font-medium", waiting ? "text-ink-secondary line-through" : "text-ink")}>
                          {r.what}
                        </span>
                      )
                    ) : (
                      // Read by: who reads first, then what in this space.
                      <span data-grant-label="" className={cn("min-w-0", waiting && "line-through")}>
                        <span className={cn("font-medium", waiting ? "text-ink-secondary" : "text-ink")}>{other.name}</span>
                        <span className="text-ink-secondary">{" reads "}</span>
                        {r.path ? (
                          <span className={cn("font-mono text-sm wrap-anywhere", waiting ? "text-ink-secondary" : "text-ink")}>
                            {breakAfterSlashes(r.path)}
                          </span>
                        ) : (
                          <span className={waiting ? "text-ink-secondary" : "text-ink"}>{`all of ${space.name}`}</span>
                        )}
                      </span>
                    )}
                    <span className="col-start-2 text-xs text-ink-secondary">
                      {waiting ? "Removed. Undo stays here until you close this list." : (
                        <>
                          {r.scope === "once" ? "This time only" : "Always"}
                          {date && ` · since ${date}`}
                        </>
                      )}
                    </span>
                  </div>
                  {waiting ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      data-undo={r.id}
                      data-row-action=""
                      aria-label={`Undo removing ${r.what}`}
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
                      disabled={busyAll}
                      aria-label={out ? `Remove access to ${r.what}` : `Remove ${r.who}’s access to ${r.what}`}
                      onClick={() => revoke(r)}
                      className="min-h-(--ph-target-min)"
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {error && (
            <p role="alert" className="mx-4 my-2 flex shrink-0 items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
            </p>
          )}
          {out && state.status === "ready" && state.problems.length > 0 && (
            <p className="mx-4 my-2 flex shrink-0 items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-ink">
              <Icon name="warning" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0 flex-1">Some saved grants were ignored. Settings explains which.</span>
            </p>
          )}
          {confirmAll ? (
            // Inline confirm: says what will change, the safe choice first and focused.
            <div role="group" aria-labelledby={`${headingId}-all`} className="flex shrink-0 flex-col gap-2 border-t border-line px-4 py-2.5">
              <p id={`${headingId}-all`} className="text-sm text-ink">
                {out
                  ? `Remove all ${rows.length}? ${space.name} will no longer be able to read ${rows.length === 1 ? "it" : "any of them"}.`
                  : `Remove all ${rows.length}? ${readers.length === 1 ? spaceInfo(readers[0]).name : "Other spaces"} will no longer be able to read ${rows.length === 1 ? "it" : "any of them"}.`}
              </p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-revoke-all-cancel=""
                  disabled={busyAll}
                  onClick={() => {
                    focusNext.current = "revoke-all";
                    setConfirmAll(false);
                  }}
                  className="min-h-(--ph-target-min)"
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  data-revoke-all-confirm=""
                  disabled={busyAll}
                  onClick={() => void revokeAll()}
                  className="min-h-(--ph-target-min)"
                >
                  {busyAll ? "Removing…" : `Remove all ${rows.length}`}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 border-t border-line px-4 py-2">
              <Button
                type="button"
                variant="link"
                className="min-h-(--ph-target-min) text-sm"
                onClick={() => {
                  toSettings.current = true;
                  setOpen(false);
                }}
              >
                Manage in Settings
              </Button>
              {rows.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  data-revoke-all=""
                  onClick={() => {
                    focusNext.current = "cancel-all";
                    setConfirmAll(true);
                  }}
                  className="min-h-(--ph-target-min) text-danger-ink hover:text-danger-ink"
                >
                  Remove all…
                </Button>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
