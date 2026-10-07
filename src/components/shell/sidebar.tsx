import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Icon } from "@/icons";
import { useSpaceActivity, type SpaceActivity } from "@/lib/activity";
import type { Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { spaceHueStyle, SpaceMark } from "./space-mark";

type Props = {
  id: string;
  spaces: readonly Space[];
  activeId: string;
  onSelect: (id: string) => void;
  /** False hides the whole sidebar (and takes it out of the tab order). */
  open: boolean;
  /**
   * True in a narrow window: the open sidebar lies over the conversation
   * instead of squeezing it. Focus stays inside it; Escape, a click outside
   * and choosing a space close it (onDismiss).
   */
  overlay?: boolean;
  /** Pinned below the list (the Settings entry). */
  footer?: ReactNode;
  /** Given while the sidebar is a temporary one (narrow window): Escape inside it, or a click outside it, calls this. */
  onDismiss?: () => void;
  /** Opens the New space dialog. */
  onNewSpace: () => void;
  /** The list is still loading: no empty-state line yet. */
  loading?: boolean;
};

/** What a space is doing, as shown beside its name and as spoken after it. */
function activityWords(a: SpaceActivity | undefined): { shown: string; spoken: string; urgent: boolean } | null {
  if (a?.needsYou) return { shown: "Needs you", spoken: "needs your answer", urgent: true };
  if (a?.running) return { shown: "Answering…", spoken: "answering", urgent: false };
  return null;
}

/** Everything Tab can reach inside `root`, in order. */
const tabbables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
    (el) => el.getClientRects().length > 0,
  );

/**
 * Space switcher. Every item is a native button (Tab reaches each one);
 * ArrowUp/ArrowDown/Home/End also move focus within the list and on to "New
 * space" at its end. The current space is marked with aria-current and shown
 * in its own hue.
 *
 * Each space says what it is doing while you are elsewhere: a quiet
 * "Answering…" while a reply runs, a clear "Needs you" while a card waits for
 * your answer. Its accessible name is its text, each part said once: the
 * name, that state in words, the description ("School, needs your answer,
 * Courses, deadlines, study notes"); no separate description repeats it.
 *
 * A vault with no spaces says so above "New space".
 */
export function Sidebar({ id, spaces, activeId, onSelect, open, overlay = false, footer, onDismiss, onNewSpace, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const activity = useSpaceActivity();
  // Open over the conversation right now.
  const over = overlay && open;

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i === -1) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % buttons.length;
    else if (e.key === "ArrowUp") next = (i - 1 + buttons.length) % buttons.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = buttons.length - 1;
    if (next !== null) {
      e.preventDefault();
      buttons[next]?.focus();
    }
  }

  function onNavKeyDown(e: KeyboardEvent<HTMLElement>) {
    // Only keys pressed in the sidebar itself: React also bubbles events from
    // portals (the Settings dialog), whose keys belong to the dialog.
    if (!e.currentTarget.contains(e.target as Node)) return;
    if (e.key === "Escape" && onDismiss) {
      e.preventDefault();
      onDismiss();
      return;
    }
    // Over the conversation, Tab cycles inside the sidebar (the conversation behind it is inert).
    if (e.key === "Tab" && over) {
      const all = tabbables(e.currentTarget);
      if (!all.length) return;
      const first = all[0];
      const last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Opening over the conversation: focus goes to the current space, ready to choose.
  useEffect(() => {
    if (!over) return;
    const nav = navRef.current;
    if (!nav || nav.contains(document.activeElement)) return;
    (nav.querySelector<HTMLElement>('[aria-current="page"]') ?? nav.querySelector<HTMLElement>("button"))?.focus();
  }, [over]);

  // Over the conversation, a press anywhere outside closes it (the toggle toggles it itself;
  // dialogs and popovers opened from it are not "outside").
  useEffect(() => {
    if (!over || !onDismiss) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || navRef.current?.contains(t)) return;
      if (t.closest(`[aria-controls="${id}"], [role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]`)) return;
      onDismiss();
      // A press on something that cannot take focus (the dimmed conversation) blurs to the page
      // after this; put focus back on the toggle then.
      setTimeout(() => {
        if (document.activeElement === document.body) document.querySelector<HTMLElement>(`[aria-controls="${id}"]`)?.focus();
      }, 0);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [over, onDismiss, id]);

  return (
    <>
      {/* Behind the overlaid sidebar: dims the conversation; a press on it closes the sidebar. */}
      {over && <div aria-hidden="true" data-sidebar-scrim="" className="absolute inset-0 z-20 bg-(--ph-overlay)" />}
      <nav
        ref={navRef}
        id={id}
        onKeyDown={onNavKeyDown}
        aria-labelledby="spaces-heading"
        hidden={!open}
        data-shell-chrome=""
        data-overlay={over ? "" : undefined}
        className={cn(
          "flex w-(--ph-sidebar-width) shrink-0 flex-col bg-surface text-ink",
          overlay &&
            "absolute inset-y-0 start-0 z-30 max-w-[calc(100%-var(--ph-space)*12)] rounded-e-lg border-e border-t border-line shadow-lg forced-colors:border-[CanvasText]",
        )}
      >
        <h2 id="spaces-heading" className="px-4 pt-2 text-xs font-medium text-ink-secondary">
          Spaces
        </h2>
        <ScrollArea className="min-h-0 flex-1">
          {/* p-2 on every side: the scroll viewport clips, and the focus ring sits outside each item. */}
          <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-0.5 p-2">
            {!loading && spaces.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-secondary">No spaces yet.</p>}
            <ul className="flex flex-col gap-0.5 empty:hidden">
              {spaces.map((space) => {
                const active = space.id === activeId;
                const doing = activityWords(activity[space.id]);
                return (
                  <li key={space.id}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      // Named by its own text, each part once: "School, needs your answer, Courses, deadlines…".
                      // (Not an aria-label: the description it shows belongs in the name too, WCAG 2.5.3.)
                      onClick={() => onSelect(space.id)}
                      data-space-hue=""
                      data-space-id={space.id}
                      data-space-status={doing ? (doing.urgent ? "needs-you" : "running") : undefined}
                      style={spaceHueStyle(space.hue)}
                      className={cn(
                        // Two rows: the dot centres on the name row, the description sits under the name.
                        "grid w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-start",
                        "transition-colors duration-(--ph-duration-fast)",
                        // In a background window the selection greys, as macOS does.
                        active ? "bg-space-tint group-data-[inactive]/app:bg-selected" : "hover:bg-hover active:bg-selected",
                      )}
                    >
                      <SpaceMark hue={space.hue} />
                      <span className={cn("truncate text-base text-ink", active ? "font-semibold" : "font-medium")}>
                        {/* Spoken as one piece of text, so no stray space lands before a comma. */}
                        <span aria-hidden="true">{space.name}</span>
                        <span className="sr-only">{`${space.name}${doing ? `, ${doing.spoken}` : ""}${space.description ? "," : ""}`}</span>
                      </span>
                      {doing ? (
                        <span
                          aria-hidden="true"
                          data-space-activity=""
                          className={cn(
                            "flex shrink-0 items-center gap-1 text-xs",
                            doing.urgent
                              ? "rounded-full bg-warning-soft px-1.5 font-semibold text-warning-ink forced-colors:border forced-colors:border-[CanvasText]"
                              : "text-ink-secondary",
                          )}
                        >
                          {doing.urgent ? (
                            <Icon name="warning" className="size-(--ph-icon-size-sm)" />
                          ) : (
                            <Icon name="spinner" className="size-(--ph-icon-size-sm) motion-safe:animate-spin" />
                          )}
                          {doing.shown}
                        </span>
                      ) : (
                        <span />
                      )}
                      {space.description && (
                        <span className="col-span-2 col-start-2 truncate text-xs text-ink-secondary">
                          {space.description}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {/* Same columns as a space, so "New space" lines up with the names above it. */}
            <button
              type="button"
              data-new-space=""
              onClick={onNewSpace}
              className={cn(
                "grid min-h-(--ph-control-height) w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-center gap-x-2.5 rounded-md px-2 py-1 text-start",
                "text-base text-ink-secondary transition-colors duration-(--ph-duration-fast) hover:bg-hover hover:text-ink active:bg-selected",
              )}
            >
              <Icon name="plus" className="size-(--ph-icon-size-sm) justify-self-center" />
              <span className="truncate">New space</span>
            </button>
          </div>
        </ScrollArea>
        {footer && <div className="px-2 pt-1 pb-2">{footer}</div>}
      </nav>
    </>
  );
}
