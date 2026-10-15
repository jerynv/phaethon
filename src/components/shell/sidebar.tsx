import { ContextMenu } from "radix-ui";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { openCourseImport } from "@/components/lms/import-store";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Icon } from "@/icons";
import { useSpaceActivity, type SpaceActivity } from "@/lib/activity";
import { openSettings } from "@/lib/open-settings";
import { holdSpaceOrder, markSpaceUsed, type Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { addToSpace, exportSpace, showInLabel, showSpaceFolder, SpaceActionNotice } from "./space-actions";
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

const NEEDS_YOU = { shown: "Needs you", spoken: "needs your answer", urgent: true };
const ANSWERING = { shown: "Answering…", spoken: "answering", urgent: false };
/** Every state a space's activity can show, so its place is as wide as the widest. */
const ACTIVITY_SHOWN = [NEEDS_YOU, ANSWERING];

/** What a space is doing, as shown beside its name and as spoken after it. */
function activityWords(a: SpaceActivity | undefined): { shown: string; spoken: string; urgent: boolean } | null {
  if (a?.needsYou) return NEEDS_YOU;
  if (a?.running) return ANSWERING;
  return null;
}

/** Everything Tab can reach inside `root`, in order. */
const tabbables = (root: HTMLElement) =>
  Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(
    (el) => el.getClientRects().length > 0,
  );

/** Shift+F10 or the context-menu key: open the focused space's menu. */
const isMenuKey = (e: KeyboardEvent) => e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey);

/** Focus that shows (from the keyboard), not the focus a click leaves on a button. */
function focusShows(el: Element | null): boolean {
  try {
    return !!el?.matches(":focus-visible");
  } catch {
    return true;
  }
}

/**
 * Space switcher. Every item is a native button (Tab reaches each one);
 * ArrowUp/ArrowDown/Home/End also move focus within the list and on to "New
 * space" at its end. The current space is marked with aria-current and shown
 * in its own hue.
 *
 * Spaces are listed most recently used first (src/lib/spaces.ts). The order
 * holds still while the pointer is over the sidebar, keyboard focus is in it
 * or a space's menu is open, so nothing moves under the pointer or the focus;
 * it catches up once they leave.
 *
 * Each space has a menu (Show in Finder, Export…, Import courses…, Edit name and colour…): a
 * right-click anywhere on it, Shift+F10 or the context-menu key on it, or its
 * More button, which shows on the current space and on the one pointed at or
 * focused. From a space, ArrowRight goes to its More button and ArrowLeft back
 * (the conversations menu's Delete works the same way); More is not a Tab stop
 * of its own, so Tab still steps space by space.
 *
 * Each space says what it is doing while you are elsewhere: a quiet
 * "Answering…" while a reply runs, a clear "Needs you" while a card waits for
 * your answer. Its accessible name is its text, each part said once: the
 * name, that state in words, the description ("School, needs your answer,
 * Courses, deadlines, study notes"); no separate description repeats it.
 * The name never gives way to that state: when both do not fit on one line,
 * the state moves to a line of its own under the name.
 *
 * The items stand apart (a gap that grows with Larger click targets), so a
 * slip off one never lands on its neighbour's edge.
 *
 * A vault with no spaces says so above "New space".
 */
export function Sidebar({ id, spaces, activeId, onSelect, open, overlay = false, footer, onDismiss, onNewSpace, loading }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const activity = useSpaceActivity();
  // Open over the conversation right now.
  const over = overlay && open;

  // A reply starting or ending in a space counts as using it (the core has noted it too).
  const lastRunning = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const [spaceId, a] of Object.entries(activity)) {
      if (a.running !== (lastRunning.current[spaceId] ?? false)) markSpaceUsed(spaceId, false);
      lastRunning.current[spaceId] = a.running;
    }
  }, [activity]);

  // A hidden sidebar holds nothing.
  useEffect(() => {
    if (open) return;
    holdSpaceOrder("pointer", false);
    holdSpaceOrder("focus", false);
  }, [open]);
  useEffect(
    () => () => {
      holdSpaceOrder("pointer", false);
      holdSpaceOrder("focus", false);
      holdSpaceOrder("menu", false);
    },
    [],
  );

  // A space's menu holds the order from opening until focus has gone back (or on) after it closes,
  // so focus returning to its space finds it where it was.
  function holdForMenu(on: boolean) {
    // The menu's layer can hide the pointer from the sidebar; if it is still over it, keep holding.
    if (!on && navRef.current?.matches(":hover")) holdSpaceOrder("pointer", true);
    holdSpaceOrder("menu", on);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("[data-space-id], [data-new-space]") ?? []);
    const at = document.activeElement as HTMLElement | null;
    // On a More button, the arrows move from its space.
    const from = at?.closest("li")?.querySelector<HTMLButtonElement>("[data-space-id]") ?? at;
    const i = items.indexOf(from as HTMLButtonElement);
    if (i === -1) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    if (next !== null) {
      e.preventDefault();
      items[next]?.focus();
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
      if (t.closest(`[aria-controls="${id}"], [role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper], [data-space-action-notice]`)) return;
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
        // While pointed at or focused from the keyboard, the order holds still.
        onPointerEnter={() => holdSpaceOrder("pointer", true)}
        onPointerLeave={() => holdSpaceOrder("pointer", false)}
        onFocus={(e) => holdSpaceOrder("focus", focusShows(e.target))}
        onBlur={(e) => {
          if (!navRef.current?.contains(e.relatedTarget as Node | null)) holdSpaceOrder("focus", false);
        }}
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
          <div ref={listRef} onKeyDown={onKeyDown} className="flex flex-col gap-(--ph-sidebar-item-gap) p-2">
            {!loading && spaces.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-secondary">No spaces yet.</p>}
            <ul className="flex flex-col gap-(--ph-sidebar-item-gap) empty:hidden">
              {spaces.map((space) => (
                <SpaceItem
                  key={space.id}
                  space={space}
                  active={space.id === activeId}
                  doing={activityWords(activity[space.id])}
                  onSelect={onSelect}
                  holdForMenu={holdForMenu}
                />
              ))}
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
      <SpaceActionNotice />
    </>
  );
}

type ItemProps = {
  space: Space;
  active: boolean;
  doing: ReturnType<typeof activityWords>;
  onSelect: (id: string) => void;
  /** True when the menu opens; false once it has closed and focus has moved. */
  holdForMenu: (on: boolean) => void;
};

const itemClass =
  "flex min-h-(--ph-control-height) cursor-default items-center gap-2 rounded-md px-2.5 text-base text-ink outline-none select-none data-highlighted:bg-hover data-disabled:opacity-45";

/** One space in the list, with its menu. */
function SpaceItem({ space, active, doing, onSelect, holdForMenu }: ItemProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  // Run once the menu has closed and focus is back on the space.
  const after = useRef<(() => void) | null>(null);
  const pressedOutside = useRef(false);
  // A space that leaves the list with its menu open must not leave the order held.
  const openRef = useRef(false);
  openRef.current = menuOpen;
  useEffect(() => () => void (openRef.current && holdSpaceOrder("menu", false)), []);

  /** Open the menu as a right-click at (x, y) would. */
  function openMenuAt(x: number, y: number) {
    buttonRef.current?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  }

  function onButtonKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (isMenuKey(e)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      openMenuAt(r.left, r.bottom);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      moreRef.current?.focus();
    }
  }

  function onMoreKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      buttonRef.current?.focus();
    } else if (isMenuKey(e)) {
      e.preventDefault();
      e.currentTarget.click();
    }
  }

  function choose(action: () => void) {
    after.current = action;
  }

  return (
    <ContextMenu.Root
      modal={false}
      onOpenChange={(o) => {
        setMenuOpen(o);
        if (o) holdForMenu(true);
      }}
    >
      <ContextMenu.Trigger asChild>
        <li className="group/space relative" data-space-item={space.id}>
          <button
            ref={buttonRef}
            type="button"
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts="Shift+F10"
            // Named by its own text, each part once: "School, needs your answer, Courses, deadlines…".
            // (Not an aria-label: the description it shows belongs in the name too, WCAG 2.5.3.)
            onClick={() => onSelect(space.id)}
            onKeyDown={onButtonKeyDown}
            data-space-hue=""
            data-space-id={space.id}
            data-space-status={doing ? (doing.urgent ? "needs-you" : "running") : undefined}
            style={spaceHueStyle(space.hue)}
            className={cn(
              // Two rows: the dot centres on the name's first line, the description sits under the name.
              // The end keeps room for the More button, so it never covers the name.
              "grid w-full min-w-0 grid-cols-[var(--ph-space-mark-size)_minmax(0,1fr)] items-start gap-x-2.5 rounded-md py-1.5 ps-2 pe-[calc(var(--ph-control-height-sm)+var(--ph-space)*2)] text-start",
              "transition-colors duration-(--ph-duration-fast)",
              // In a background window the selection greys, as macOS does.
              active ? "bg-space-tint group-data-[inactive]/app:bg-selected" : "hover:bg-hover active:bg-selected",
              menuOpen && !active && "bg-hover",
            )}
          >
            {/* One line tall, so the dot centres on the name at any text size. */}
            <span className="flex h-[1lh] items-center text-base">
              <SpaceMark hue={space.hue} />
            </span>
            {/* The name and what the space is doing share a line while both fit; otherwise the state wraps below.
                Its place is always laid out, as wide as its widest state and unseen while idle, so a reply
                starting or a card waiting never rewraps the row and the spaces below never move. */}
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
              <span data-space-name="" className={cn("max-w-full min-w-0 truncate text-base text-ink", active ? "font-semibold" : "font-medium")}>
                {/* Spoken as one piece of text, so no stray space lands before a comma. */}
                <span aria-hidden="true">{space.name}</span>
                <span className="sr-only">{`${space.name}${doing ? `, ${doing.spoken}` : ""}${space.description ? "," : ""}`}</span>
              </span>
              <span aria-hidden="true" className="grid shrink-0 text-xs" data-space-activity-slot="">
                {ACTIVITY_SHOWN.map((s) => {
                  const on = doing?.shown === s.shown;
                  return (
                    <span
                      key={s.shown}
                      data-space-activity={on ? "" : undefined}
                      className={cn(
                        "col-start-1 row-start-1 flex items-center gap-1",
                        !on && "invisible",
                        s.urgent
                          ? "rounded-full bg-warning-soft px-1.5 font-semibold text-warning-ink forced-colors:border forced-colors:border-[CanvasText]"
                          : "text-ink-secondary",
                      )}
                    >
                      {s.urgent ? (
                        <Icon name="warning" className="size-(--ph-icon-size-sm)" />
                      ) : (
                        <Icon name="spinner" className={cn("size-(--ph-icon-size-sm)", on && "motion-safe:animate-spin")} />
                      )}
                      {s.shown}
                    </span>
                  );
                })}
              </span>
            </span>
            {space.description && <span className="col-start-2 truncate text-xs text-ink-secondary">{space.description}</span>}
          </button>
          <button
            ref={moreRef}
            type="button"
            tabIndex={-1}
            aria-label={`More for ${space.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-space-more={space.id}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openMenuAt(r.left, r.bottom);
            }}
            onKeyDown={onMoreKeyDown}
            className={cn(
              "absolute end-1 top-1/2 grid size-(--ph-control-height-sm) -translate-y-1/2 place-items-center rounded-md text-ink-secondary",
              "transition-opacity duration-(--ph-duration-fast) hover:bg-selected hover:text-ink",
              // Always on the current space; on another, while it is pointed at, focused or its menu is open.
              active || menuOpen ? "opacity-100" : "opacity-0 group-focus-within/space:opacity-100 group-hover/space:opacity-100 focus-visible:opacity-100",
              menuOpen && "bg-selected text-ink",
            )}
          >
            <Icon name="more" className="size-(--ph-icon-size-sm)" />
          </button>
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          aria-label={`${space.name}: actions`}
          data-space-menu={space.id}
          collisionPadding={8}
          onInteractOutside={() => (pressedOutside.current = true)}
          onCloseAutoFocus={(e) => {
            // Back to the space itself (not the More button), then whatever was chosen. Closed by
            // a press elsewhere, focus stays where that press put it.
            e.preventDefault();
            if (!pressedOutside.current) buttonRef.current?.focus();
            pressedOutside.current = false;
            holdForMenu(false);
            const run = after.current;
            after.current = null;
            if (run) requestAnimationFrame(run);
          }}
          className={cn(
            "z-50 flex max-h-(--radix-context-menu-content-available-height) min-w-56 max-w-(--radix-context-menu-content-available-width) flex-col overflow-y-auto rounded-lg border border-line bg-raised p-1 text-ink shadow-lg outline-none",
            "forced-colors:border-[CanvasText]",
            "origin-(--radix-context-menu-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97]",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]",
          )}
        >
          <ContextMenu.Label className="flex items-center gap-2 px-2.5 pt-1.5 pb-1 text-sm font-semibold text-ink-secondary">
            <SpaceMark hue={space.hue} />
            <span className="min-w-0 truncate">{space.name}</span>
          </ContextMenu.Label>
          <ContextMenu.Item data-space-action="show" onSelect={() => choose(() => void showSpaceFolder(space.id))} className={itemClass}>
            <Icon name="folder" className="shrink-0 text-ink-secondary" />
            {showInLabel()}
          </ContextMenu.Item>
          <ContextMenu.Item data-space-action="add-files" onSelect={() => choose(() => void addToSpace(space.id, false))} className={itemClass}>
            <Icon name="file-plus" className="shrink-0 text-ink-secondary" />
            Add files…
          </ContextMenu.Item>
          <ContextMenu.Item data-space-action="add-folder" onSelect={() => choose(() => void addToSpace(space.id, true))} className={itemClass}>
            <Icon name="folder-plus" className="shrink-0 text-ink-secondary" />
            Add a folder…
          </ContextMenu.Item>
          <ContextMenu.Item data-space-action="export" onSelect={() => choose(() => void exportSpace(space.id))} className={itemClass}>
            <Icon name="download" className="shrink-0 text-ink-secondary" />
            Export…
          </ContextMenu.Item>
          {inTauri() && (
            <>
              <ContextMenu.Item data-space-action="import-courses" onSelect={() => choose(() => openCourseImport({ space: space.id }))} className={itemClass}>
                <Icon name="book" className="shrink-0 text-ink-secondary" />
                Import courses…
              </ContextMenu.Item>
              <ContextMenu.Item data-space-action="course-access" onSelect={() => choose(() => openSettings("courses"))} className={itemClass}>
                <Icon name="lock" className="shrink-0 text-ink-secondary" />
                Course access…
              </ContextMenu.Item>
              <ContextMenu.Separator className="mx-1 my-1 h-px bg-line forced-colors:bg-[CanvasText]" />
              <ContextMenu.Item data-space-action="edit" onSelect={() => choose(() => openSettings("spaces", { space: space.id }))} className={itemClass}>
                <Icon name="edit" className="shrink-0 text-ink-secondary" />
                Edit name and colour…
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
