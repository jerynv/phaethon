import { Popover } from "radix-ui";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { grantDate, grantLabel, grantNoun, revokeGrant, shortPath, spaceInfo, useGrants, type GrantView } from "@/lib/grants";
import { openSettings } from "@/lib/open-settings";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { SpaceMark } from "./space-mark";

/** Below this width the chip shows only its count and noun. */
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

/** The chip's short form of a grant: the path shortened in the middle, so the part that tells it apart shows. */
function chipLabel(g: GrantView): string {
  return g.path ? `${spaceInfo(g.from).name} / ${shortPath(g.path)}` : grantLabel(g);
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
 * The title bar's "can also read" chip: shown only when the active space has
 * saved read-only grants into other spaces, so access is visible up front
 * (like a browser's site-permission chip). It is a button named by its
 * visible text (WCAG 2.5.3: "Also reads Work / calendar +1 more") and
 * described by the whole sentence. In a narrow window it collapses to "Also
 * reads 2 places" (the count and what it counts), so the space's name keeps
 * its room. It opens a popover listing
 * each grant with Revoke; only the list scrolls when it is taller than the
 * window.
 *
 * Keyboard: Enter/Space opens; focus moves to the popover itself (not to a
 * Revoke button, so a second Enter cannot revoke by accident); Tab moves
 * through Revoke buttons and "Manage in Settings"; Escape closes and returns
 * focus to the chip. Revoking moves focus to the next grant's Revoke, or, when
 * none are left and the chip goes away, to the conversation.
 */
export function GrantsChip({ space, announce }: { space: Space; announce: (message: string) => void }) {
  const { state } = useGrants(space.id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const headingId = useId();
  const descId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  const toSettings = useRef(false);
  const grants = state.status === "ready" ? state.grants : [];
  const narrow = useNarrowWindow();

  // Close and clear when the space changes.
  useEffect(() => {
    setOpen(false);
    setError("");
  }, [space.id]);

  // After a revoke, put focus on the Revoke button that took the removed one's place.
  useEffect(() => {
    const i = focusAfter.current;
    if (i === null || !open) return;
    focusAfter.current = null;
    const buttons = contentRef.current?.querySelectorAll<HTMLButtonElement>("[data-revoke]");
    if (buttons?.length) buttons[Math.min(i, buttons.length - 1)]?.focus();
    else contentRef.current?.focus();
  }, [grants, open]);

  if (grants.length === 0) return null;

  const first = grants[0];
  const more = grants.length - 1;
  const noun = grantNoun(grants, grants.length !== 1);
  const sentence = `${space.name} can also read ${grants.length} ${noun} in ${new Set(grants.map((g) => g.from)).size === 1 ? "another space" : "other spaces"}.`;

  async function revoke(g: GrantView, index: number) {
    setBusy(g.id);
    setError("");
    try {
      const removed = await revokeGrant(g.id);
      if (grants.length === 1) {
        // The chip is about to go: focus would fall to the page.
        setOpen(false);
        document.getElementById("main")?.focus();
      } else {
        focusAfter.current = index;
      }
      announce(removed ? `${space.name} can no longer read ${grantLabel(g)}.` : `${grantLabel(g)} was already removed.`);
    } catch (e) {
      // The only way a revoke fails is grants.json refusing the write; the raw OS error helps nobody here.
      console.error("grant_revoke failed:", e);
      setError(`Couldn’t revoke ${grantLabel(g)}. grants.json can’t be written: check the vault folder’s permissions, then try again.`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-describedby={descId}
          data-grants-chip=""
          className={cn(
            "ms-1 flex min-h-(--ph-control-height-sm) min-w-0 items-center gap-1.5 rounded-full border border-line-strong bg-raised ps-2 pe-2.5 text-sm text-ink-secondary shadow-sm",
            "transition-colors duration-(--ph-duration-fast) hover:bg-hover hover:text-ink active:bg-selected",
            "data-[state=open]:bg-selected data-[state=open]:text-ink group-data-[inactive]/titlebar:text-ink-tertiary",
          )}
        >
          <Icon name="link" className="size-(--ph-icon-size-sm) shrink-0" />
          {/* Each part carries its own separating space (inside the span, not as a loose text node
              between flex items), so the name reads as the visible text does. */}
          <span className="shrink-0">{"Also reads "}</span>
          {narrow ? (
            // A narrow window: the count and what it counts ("2 places"), so the space's name keeps its room.
            <span className="shrink-0 font-medium text-ink tabular-nums group-data-[inactive]/titlebar:text-ink-secondary">
              {`${grants.length} ${noun}`}
            </span>
          ) : (
            <>
              <SpaceMark hue={spaceInfo(first.from).hue} />
              <span className="max-w-(--ph-chip-name-width) min-w-0 truncate font-medium text-ink group-data-[inactive]/titlebar:text-ink-secondary">
                {chipLabel(first)}
              </span>
              {more > 0 && <span className="shrink-0 tabular-nums">{` +${more} more`}</span>}
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
              {space.name} can also read
            </h2>
            <p className="text-sm text-ink-secondary">Read-only. For anything else in another space, Phaethon asks you first.</p>
          </div>
          {/* The list scrolls; the heading and "Manage in Settings" stay in view. */}
          <ul
            className={cn(
              // One grant never shrinks; more keep at least about two rows in view before the panel itself scrolls.
              grants.length > 1 ? "min-h-[calc(var(--ph-control-height-lg)*2.5)]" : "shrink-0",
              "flex flex-col divide-y divide-line overflow-y-auto overscroll-contain border-t border-line",
            )}
            aria-label={`What ${space.name} can read`}
          >
            {grants.map((g, i) => {
              const date = grantDate(g.created);
              const from = spaceInfo(g.from);
              return (
                <li key={g.id} className="flex shrink-0 items-center gap-3 px-4 py-2.5">
                  {/* items-start: when the path wraps, the dot stays on the first line, beside the space's name. */}
                  <div className="grid min-w-0 flex-1 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 text-base">
                    {/* One line tall, so the dot centres on the first line at any text size. */}
                    <span data-grant-dot="" className="flex h-[1lh] items-center">
                      <SpaceMark hue={from.hue} />
                    </span>
                    {g.path ? (
                      // The path wraps rather than truncates: its end is often what tells two grants apart.
                      // No-break spaces join the name, the slash and the path, so the name never sits alone
                      // on a line; the path then breaks after a slash where it can.
                      <span data-grant-label="" className="min-w-0">
                        <span className="font-medium text-ink">{from.name}</span>
                        {" "}
                        <span aria-hidden="true" className="text-ink-secondary">
                          /
                        </span>
                        {" "}
                        <span className="font-mono text-sm wrap-anywhere text-ink">{breakAfterSlashes(g.path)}</span>
                      </span>
                    ) : (
                      <span data-grant-label="" className="min-w-0 font-medium text-ink">
                        {grantLabel(g)}
                      </span>
                    )}
                    <span className="col-start-2 text-xs text-ink-secondary">
                      {g.scope === "once" ? "This time only" : "Always"}
                      {date && ` · since ${date}`}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    data-revoke=""
                    disabled={busy !== null}
                    aria-label={`Revoke access to ${grantLabel(g)}`}
                    onClick={() => void revoke(g, i)}
                    className="min-h-(--ph-target-min)"
                  >
                    {busy === g.id ? "Revoking…" : "Revoke"}
                  </Button>
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
          {state.status === "ready" && state.problems.length > 0 && (
            <p className="mx-4 my-2 flex shrink-0 items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-ink">
              <Icon name="warning" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0 flex-1">Some saved grants were ignored. Settings explains which.</span>
            </p>
          )}
          <div className="flex shrink-0 items-center border-t border-line px-4 py-2">
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
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
