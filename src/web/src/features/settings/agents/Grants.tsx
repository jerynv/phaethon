/**
 * Folders shared between spaces (grants.json): what this space may read in
 * others, and what others may read in it. Revoking takes effect at once; the
 * row then offers Undo until the view closes or the core forgets it (just
 * under its ten minutes).
 */
import { ArrowLeftIcon, ArrowRightIcon, FileIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/core";

import type { SpaceView } from "../providers/api";
import { FieldMessage, Group } from "../providers/ui";
import { listGrants, restoreGrant, revokeGrant, type GrantsView } from "./api";

/** Just under the core's ten minutes, so an Undo shown always works. */
const UNDO_MS = 9 * 60_000;

type Item = { id: string; direction: "in" | "out"; other: string; path: string; created: string };

function sinceText(created: string): string {
  const d = new Date(created);
  if (!created || Number.isNaN(d.getTime())) return "";
  return `Since ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })}`;
}

export function Grants({ space, spaces, onSaid }: { space: string; spaces: SpaceView[]; onSaid: (t: string) => void }) {
  const [view, setView] = useState<GrantsView | null>(null);
  const [error, setError] = useState("");
  /** Revoked here: shown with Undo until the timer ends. */
  const [undoable, setUndoable] = useState<Record<string, Item>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const load = useCallback(async () => {
    try {
      setView(await listGrants(space));
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [space]);

  useEffect(() => {
    void load();
    setUndoable({});
    const t = timers.current;
    return () => {
      t.forEach(clearTimeout);
      t.clear();
    };
  }, [load]);

  const nameOf = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;

  async function revoke(item: Item) {
    try {
      await revokeGrant(item.id);
      setUndoable((u) => ({ ...u, [item.id]: item }));
      timers.current.set(
        item.id,
        setTimeout(() => setUndoable(({ [item.id]: _gone, ...rest }) => rest), UNDO_MS),
      );
      onSaid(item.direction === "in" ? `This space can no longer read ${nameOf(item.other)} › ${item.path}.` : `${nameOf(item.other)} can no longer read ${item.path}.`);
      await load();
      // Focus stays on the row: its Undo button replaces Revoke.
      requestAnimationFrame(() => document.getElementById(`grant-undo-${item.id}`)?.focus());
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function undo(item: Item) {
    clearTimeout(timers.current.get(item.id));
    timers.current.delete(item.id);
    try {
      await restoreGrant(item.id);
      onSaid("Access is back.");
    } catch (e) {
      setError(errorText(e));
    }
    setUndoable(({ [item.id]: _gone, ...rest }) => rest);
    await load();
    requestAnimationFrame(() => document.getElementById(`grant-revoke-${item.id}`)?.focus());
  }

  if (!view && !error) {
    return (
      <Group aria-busy="true" aria-label="Loading shared folders">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-3.5 w-1/4" />
            </div>
          </div>
        ))}
      </Group>
    );
  }

  const live: Item[] = view
    ? [
        ...view.grants.map((g) => ({ id: g.id, direction: "in" as const, other: g.from, path: g.path, created: g.created })),
        ...view.incoming.map((g) => ({ id: g.id, direction: "out" as const, other: g.to, path: g.path, created: g.created })),
      ]
    : [];
  // Revoked rows stay where they were, with Undo.
  const items = [...live, ...Object.values(undoable).filter((u) => !live.some((l) => l.id === u.id))];
  const reads = items.filter((i) => i.direction === "in");
  const readBy = items.filter((i) => i.direction === "out");

  return (
    <div className="flex flex-col gap-3">
      {error ? <FieldMessage tone="error">{error}</FieldMessage> : null}
      {view?.problems.length ? (
        <Alert variant="warning">
          <AlertTitle>Some entries in grants.json were skipped</AlertTitle>
          <AlertDescription>
            <ul className="list-disc ps-4">
              {view.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {view && !items.length ? (
        <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
          Nothing is shared between this space and another. When the assistant asks to read another space and you choose “Always”, it shows here.
        </div>
      ) : null}
      {reads.length ? (
        <GrantList title={`${nameOf(space)} can read`} items={reads} nameOf={nameOf} undoable={undoable} onRevoke={revoke} onUndo={undo} />
      ) : null}
      {readBy.length ? (
        <GrantList title={`Can read ${nameOf(space)}`} items={readBy} nameOf={nameOf} undoable={undoable} onRevoke={revoke} onUndo={undo} />
      ) : null}
    </div>
  );
}

function GrantList({
  title,
  items,
  nameOf,
  undoable,
  onRevoke,
  onUndo,
}: {
  title: string;
  items: Item[];
  nameOf: (id: string) => string;
  undoable: Record<string, Item>;
  onRevoke: (i: Item) => void;
  onUndo: (i: Item) => void;
}) {
  const headingId = `grants-${title.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="flex flex-col gap-1.5">
      <h5 id={headingId} className="px-1 text-sm font-medium text-muted-foreground">
        {title}
      </h5>
      <Group>
        <ul aria-labelledby={headingId} className="[&>li+li]:border-t">
          {items.map((item) => {
            const gone = !!undoable[item.id];
            const Arrow = item.direction === "in" ? ArrowLeftIcon : ArrowRightIcon;
            return (
              <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground">
                  {item.path.includes(".") ? <FileIcon className="size-4" /> : <Arrow className="size-4" />}
                </span>
                <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
                  <span className={gone ? "text-[0.9375rem] text-muted-foreground line-through" : "text-[0.9375rem]"}>
                    <span className="font-medium">{nameOf(item.other)}</span>
                    <span className="text-muted-foreground"> › </span>
                    <span className="font-mono text-sm [overflow-wrap:anywhere]">{item.path}</span>
                  </span>
                  <span className="text-sm text-muted-foreground">{gone ? "Access removed" : sinceText(item.created)}</span>
                </div>
                {gone ? (
                  <Button id={`grant-undo-${item.id}`} variant="outline" size="sm" onClick={() => onUndo(item)}>
                    Undo
                    <span className="sr-only">
                      {" "}
                      removing {nameOf(item.other)} › {item.path}
                    </span>
                  </Button>
                ) : (
                  <Button id={`grant-revoke-${item.id}`} variant="ghost-destructive" size="sm" onClick={() => onRevoke(item)}>
                    Revoke
                    <span className="sr-only">
                      {" "}
                      {nameOf(item.other)} › {item.path}
                    </span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Group>
    </div>
  );
}
