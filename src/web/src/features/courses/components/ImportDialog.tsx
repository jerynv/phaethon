import { useEffect, useMemo, useState } from "react";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { lmsCourses } from "../api";
import { byCode } from "../lib/selection";
import { connectionName, isSignedOut, plural } from "../lib/sites";
import type { LmsConnection, LmsCourse } from "../lib/types";
import { useCourses } from "../store";

/**
 * Choose courses to import from one site, and which spaces see the new ones.
 * Current-term courses not yet imported start selected.
 */
export function ImportDialog({
  connection,
  space,
  onOpenChange,
  onSignInAgain,
}: {
  connection: LmsConnection | null;
  space: string;
  onOpenChange: (open: boolean) => void;
  onSignInAgain: (c: LmsConnection) => void;
}) {
  const open = !!connection;
  const [courses, setCourses] = useState<LmsCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [spaces, setSpaces] = useState<Set<string>>(new Set([space]));
  const [tick, setTick] = useState(0);
  const allSpaces = useCourses((s) => s.spaces);
  const startImport = useCourses((s) => s.startImport);
  const busy = useCourses((s) => s.run?.status === "running");
  const showSkeleton = useDelayed(open && !courses && !error);

  useEffect(() => {
    if (!connection) return;
    let live = true;
    setCourses(null);
    setError(null);
    setSpaces(new Set([space]));
    lmsCourses(connection.id).then(
      (list) => {
        if (!live) return;
        setCourses(list);
        setPicked(new Set(list.filter((c) => c.current && !c.imported).map((c) => c.id)));
      },
      (e) => live && setError(cleanMessage(e)),
    );
    return () => {
      live = false;
    };
  }, [connection, space, tick]);

  const groups = useMemo(() => {
    if (!courses) return [];
    const by = new Map<string, LmsCourse[]>();
    for (const c of [...courses].sort((a, b) => Number(b.current) - Number(a.current) || byCode(a, b))) {
      const k = c.current ? `Current${c.term ? ` · ${c.term}` : ""}` : (c.term ?? "Other");
      by.set(k, [...(by.get(k) ?? []), c]);
    }
    return [...by.entries()];
  }, [courses]);

  const toggle = (id: string, on: boolean) =>
    setPicked((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const eduSpaces = allSpaces.filter((s) => s.educationEnabled || s.id === space);
  const chosen = courses?.filter((c) => picked.has(c.id)) ?? [];

  const start = () => {
    if (!connection || !chosen.length) return;
    startImport(connection, chosen, [...spaces], space);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import courses</DialogTitle>
          <DialogDescription className="truncate">{connection ? connectionName(connection) : ""}</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-5">
          {error ? (
            isSignedOut(error) && connection ? (
              <SurfaceError title="You’re signed out of this site" message="Sign in again to see its courses." tone="warning" actions={[{ label: "Sign in again", primary: true, onClick: () => onSignInAgain(connection) }]} />
            ) : (
              <SurfaceError title="Couldn’t load the courses" message={error} onRetry={() => setTick((n) => n + 1)} />
            )
          ) : !courses ? (
            showSkeleton ? <SkeletonRows count={5} withIcon className="-mx-2" /> : <div className="h-36" />
          ) : courses.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground text-sm">This site lists no courses for you.</p>
          ) : (
            groups.map(([label, list]) => {
              const all = list.every((c) => picked.has(c.id));
              return (
                <section key={label} className="space-y-1">
                  <div className="flex h-6 items-center justify-between">
                    <h3 className="font-medium text-2xs text-muted-foreground">{label}</h3>
                    <button type="button" className="font-medium text-2xs text-muted-foreground hover:text-foreground" onClick={() => list.forEach((c) => toggle(c.id, !all))}>
                      {all ? "Clear" : "Select all"}
                    </button>
                  </div>
                  <div className="-mx-2 flex flex-col gap-0.5">
                    {list.map((c) => (
                      <label key={c.id} className={cn("flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm hover:bg-accent/60")}>
                        <Checkbox checked={picked.has(c.id)} onCheckedChange={(v) => toggle(c.id, !!v)} />
                        <Truncate className="min-w-0 flex-1">{c.name}</Truncate>
                        {c.code ? <span className="max-w-32 shrink-0 truncate text-muted-foreground text-xs">{c.code}</span> : null}
                        {c.imported ? (
                          <Badge variant={c.partial ? "warning" : "secondary"} size="sm" className="shrink-0">
                            {c.partial ? "Partly imported" : "Imported"}
                          </Badge>
                        ) : null}
                      </label>
                    ))}
                  </div>
                </section>
              );
            })
          )}

          {courses?.length && eduSpaces.length > 1 ? (
            <section className="space-y-1.5">
              <h3 className="font-medium text-2xs text-muted-foreground">New courses show in</h3>
              <div className="flex flex-wrap gap-1.5">
                {eduSpaces.map((s) => {
                  const on = spaces.has(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setSpaces((x) => {
                          const n = new Set(x);
                          if (on && n.size > 1) n.delete(s.id);
                          else n.add(s.id);
                          return n;
                        })
                      }
                      className={cn(
                        "flex h-7 max-w-48 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors",
                        on ? "border-primary/40 bg-primary/8 text-foreground" : "border-input text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <SpaceAvatar name={s.name} hue={s.hue ?? 200} />
                      <span className="truncate">{s.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <span className="mr-auto self-center text-muted-foreground text-xs tabular-nums max-sm:hidden">{courses?.length ? `${chosen.length} of ${courses.length} selected` : ""}</span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={start} disabled={!chosen.length || busy}>
            {busy ? "An import is running" : chosen.length ? `Import ${plural(chosen.length, "course")}` : "Import"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
