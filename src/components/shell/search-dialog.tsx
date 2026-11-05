import { CommandPalette as VicCommandPalette, type PaletteOption } from "vic-ui";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { searchConversations, type SearchResults } from "@/lib/backend";
import { inTauri } from "@/lib/tauri";
import type { Space } from "@/lib/spaces";

import { SpaceMark } from "./space-mark";

/** Typing pauses this long before a search runs. */
const DEBOUNCE_MS = 200;
/** Fewer characters than this match too much to be useful. */
const MIN_CHARS = 2;

export type SearchChoice = { space: string; thread: string; message: number; title: string };

type State =
  | { status: "idle" }
  | { status: "searching"; query: string }
  | { status: "ready"; query: string; results: SearchResults }
  | { status: "error"; message: string };

/** A conversation's date, as the conversations menu shows it: the year only when it isn't this one. */
function dateOf(ms: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What the status line says once a search is back. */
function countText(r: SearchResults): string {
  const n = r.conversations.reduce((sum, c) => sum + c.matches, 0);
  if (!n) return "No matches.";
  const where = plural(r.conversations.length, "conversation", "conversations");
  const more = r.truncated ? ` Showing the ${r.conversations.length} most recent conversations with a match.` : "";
  return `${plural(n, "match", "matches")} in ${where}.${more}`;
}

/**
 * Cmd+Shift+F: search the words of every saved conversation, in the space on
 * screen or (switched on) in every space. Results are the user's own view of
 * their files: nothing is sent to the model, and choosing one opens that
 * space and conversation at the message.
 *
 * The same pattern as the command palette: an editable combobox (the search
 * field) controls a listbox of snippets grouped by conversation; ArrowUp and
 * ArrowDown move the highlighted snippet (aria-activedescendant), Home and End
 * jump, Enter opens it, Escape closes. The count is announced politely once a
 * search (debounced while typing) comes back. The match is a <mark>, drawn
 * with weight and an underline as well as colour.
 */
export function SearchDialog({
  open,
  onOpenChange,
  spaces,
  spaceId,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  spaces: readonly Space[];
  /** The space on screen: the default scope. */
  spaceId: string | null;
  onChoose: (choice: SearchChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [allSpaces, setAllSpaces] = useState(false);
  const [state, setState] = useState<State>({ status: "idle" });
  const seq = useRef(0);
  const space = spaces.find((s) => s.id === spaceId);

  const host = useRef<HTMLDivElement>(null);
  // Reopening retains the search and selects its text for immediate replacement.
  useEffect(() => {
    if (open) host.current?.querySelector("input")?.select();
  }, [open]);

  // Debounced: a search runs once typing pauses; an answer to an older search is dropped.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < MIN_CHARS || !spaceId || !inTauri()) {
      seq.current++;
      setState({ status: "idle" });
      return;
    }
    const mine = ++seq.current;
    setState((s) => (s.status === "ready" ? s : { status: "searching", query: q }));
    const timer = setTimeout(() => {
      searchConversations(spaceId, q, allSpaces).then(
        (results) => {
          if (seq.current !== mine) return;
          setState({ status: "ready", query: q, results });
        },
        (e: unknown) => seq.current === mine && setState({ status: "error", message: String(e) }),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query, allSpaces, spaceId]);

  const results = state.status === "ready" ? state.results.conversations : [];
  const options = useMemo(
    () => results.flatMap((c) => c.snippets.map((s) => ({ c, s }))),
    [results],
  );
  const scopeText = allSpaces ? "all spaces" : (space?.name ?? "this space");
  const status =
    state.status === "ready"
      ? countText(state.results)
      : state.status === "error"
        ? "The search didn’t work."
        : "";
  // Ported from T3 Code's CommandPaletteResultRow / ThreadSearchMatchExcerpt
  // (MIT): conversation context is grouped once, with a compact match row.
  const items = useMemo<PaletteOption[]>(() => options.map(({ c, s }, index) => ({
    value: String(index),
    group: `${c.title} · ${c.current ? "Current" : dateOf(c.updated)}`,
    start: allSpaces ? <SpaceMark hue={spaces.find((candidate) => candidate.id === c.space)?.hue ?? 0} /> : <Icon name="chat" />,
    text: `${s.before}${s.matched}${s.after}`,
    label: <span className="flex min-w-0 flex-1 items-center gap-3" data-search-result="" data-search-space={c.space}>
      <span className="min-w-0 flex-1 line-clamp-2 wrap-anywhere">
        {s.before}<mark className="rounded-xs bg-accent-soft font-medium text-accent-soft-ink">{s.matched}</mark>{s.after}
      </span>
      <span className="shrink-0 text-xs text-ink-secondary">{s.role === "user" ? "You" : "Phaethon"}</span>
    </span>,
  })), [options, allSpaces, spaces]);

  const empty = state.status === "error"
    ? <span role="alert" className="text-danger-ink">{state.message}</span>
    : state.status === "ready" ? "No matching conversations" : "Search your conversations";

  return open ? (
    <div ref={host} data-search-dialog="" onKeyDownCapture={(event) => {
      if (event.nativeEvent.isComposing && event.key === "Enter") event.stopPropagation();
    }}>
      <VicCommandPalette
        open={open}
        onOpenChange={onOpenChange}
        query={query}
        onQueryChange={setQuery}
        label="Search conversations"
        placeholder={`Search in ${scopeText}…`}
        className="ph-command-palette ph-conversation-search"
        items={items}
        filter={false}
        loading={state.status === "searching"}
        empty={empty}
        onSelect={(value) => {
          const match = options[Number(value)];
          if (!match) return;
          onOpenChange(false);
          requestAnimationFrame(() => onChoose({ space: match.c.space, thread: match.c.threadId, message: match.s.message, title: match.c.title }));
        }}
        foot={<div className="flex w-full items-center justify-between gap-3">
          <Button type="button" variant="ghost" size="xs" data-search-all="" aria-pressed={allSpaces}
            onClick={() => setAllSpaces((value) => !value)}>
            <Icon name={allSpaces ? "check" : "space"} className="size-3.5" />All spaces
          </Button>
          <span role="status" aria-live="polite" className="truncate text-xs text-ink-secondary" data-search-status="">{status}</span>
        </div>}
      />
    </div>
  ) : null;
}
