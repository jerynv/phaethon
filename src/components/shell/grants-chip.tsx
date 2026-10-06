import { Popover } from "radix-ui";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { grantDate, grantLabel, grantNoun, revokeGrant, spaceInfo, useGrants, type GrantView } from "@/lib/grants";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { SpaceMark } from "./space-mark";

/**
 * Opens Settings at the Spaces section. Settings owns its own open state, so
 * this presses its trigger and then the Spaces tab, as a person would.
 */
function openSettingsAtSpaces() {
  const trigger = document.querySelector<HTMLElement>('[data-testid="open-settings"]');
  if (!trigger) return false;
  trigger.click();
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="settings-tab-spaces"]')?.click());
  return true;
}

/**
 * The title bar's "can also read" chip: shown only when the active space has
 * saved read-only grants into other spaces, so access is visible up front
 * (like a browser's site-permission chip). It is a button whose accessible
 * name starts with its visible text (WCAG 2.5.3) and then says the whole
 * thing. It opens a popover listing each grant with Revoke.
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
  const contentRef = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<number | null>(null);
  const toSettings = useRef(false);
  const grants = state.status === "ready" ? state.grants : [];

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
  const visible = `Also reads ${grantLabel(first)}${more ? ` +${more} more` : ""}`;
  const noun = grantNoun(grants, grants.length !== 1);
  const spoken = `${visible}. ${space.name} can also read ${grants.length} ${noun} in ${new Set(grants.map((g) => g.from)).size === 1 ? "another space" : "other spaces"}.`;

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
      setError(`Could not revoke access to ${grantLabel(g)}: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={spoken}
          data-grants-chip=""
          className={cn(
            "ms-1 flex h-(--st-control-height-sm) min-w-0 items-center gap-1.5 rounded-full border border-line-strong bg-raised ps-2 pe-2.5 text-sm text-ink-secondary shadow-sm",
            "transition-colors duration-(--st-duration-fast) hover:bg-hover hover:text-ink active:bg-selected",
            "data-[state=open]:bg-selected data-[state=open]:text-ink group-data-[inactive]/titlebar:text-ink-tertiary",
          )}
        >
          <Icon name="link" className="size-(--st-icon-size-sm)" />
          <span className="shrink-0">Also reads</span>
          <SpaceMark hue={spaceInfo(first.from).hue} />
          <span className="max-w-(--st-chip-name-width) truncate font-medium text-ink group-data-[inactive]/titlebar:text-ink-secondary">
            {grantLabel(first)}
          </span>
          {more > 0 && <span className="shrink-0 tabular-nums">+{more} more</span>}
        </button>
      </Popover.Trigger>
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
            // Going to Settings: the settings window takes focus, and returns it to its own trigger.
            if (!toSettings.current) return;
            toSettings.current = false;
            e.preventDefault();
            openSettingsAtSpaces();
          }}
          className={cn(
            "z-50 flex w-80 max-w-(--radix-popover-content-available-width) flex-col rounded-lg border border-line bg-raised text-ink shadow-lg outline-none",
            "origin-(--radix-popover-content-transform-origin) animate-in duration-(--st-duration-fast) fade-in-0 zoom-in-[0.97]",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          )}
        >
          <div className="flex flex-col gap-0.5 px-4 pt-3.5 pb-2.5">
            <h2 id={headingId} tabIndex={-1} className="self-start rounded-xs text-md font-semibold text-ink">
              {space.name} can also read
            </h2>
            <p className="text-sm text-ink-secondary">Read-only. For anything else in another space, steward asks you first.</p>
          </div>
          <ul className="flex flex-col divide-y divide-line border-t border-line" aria-label={`What ${space.name} can read`}>
            {grants.map((g, i) => {
              const date = grantDate(g.created);
              return (
                <li key={g.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="grid min-w-0 flex-1 grid-cols-[var(--st-space-mark-size)_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
                    <SpaceMark hue={spaceInfo(g.from).hue} />
                    <span className="flex min-w-0 items-baseline gap-1.5 text-base">
                      <span className="shrink-0 font-medium text-ink">{spaceInfo(g.from).name}</span>
                      <span aria-hidden="true" className="text-ink-secondary">/</span>
                      <span className="min-w-0 truncate font-mono text-sm text-ink" title={g.path}>
                        {g.path}
                      </span>
                    </span>
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
                    className="min-h-(--st-target-min)"
                  >
                    {busy === g.id ? "Revoking…" : "Revoke"}
                  </Button>
                </li>
              );
            })}
          </ul>
          {error && (
            <p role="alert" className="mx-3 mb-1 flex items-start gap-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 size-(--st-icon-size-sm)" />
              <span className="min-w-0 flex-1">{error}</span>
            </p>
          )}
          {state.status === "ready" && state.problems.length > 0 && (
            <p className="mx-3 mb-1 flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-ink">
              <Icon name="warning" className="mt-0.5 size-(--st-icon-size-sm)" />
              <span className="min-w-0 flex-1">Some saved grants were ignored. Settings explains which.</span>
            </p>
          )}
          <div className="flex items-center border-t border-line px-4 py-2">
            <Button
              type="button"
              variant="link"
              className="min-h-(--st-target-min) text-sm"
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
