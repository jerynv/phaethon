import { SearchIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { api, type SearchConversation, type SearchResults } from "./api";
import { useNav } from "./nav";
import { useShell } from "./shell-store";
import { SpaceMark } from "./SpaceMark";
import { useSpaces } from "./spaces";
import { openConversation } from "./threads";

const DEBOUNCE_MS = 180;

type State =
  | { kind: "idle" }
  | { kind: "searching"; previous: SearchResults | null }
  | { kind: "done"; results: SearchResults; query: string }
  | { kind: "error"; message: string };

/**
 * Search conversations: in this space, or in every space. Results list each
 * matching conversation with up to three snippets; choosing one opens it
 * (switching space if needed). The input keeps focus; ArrowUp/ArrowDown move
 * through results and Enter opens the highlighted one.
 */
export function SearchDialog() {
  const open = useShell((s) => s.searchOpen);
  const setOpen = useShell((s) => s.setSearchOpen);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogPopup className="row-span-3 row-start-1 mt-[8vh] max-w-2xl self-start max-sm:mt-2" showCloseButton={false} bottomStickOnMobile={false}>
        {open ? <SearchBody onDone={() => setOpen(false)} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function SearchBody({ onDone }: { onDone(): void }) {
  const spaceId = useNav((s) => s.spaceId);
  const spaces = useSpaces((s) => s.spaces);
  const [query, setQuery] = useState("");
  const [allSpaces, setAllSpaces] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [active, setActive] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const listId = useId();
  const statusId = useId();
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setState({ kind: "idle" });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ kind: "searching", previous: s.kind === "done" ? s.results : s.kind === "searching" ? s.previous : null }));
    const t = setTimeout(() => {
      api.search(spaceId, q, allSpaces).then(
        (results) => {
          if (mine !== seq.current) return;
          setState({ kind: "done", results, query: q });
          setActive(0);
        },
        (e) => mine === seq.current && setState({ kind: "error", message: errorText(e) }),
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query, allSpaces, spaceId]);

  const results = state.kind === "done" ? state.results : state.kind === "searching" ? state.previous : null;
  const items = results?.conversations ?? [];

  async function choose(c: SearchConversation) {
    setOpenError(null);
    const problem = await openConversation(c.space, c.threadId);
    if (problem) setOpenError(problem);
    else onDone();
  }

  const statusText =
    state.kind === "done"
      ? items.length === 0
        ? `Nothing matches “${state.query}”${allSpaces ? " in any space" : " in this space"}.`
        : `${items.length}${state.results.truncated ? "+" : ""} conversation${items.length === 1 ? "" : "s"}`
      : state.kind === "error"
        ? state.message
        : "";

  return (
    <div className="flex max-h-[min(36rem,80vh)] min-h-0 flex-col">
      <DialogTitle className="sr-only">Search conversations</DialogTitle>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SearchIcon aria-hidden="true" className="size-4.5 shrink-0 text-muted-foreground" />
        <Input
          unstyled
          autoFocus
          type="search"
          role="combobox"
          aria-label="Search conversations"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-activedescendant={items.length > 0 ? `${listId}-${active}` : undefined}
          aria-describedby={statusId}
          placeholder={allSpaces ? "Search every space" : "Search this space"}
          value={query}
          className="min-w-0 flex-1 text-base [&_input]:h-8 [&_input]:px-0"
          onValueChange={(v) => setQuery(String(v))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && items.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % items.length);
            } else if (e.key === "ArrowUp" && items.length) {
              e.preventDefault();
              setActive((a) => (a - 1 + items.length) % items.length);
            } else if (e.key === "Enter" && items[active]) {
              e.preventDefault();
              void choose(items[active]);
            }
          }}
        />
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-muted-foreground text-sm">
          <Switch size="sm" checked={allSpaces} onCheckedChange={setAllSpaces} />
          All spaces
        </label>
      </div>

      <p id={statusId} role="status" className={cn("px-4 text-muted-foreground text-sm", statusText ? "pt-3" : "sr-only")}>
        {statusText}
      </p>
      {openError ? (
        <p role="alert" className="mx-4 mt-2 rounded-md bg-error-surface px-3 py-2 text-error-foreground text-sm">
          {openError}
        </p>
      ) : null}

      {state.kind === "searching" && !results ? (
        <div className="flex flex-col gap-3 p-4" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
          ))}
        </div>
      ) : null}

      {items.length > 0 ? (
        <ul id={listId} role="listbox" aria-label="Results" className={cn("min-h-0 flex-1 overflow-y-auto p-2", state.kind === "searching" && "opacity-70")}>
          {items.map((c, i) => {
            const space = spaces.find((s) => s.id === c.space);
            return (
              <li
                key={`${c.space}/${c.threadId}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="flex cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 aria-selected:bg-accent"
                onMouseMove={() => setActive(i)}
                onClick={() => void choose(c)}
              >
                <div className="flex items-center gap-2">
                  {allSpaces && space ? <SpaceMark name={space.name} hue={space.hue} className="size-5" /> : null}
                  <span className="min-w-0 flex-1 truncate font-medium text-sm">{c.title}</span>
                  <span className="shrink-0 text-muted-foreground text-xs">
                    {allSpaces && space ? `${space.name} · ` : ""}
                    {relativeTime(c.updated)}
                  </span>
                </div>
                {c.snippets.map((s) => (
                  <p key={`${s.message}-${s.before.length}`} className="line-clamp-2 text-muted-foreground text-sm leading-snug">
                    <span className="sr-only">{s.role === "user" ? "You: " : "Phaethon: "}</span>
                    {s.before}
                    <mark className="rounded-sm bg-space-soft px-0.5 text-foreground">{s.matched}</mark>
                    {s.after}
                  </p>
                ))}
                {c.matches > c.snippets.length ? (
                  <span className="text-muted-foreground text-xs">{c.matches - c.snippets.length} more in this conversation</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
