import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";

import { shortcutGroups, type Shortcut } from "./shortcuts";
import { SpaceMark } from "./space-mark";

export type Command = {
  id: string;
  group: string;
  label: string;
  /** A quieter second part, matched too ("Courses, deadlines" for a space). */
  hint?: string;
  /** Extra words that find it ("preferences" for Settings). */
  keywords?: string;
  icon?: IconName;
  /** A space's hue: shown as its dot instead of an icon. */
  hue?: number;
  shortcut?: Pick<Shortcut, "keys" | "aria">;
  /** "current" marks the space being shown. */
  current?: boolean;
  run: () => void;
};

/** How a key cap is spoken: screen readers say "⌘" and "\" badly or not at all. */
const SPOKEN: Record<string, string> = {
  "⌘": "Command",
  "⌥": "Option",
  "\\": "Backslash",
  "/": "Slash",
  ",": "Comma",
  "↑": "Up arrow",
  "↓": "Down arrow",
  "1…9": "1 to 9",
};

/** Key caps as words: ["⌘", "K"] is "Command K". */
export const spokenKeys = (keys: string[]) => keys.map((k) => SPOKEN[k] ?? k).join(" ");

/** Key caps, each drawn as a kbd and spoken by name ("Command K"). */
export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <span className="sr-only">{spokenKeys(keys)}</span>
      {keys.map((k) => (
        <kbd
          key={k}
          aria-hidden="true"
          className="inline-grid min-w-(--ph-control-height-sm) place-items-center rounded-sm border border-line-strong bg-surface px-1 font-sans text-xs leading-snug text-ink-secondary"
        >
          {k}
        </kbd>
      ))}
    </span>
  );
}

const norm = (s: string) => s.toLocaleLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

/** Every word typed appears somewhere in the command's label, hint, group or keywords. */
function matches(c: Command, query: string): boolean {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = norm(`${c.label} ${c.hint ?? ""} ${c.group} ${c.keywords ?? ""}`);
  return words.every((w) => hay.includes(w));
}

/**
 * Cmd+K: find a space or a command by typing. An editable combobox (the
 * search field) controls a listbox of commands grouped under headings; focus
 * stays in the field while ArrowUp/ArrowDown move the highlighted option
 * (aria-activedescendant), Home/End jump to the first or last, Enter runs it,
 * Escape closes. A click runs an option too. The number of matches is
 * announced politely as you type. After a command runs, focus goes back where
 * it was (or to what the command opens).
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const statusId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const chosen = useRef<Command | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    chosen.current = null;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  const shown = useMemo(() => commands.filter((c) => matches(c, query)), [commands, query]);
  const groups = useMemo(() => {
    const out: { name: string; items: { c: Command; i: number }[] }[] = [];
    shown.forEach((c, i) => {
      const g = out.find((x) => x.name === c.group) ?? (out.push({ name: c.group, items: [] }), out[out.length - 1]);
      g.items.push({ c, i });
    });
    return out;
  }, [shown]);
  const current = Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${listId}-o${i}`;

  // Keep the highlighted option in view.
  useEffect(() => {
    if (current < 0) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function run(c: Command | undefined) {
    if (!c) return;
    chosen.current = c;
    onOpenChange(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = shown.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      setActive((a) => {
        const at = Math.min(a, n - 1);
        return e.key === "ArrowDown" ? (at + 1) % n : (at - 1 + n) % n;
      });
    } else if ((e.key === "Home" || e.key === "End") && (e.ctrlKey || e.metaKey || !query)) {
      // With text in the field, Home/End move the caret; with none (or with Ctrl/Cmd) they jump the list.
      e.preventDefault();
      if (n) setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      run(shown[current]);
    }
  }

  const count = shown.length === 0 ? "No matches." : `${shown.length} ${shown.length === 1 ? "match" : "matches"}.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-command-palette=""
        showCloseButton={false}
        aria-describedby={undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const c = chosen.current;
          chosen.current = null;
          const back = returnTo.current;
          // Back where focus was, if that is still on screen (a space switch hides it); else the conversation.
          const visible = back?.isConnected && !back.closest("[hidden],[inert]") && back.getClientRects().length > 0;
          (visible ? back : document.getElementById("main"))?.focus();
          if (c) requestAnimationFrame(() => c.run());
        }}
        className={cn(
          // Near the top, like a browser's address bar, so the list grows down into the room.
          "top-[calc(var(--ph-titlebar-room)+var(--ph-space)*6)] max-h-[calc(100dvh-var(--ph-titlebar-room)-var(--ph-space)*12)] translate-y-0",
          "flex max-w-[calc(560px*var(--ph-ui-scale))] flex-col gap-0 overflow-hidden p-0",
        )}
      >
        <DialogTitle className="sr-only">Find a space or command</DialogTitle>
        {/* Padded all round, so the focus ring around the field fits inside the panel (which clips). */}
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <Icon name="search" className="shrink-0 text-ink-secondary" />
          <input
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Find a space or command"
            aria-describedby={statusId}
            autoComplete="off"
            spellCheck={false}
            data-palette-input=""
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Go to a space, or type a command…"
            className="min-h-(--ph-control-height-lg) min-w-0 flex-1 rounded-sm bg-transparent py-1.5 text-md text-ink outline-none placeholder:text-ink-secondary"
          />
          <Keys keys={["Esc"]} className="max-sm:hidden" />
        </div>
        <p id={statusId} role="status" className="sr-only">
          {count}
        </p>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Spaces and commands"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
        >
          {groups.map((g) => (
            <div key={g.name} role="group" aria-labelledby={`${listId}-g-${g.name}`} className="flex flex-col">
              <div id={`${listId}-g-${g.name}`} role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-ink-secondary">
                {g.name}
              </div>
              {g.items.map(({ c, i }) => (
                <div
                  key={c.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === current}
                  aria-keyshortcuts={c.shortcut?.aria}
                  data-command={c.id}
                  // Keep focus in the field: the option is chosen by the click, not focused by it.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => i !== current && setActive(i)}
                  onClick={() => run(c)}
                  className={cn(
                    "flex min-h-(--ph-control-height-lg) items-center gap-2.5 rounded-md px-2 py-1 text-base text-ink",
                    "aria-selected:bg-selected forced-colors:aria-selected:outline-2 forced-colors:aria-selected:outline-[Highlight]",
                  )}
                >
                  <span className="grid w-(--ph-icon-size) shrink-0 place-items-center text-ink-secondary" aria-hidden="true">
                    {c.hue !== undefined ? <SpaceMark hue={c.hue} /> : c.icon ? <Icon name={c.icon} /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="truncate">{c.label}</span>
                    {c.hint && <span className="min-w-0 truncate text-sm text-ink-secondary">{c.hint}</span>}
                    {c.current && <span className="shrink-0 text-xs text-ink-secondary">Current</span>}
                  </span>
                  {c.shortcut && <Keys keys={c.shortcut.keys} />}
                </div>
              ))}
            </div>
          ))}
          {shown.length === 0 && (
            <p className="px-2 py-6 text-center text-base text-ink-secondary">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Cmd+/ : every shortcut, grouped, as tables (Keys | What it does), so a
 * screen reader can move by row and column. Keys are spoken by name.
 */
export function ShortcutsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const groups = shortcutGroups();
  // Opened by a shortcut, so there is no trigger for Radix to return focus to: remember where it was.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-shortcuts-sheet=""
        className="max-w-[calc(520px*var(--ph-ui-scale))]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const back = returnTo.current;
          returnTo.current = null;
          // Back where focus was, if that is still on screen; else the conversation.
          const visible = back?.isConnected && !back.closest("[hidden],[inert]") && back.getClientRects().length > 0;
          (visible ? back : document.getElementById("main"))?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>On Windows and Linux, Ctrl takes the place of ⌘.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-5">
          {groups.map((g) => (
            <table key={g.title} className="w-full border-collapse text-base">
              <caption className="pb-1.5 text-start text-sm font-semibold text-ink">{g.title}</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Keys</th>
                  <th scope="col">What it does</th>
                </tr>
              </thead>
              <tbody>
                {g.shortcuts.map((s) => (
                  <Fragment key={s.id}>
                    <tr className="border-t border-line">
                      <th scope="row" className="w-0 py-1.5 pe-6 text-start whitespace-nowrap align-top font-normal">
                        <Keys keys={s.keys} />
                      </th>
                      <td className="py-1.5 align-top text-ink">{s.does}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
