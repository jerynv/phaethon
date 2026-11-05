import { CommandPalette as VicCommandPalette, Kbd, type PaletteOption } from "vic-ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon, type IconName } from "@/icons";
import { findSpace, useActiveSpaceId } from "@/lib/spaces";
import { cn } from "@/lib/utils";

import { shortcutGroups, type Shortcut } from "./shortcuts";
import { exportSpace, fileManagerName, showSpaceFolder } from "./space-actions";
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
  "1…4": "1 to 4",
  "1…5": "1 to 5",
};

/** Key caps as words: ["⌘", "K"] is "Command K". */
export const spokenKeys = (keys: string[]) => keys.map((k) => SPOKEN[k] ?? k).join(" ");

/** Key caps, each drawn as a kbd and spoken by name ("Command K"). */
export function Keys({ keys, className }: { keys: string[]; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1", className)}>
      <span className="sr-only">{spokenKeys(keys)}</span>
      <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5">
        {keys.map((key) => <Kbd key={key} name={SPOKEN[key] ?? key}>{key}</Kbd>)}
      </span>
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
type PaletteProps = { open: boolean; onOpenChange: (open: boolean) => void; commands: Command[] };

export function CommandPalette(props: PaletteProps) {
  return props.open ? <OpenCommandPalette {...props} /> : null;
}

function OpenCommandPalette({ open, onOpenChange, commands }: PaletteProps) {
  const [query, setQuery] = useState("");
  // Capture the opener before Vic's child layout effect focuses its native
  // dialog. Each opening owns one session, so closing cannot retain its input.
  const [returnTo] = useState<HTMLElement | null>(() => document.activeElement instanceof HTMLElement ? document.activeElement : null);

  // The space actions (as in its menu in the sidebar), for the space on screen, at the end of
  // Actions: the list keeps the order shown, so the first match is the one highlighted.
  const activeSpaceId = useActiveSpaceId();
  const all = useMemo<Command[]>(() => {
    const space = activeSpaceId ? findSpace(activeSpaceId) : undefined;
    if (!space) return commands;
    const actions: Command[] = [
      {
        id: "space-show",
        group: "Actions",
        label: `Show space in ${fileManagerName()}`,
        hint: space.name,
        keywords: "folder files open reveal finder explorer",
        icon: "folder",
        run: () => void showSpaceFolder(space.id),
      },
      {
        id: "space-export",
        group: "Actions",
        label: "Export space…",
        hint: space.name,
        keywords: "zip backup copy save download archive",
        icon: "download",
        run: () => void exportSpace(space.id),
      },
    ];
    const at = commands.findIndex((c) => c.group !== "Spaces" && c.group !== "Actions");
    return at === -1 ? [...commands, ...actions] : [...commands.slice(0, at), ...actions, ...commands.slice(at)];
  }, [commands, activeSpaceId]);
  // T3 Code's CommandPaletteResultRow (MIT) keeps each result in one row:
  // leading context, title, then secondary metadata and shortcuts. Vic owns
  // the search field, top-layer dialog, grouped list and keyboard navigation.
  const items = useMemo<PaletteOption[]>(() => all.map((command) => ({
    value: command.id,
    group: command.group,
    text: `${command.label} ${command.hint ?? ""} ${command.keywords ?? ""}`,
    start: command.hue !== undefined ? <SpaceMark hue={command.hue} /> : command.icon ? <Icon name={command.icon} /> : undefined,
    label: <span data-command={command.id} className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {command.hint && <span className="max-w-[40%] truncate text-xs text-ink-secondary">{command.hint}</span>}
      {command.current && <Icon name="check" className="size-3.5 text-ink-secondary" />}
      {command.shortcut && <Keys keys={command.shortcut.keys} />}
    </span>,
  })), [all]);

  return open ? (
    <div data-command-palette="" onKeyDownCapture={(event) => {
      if (event.nativeEvent.isComposing && event.key === "Enter") event.stopPropagation();
    }}>
      <VicCommandPalette
        open={open}
        onOpenChange={onOpenChange}
        query={query}
        onQueryChange={setQuery}
        label="Find a space or command"
        placeholder="Search spaces and commands…"
        className="ph-command-palette"
        items={items}
        filter={(option, value) => matches(all.find((command) => command.id === option.value)!, value)}
        onSelect={(id) => {
          const command = all.find((candidate) => candidate.id === id);
          if (!command) return;
          onOpenChange(false);
          requestAnimationFrame(() => {
            const back = returnTo;
            const visible = back?.isConnected && !back.closest("[hidden],[inert]") && back.getClientRects().length > 0;
            (visible ? back : document.getElementById("main"))?.focus();
            command.run();
          });
        }}
        empty={<span>No matching commands</span>}
      />
    </div>
  ) : null;
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
