import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { toast } from "@/components/toast";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { AutocompleteEmpty } from "@/components/ui/autocomplete";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { compactTime } from "@/lib/platform";
import { api, type SearchConversation } from "./api";
import { viewKeys } from "./shortcuts";
import { NO_SPACES, useNav, type View } from "./store";
import { useTheme } from "./theme";
import { VIEWS } from "./views";

type Item = {
  id: string;
  label: string;
  detail?: string;
  /** Keys shown at the end of the row instead of `detail`. */
  keys?: string[];
  icon: React.ReactNode;
  run: () => void;
  snippet?: { before: string; matched: string; after: string };
};

/** ⌘K: search every conversation in every space, jump to a space or a view, run an action. */
export function CommandPalette() {
  const open = useNav((s) => s.paletteOpen);
  const setOpen = useNav((s) => s.setPalette);
  const startWith = useNav((s) => s.paletteQuery);
  const spaces = useNav((s) => s.spaces.data) ?? NO_SPACES;
  const active = useNav((s) => s.activeSpace);
  const edu = spaces.find((s) => s.id === active)?.educationEnabled ?? false;
  const nav = useNav.getState;
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchConversation[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (open) setQuery(startWith);
    else {
      setQuery("");
      setResults(null);
      setError(null);
    }
  }, [open, startWith]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || !active) {
      setResults(null);
      setSearching(false);
      return;
    }
    const n = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.search(active, q, true).then(
        (r) => n === seq.current && (setResults(r.conversations), setError(null), setSearching(false)),
        (e) => n === seq.current && (setError(errorText(e)), setSearching(false)),
      );
    }, 160);
    return () => clearTimeout(t);
  }, [query, active]);

  const close = () => setOpen(false);
  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;

  const actions: Item[] = useMemo(
    () => [
      { id: "new", label: "New chat", icon: <Icon icon={icons.newChat} />, run: () => active && void nav().newChat(active).catch((e) => toast.error("Couldn’t start a new chat", errorText(e))) },
      { id: "settings", label: "Open settings", icon: <Icon icon={icons.settings} />, run: () => nav().openSettings() },
      {
        id: "theme",
        label: document.documentElement.classList.contains("dark") ? "Switch to light theme" : "Switch to dark theme",
        icon: <Icon icon={document.documentElement.classList.contains("dark") ? icons.light : icons.dark} />,
        run: () => void theme.set(document.documentElement.classList.contains("dark") ? "light" : "dark").catch(() => {}),
      },
      { id: "space", label: "New space", icon: <Icon icon={icons.add} />, run: () => nav().openSettings("spaces") },
    ],
    [active, nav, theme],
  );
  const q = query.trim().toLowerCase();
  const matchedActions = actions.filter((a) => !q || a.label.toLowerCase().includes(q));
  const matchedSpaces = spaces.filter((s) => !q || s.name.toLowerCase().includes(q));
  // A space with study tools can jump straight to a view.
  const views: Item[] = edu
    ? VIEWS.map((v, i) => ({ id: `view:${v.id}`, label: `Go to ${v.label}`, keys: viewKeys(i).keys, icon: <Icon icon={v.icon} />, run: () => nav().setView(v.id as View) })).filter((v) => !q || v.label.toLowerCase().includes(q))
    : [];
  const conversations: Item[] = (results ?? []).map((c) => ({
    id: `${c.space}/${c.threadId}`,
    label: c.title,
    detail: `${spaceName(c.space)} · ${compactTime(c.updated)}`,
    icon: <Icon icon={icons.chat} />,
    snippet: c.snippets[0],
    run: () => void nav().openThread(c.space, c.threadId).catch((e) => toast.error("Couldn’t open that conversation", errorText(e))),
  }));

  const groups: { label: string; items: Item[] }[] = [
    ...(conversations.length ? [{ label: "Conversations", items: conversations }] : []),
    ...(matchedSpaces.length
      ? [{ label: "Spaces", items: matchedSpaces.map((s) => ({ id: `space:${s.id}`, label: s.name, detail: s.description, icon: <SpaceAvatar name={s.name} hue={s.hue} />, run: () => nav().selectSpace(s.id) })) }]
      : []),
    ...(views.length ? [{ label: "Views", items: views }] : []),
    ...(matchedActions.length ? [{ label: "Actions", items: matchedActions }] : []),
  ];

  return (
    <CommandDialog open={open} onOpenChange={(o) => setOpen(o)}>
      <CommandDialogPopup className="max-w-xl">
        <Command items={groups} filter={null} value={query} onValueChange={setQuery} itemToStringValue={(i: unknown) => (i as Item).label}>
          <CommandInput placeholder="Search conversations, spaces and actions" />
          <CommandPanel>
            {/* Above the list: the list's scroll area fills the panel, so anything after it is clipped away. */}
            <AutocompleteEmpty>
              <span className="flex items-center justify-center gap-2">
                {searching ? <Spinner size="sm" tone="muted" /> : error ? <Icon icon={icons.error} className="size-4 text-error-foreground" /> : null}
                {searching ? "Searching…" : error ? `Search failed: ${error}` : q.length >= 2 ? "Nothing matches that." : "Type to search."}
              </span>
            </AutocompleteEmpty>
            <CommandList>
              {(group: { label: string; items: Item[] }) => (
                <CommandGroup key={group.label} items={group.items}>
                  <CommandGroupLabel>{group.label}</CommandGroupLabel>
                  {group.items.map((item) => (
                    <CommandItem
                      key={item.id}
                      value={item}
                      onClick={() => {
                        item.run();
                        close();
                      }}
                    >
                      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4" aria-hidden>
                        {item.icon}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate">{item.label}</span>
                        {item.snippet ? (
                          <span className="truncate text-subtle-foreground text-xs">
                            {item.snippet.before}
                            <mark className="rounded-xs bg-primary/15 px-px text-foreground">{item.snippet.matched}</mark>
                            {item.snippet.after}
                          </span>
                        ) : null}
                      </span>
                      {item.keys ? (
                        <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">{item.keys.join(" ")}</span>
                      ) : item.detail ? (
                        <span className="max-w-40 shrink-0 truncate text-subtle-foreground text-xs tabular-nums">{item.detail}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </CommandPanel>
          <CommandFooter>
            <span className="flex items-center gap-1.5">
              {searching ? <Spinner size="xs" tone="muted" /> : null}
              {searching ? "Searching every space" : "Searches every space"}
            </span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
