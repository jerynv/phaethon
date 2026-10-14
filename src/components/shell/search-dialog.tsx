import { Switch } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { searchConversations, type SearchConversation, type SearchResults, type SearchSnippet } from "@/lib/backend";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import type { Space } from "@/lib/spaces";

import { Keys } from "./command-palette";
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
  const [active, setActive] = useState(0);
  const listId = useId();
  const statusId = useId();
  const hintId = useId();
  const switchId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const chosen = useRef<SearchChoice | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const seq = useRef(0);
  const space = spaces.find((s) => s.id === spaceId);

  // The last search stays for the next time (select all to replace it).
  useEffect(() => {
    if (!open) return;
    chosen.current = null;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActive(0);
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
          setActive(0);
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
  const current = Math.min(active, options.length - 1);
  const optionId = (i: number) => `${listId}-o${i}`;

  useEffect(() => {
    if (current < 0) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  function choose(o: { c: SearchConversation; s: SearchSnippet } | undefined) {
    if (!o) return;
    chosen.current = { space: o.c.space, thread: o.c.threadId, message: o.s.message, title: o.c.title };
    onOpenChange(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!n) return;
      setActive((a) => {
        const at = Math.min(a, n - 1);
        return e.key === "ArrowDown" ? (at + 1) % n : (at - 1 + n) % n;
      });
    } else if ((e.key === "Home" || e.key === "End") && (e.ctrlKey || e.metaKey || !query)) {
      e.preventDefault();
      if (n) setActive(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      choose(options[current]);
    }
  }

  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  const scopeText = allSpaces ? "all spaces" : (space?.name ?? "this space");
  const status =
    state.status === "ready"
      ? countText(state.results)
      : state.status === "error"
        ? "The search didn’t work."
        : "";
  let index = 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-search-dialog=""
        showCloseButton={false}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          inputRef.current?.select();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const c = chosen.current;
          chosen.current = null;
          const back = returnTo.current;
          const visible = back?.isConnected && !back.closest("[hidden],[inert]") && back.getClientRects().length > 0;
          (visible ? back : document.getElementById("main"))?.focus();
          if (c) requestAnimationFrame(() => onChoose(c));
        }}
        className={cn(
          "top-[calc(var(--ph-titlebar-room)+var(--ph-space)*6)] max-h-[calc(100dvh-var(--ph-titlebar-room)-var(--ph-space)*12)] translate-y-0",
          "flex max-w-[calc(640px*var(--ph-ui-scale))] flex-col gap-0 overflow-hidden p-0",
        )}
      >
        <DialogTitle className="sr-only">Search conversations</DialogTitle>
        <DialogDescription id={hintId} className="sr-only">
          Searches the words of your saved conversations in {scopeText}. Nothing is sent to the model. Use the arrow
          keys to pick a result and Enter to open it.
        </DialogDescription>
        <div className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2">
          <Icon name="search" className="shrink-0 text-ink-secondary" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            aria-label="Search conversations"
            aria-describedby={`${statusId} ${hintId}`}
            autoComplete="off"
            spellCheck={false}
            data-search-input=""
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={`Search conversations in ${scopeText}…`}
            className="min-h-(--ph-control-height-lg) min-w-0 flex-1 rounded-sm bg-transparent py-1.5 text-md text-ink outline-none placeholder:text-ink-secondary"
          />
          <Keys keys={["Esc"]} className="max-sm:hidden" />
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line px-4 py-1.5">
          <div className="flex items-center gap-2">
            <Switch.Root
              id={switchId}
              data-switch=""
              data-search-all=""
              checked={allSpaces}
              onCheckedChange={(on) => {
                setAllSpaces(on);
                setActive(0);
              }}
              className={cn(
                "inline-flex h-(--ph-switch-height) w-(--ph-switch-width) shrink-0 cursor-pointer items-center rounded-full border border-transparent px-0.5 transition-colors duration-(--ph-duration-fast)",
                "bg-ink-tertiary data-[state=checked]:bg-accent-fill disabled:cursor-default disabled:opacity-60",
              )}
            >
              <Switch.Thumb data-switch-thumb="" className="block size-(--ph-switch-thumb) rounded-full bg-raised shadow-sm transition-transform duration-(--ph-duration-fast) data-[state=checked]:translate-x-(--ph-switch-travel)" />
            </Switch.Root>
            <label htmlFor={switchId} className="cursor-pointer text-sm text-ink">
              All spaces
            </label>
          </div>
          <p id={statusId} role="status" aria-live="polite" className="text-sm text-ink-secondary" data-search-status="">
            {status}
          </p>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Matches"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 empty:hidden"
        >
          {results.map((c) => {
            const groupId = `${listId}-g-${c.space}-${c.threadId}`;
            const s = spaces.find((x) => x.id === c.space);
            const more = c.matches - c.snippets.length;
            return (
              <div key={groupId} role="group" aria-labelledby={groupId} className="flex flex-col pb-1" data-search-group="">
                <div id={groupId} role="presentation" className="flex min-w-0 flex-wrap items-baseline gap-x-2 px-2 pt-2 pb-1 text-xs text-ink-secondary">
                  <span className="min-w-0 truncate font-semibold text-ink">{c.title}</span>
                  {allSpaces && s && (
                    <span className="inline-flex items-center gap-1" data-search-space={c.space}>
                      <SpaceMark hue={s.hue} />
                      {s.name}
                    </span>
                  )}
                  <span>{c.current ? "Open now" : dateOf(c.updated)}</span>
                  {more > 0 && <span>{`${plural(more, "more match", "more matches")}`}</span>}
                </div>
                {c.snippets.map((snip) => {
                  const i = index++;
                  return (
                    <div
                      key={`${snip.message}-${i}`}
                      id={optionId(i)}
                      role="option"
                      aria-selected={i === current}
                      data-search-result=""
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => i !== current && setActive(i)}
                      onClick={() => choose({ c, s: snip })}
                      className={cn(
                        "flex min-h-(--ph-control-height-lg) flex-col gap-0.5 rounded-md px-2 py-1.5 text-base text-ink",
                        "aria-selected:bg-selected forced-colors:aria-selected:outline-2 forced-colors:aria-selected:outline-[Highlight]",
                      )}
                    >
                      <span className="text-xs font-medium text-ink-secondary">{snip.role === "user" ? "You" : "Phaethon"}</span>
                      <span className="line-clamp-2 wrap-anywhere">
                        {snip.before}
                        <mark className="rounded-xs bg-accent-soft px-0.5 font-semibold text-accent-soft-ink underline decoration-2 underline-offset-2 forced-colors:bg-[Mark] forced-colors:text-[MarkText]">
                          {snip.matched}
                        </mark>
                        {snip.after}
                      </span>
                      <span className="sr-only">
                        {`, in “${c.title}”${allSpaces ? `, ${spaceName(c.space)}` : ""}`}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {state.status !== "ready" || results.length === 0 ? (
          <div className="px-4 py-6 text-center text-base text-ink-secondary" data-search-empty="">
            {state.status === "error" ? (
              <p role="alert" className="wrap-anywhere text-danger-ink">
                {state.message}
              </p>
            ) : state.status === "ready" ? (
              <p>
                Nothing in {scopeText} matches “{state.query}”.
                {!allSpaces && spaces.length > 1 ? " Switch on All spaces to look everywhere." : ""}
              </p>
            ) : state.status === "searching" ? (
              <p className="flex items-center justify-center gap-2">
                <Icon name="spinner" className="animate-spin" />
                Searching…
              </p>
            ) : (
              <p>
                Type at least {MIN_CHARS} letters to search the words in {scopeText}. Capitals and accents don’t matter.
                Nothing is sent to the model.
              </p>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
