import { useEffect, useState } from "react";
import { cleanMessage, RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Skeleton } from "@/components/ui/skeleton";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { type FileEntry, filesList, itemCount } from "../api";
import { Crumbs } from "./Crumbs";

/**
 * Choosing a folder in the space (Move to folder…, and the folders kept from
 * the agent in Settings): a breadcrumb for where you are, and that folder's
 * folders as rows; clicking one goes into it. `blocked` (the folder being
 * moved) can't be entered.
 */
export function FolderPicker({
  space,
  spaceName,
  value,
  onChange,
  blocked,
  className,
}: {
  space: string;
  spaceName: string;
  value: string;
  onChange: (folder: string) => void;
  blocked?: string;
  className?: string;
}) {
  const [state, setState] = useState<{
    dirs: FileEntry[] | null;
    error: string | null;
  }>({ dirs: null, error: null });
  const [attempt, setAttempt] = useState(0);
  const waiting = useDelayed(state.dirs === null && !state.error);

  useEffect(() => {
    let live = true;
    setState({ dirs: null, error: null });
    filesList(space, value, "name", false, 0, 2000).then(
      (p) => live && setState({ dirs: p.entries.filter((e) => e.dir), error: null }),
      (e) => live && setState({ dirs: null, error: cleanMessage(e) }),
    );
    return () => {
      live = false;
    };
  }, [space, value, attempt]);

  return (
    <div className={cn("flex min-h-0 flex-col overflow-hidden rounded-card border bg-card", className)}>
      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <Crumbs spaceName={spaceName} path={value} onGo={onChange} size="sm" />
      </div>
      <div role="listbox" aria-label="Folders" className="flex min-h-24 flex-col gap-px overflow-y-auto p-1">
        {state.error ? (
          <RowError message={state.error} onRetry={() => setAttempt((n) => n + 1)} className="px-2" />
        ) : state.dirs === null ? (
          waiting ? (
            <div className="flex flex-col gap-1.5 p-1">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : null
        ) : state.dirs.length === 0 ? (
          <p className="flex h-8 items-center px-2 text-muted-foreground text-sm">No folders in here.</p>
        ) : (
          state.dirs.map((d) => {
            const off = !!blocked && (d.path === blocked || d.path.startsWith(`${blocked}/`));
            return (
              <button
                key={d.path}
                type="button"
                role="option"
                aria-selected={false}
                disabled={off}
                onClick={() => onChange(d.path)}
                className="group flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <Icon icon={icons.folder} className="size-4 text-muted-foreground" />
                <Truncate className="min-w-0 flex-1">{d.name}</Truncate>
                <span className="type-meta shrink-0">{itemCount(d.count ?? 0)}</span>
                <Icon icon={icons.chevronRight} className="size-3.5 text-subtle-foreground" />
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
