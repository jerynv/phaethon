import { GraduationCapIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { SurfaceError } from "@/components/errors";
import { SkeletonCard } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { ConnectDialog } from "./components/ConnectDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { byCode } from "./lib/selection";
import { connectionName, hostOf, kindLabel, whenText } from "./lib/sites";
import { COURSE_PARTS, type LmsConnection } from "./lib/types";
import { partsOf, useCourses } from "./store";

function Group({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex h-6 items-center justify-between gap-2 px-1">
        <h3 className="font-medium text-2xs text-muted-foreground">{label}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Settings › Courses: course-site connections and which space sees which course. Owned by the courses surface. */
export function CourseSettings() {
  const load = useCourses((s) => s.load);
  const connections = useCourses((s) => s.connections);
  const access = useCourses((s) => s.access);
  const spaces = useCourses((s) => s.spaces);
  const setParts = useCourses((s) => s.setParts);
  const [connect, setConnect] = useState(false);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<LmsConnection | null>(null);
  const showConnSkeleton = useDelayed(connections.loading && !connections.data);
  const showAccessSkeleton = useDelayed(access.loading && !access.data);

  useEffect(() => {
    void load();
  }, [load]);

  const list = connections.data ?? [];
  const courses = [...(access.data?.courses ?? [])].sort(byCode);
  const spaceIds = access.data?.spaces ?? [];
  const spaceOf = (id: string) => spaces.find((s) => s.id === id);
  const columns = [...spaceIds].sort((a, b) => Number(!!spaceOf(b)?.educationEnabled) - Number(!!spaceOf(a)?.educationEnabled) || (spaceOf(a)?.name ?? a).localeCompare(spaceOf(b)?.name ?? b));
  const siteOf = (connection: string) => list.find((c) => c.id === connection);

  return (
    <div className="flex flex-col gap-6">
      <Group
        label="Course sites"
        action={
          list.length ? (
            <Button size="xs" variant="ghost" onClick={() => setConnect(true)}>
              Connect site
            </Button>
          ) : null
        }
      >
        {connections.error && !connections.data ? (
          <SurfaceError title="Couldn’t load your course sites" message={connections.error} onRetry={() => void useCourses.getState().loadConnections()} />
        ) : !connections.data ? (
          showConnSkeleton ? <SkeletonCard rows={1} /> : <div className="h-15" />
        ) : list.length === 0 ? (
          <div className="flex min-h-11 items-center gap-3 rounded-xl border px-3.5 py-3">
            <GraduationCapIcon className="size-4 shrink-0 text-muted-foreground" weight="regular" />
            <span className="min-w-0 flex-1 text-muted-foreground text-sm">No course sites connected.</span>
            <Button size="xs" variant="outline" onClick={() => setConnect(true)}>
              Connect site
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-xl border">
            {list.map((c) => (
              <div key={c.id} className="flex min-h-11 items-center gap-3 px-3.5 py-3">
                <GraduationCapIcon className="size-4 shrink-0 text-muted-foreground" weight="regular" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Truncate className="min-w-0 font-medium text-sm">{connectionName(c)}</Truncate>
                    <Badge variant={c.signedIn ? "success" : "warning"} size="sm" className="shrink-0">
                      {c.signedIn ? "Signed in" : "Signed out"}
                    </Badge>
                  </div>
                  <p className="truncate text-muted-foreground text-xs tabular-nums">
                    {[kindLabel(c.kind), hostOf(c.address), c.lastSync ? `Last import ${whenText(c.lastSync)}` : "Not imported yet"].join(" · ")}
                  </p>
                </div>
                {c.signedIn ? (
                  <Button size="xs" variant="outline" onClick={() => setDisconnecting(c)}>
                    Disconnect
                  </Button>
                ) : (
                  <Button size="xs" variant="outline" onClick={() => setAgain(c)}>
                    Sign in
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Group>

      <Group label="Which space sees which course">
        {access.error && !access.data ? (
          <SurfaceError title="Couldn’t load course access" message={access.error} onRetry={() => void useCourses.getState().loadAccess()} />
        ) : !access.data ? (
          showAccessSkeleton ? <SkeletonCard rows={3} /> : <div className="h-36" />
        ) : courses.length === 0 ? (
          <div className="flex min-h-11 items-center rounded-xl border px-3.5 py-3 text-muted-foreground text-sm">Imported courses show here.</div>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b">
                  <th className="sticky left-0 z-10 min-w-48 bg-background px-3.5 py-2 text-left font-medium text-2xs text-muted-foreground">Course</th>
                  {columns.map((id) => {
                    const s = spaceOf(id);
                    return (
                      <th key={id} className="w-24 min-w-24 max-w-28 px-2 py-2 font-medium text-2xs text-muted-foreground">
                        <span className="flex min-w-0 items-center justify-center gap-1.5">
                          <SpaceAvatar name={s?.name ?? id} hue={s?.hue ?? 200} />
                          <Truncate className="min-w-0">{s?.name ?? id}</Truncate>
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody className="divide-y">
                {courses.map((c) => (
                  <tr key={c.key} className="h-11">
                    <td className="sticky left-0 z-10 max-w-64 bg-background px-3.5 py-1.5">
                      <Truncate className="text-sm">{c.name}</Truncate>
                      <p className="truncate text-muted-foreground text-xs">{[c.code, siteOf(c.connection) ? connectionName(siteOf(c.connection)!) : null].filter(Boolean).join(" · ")}</p>
                    </td>
                    {columns.map((id) => {
                      const parts = partsOf(access.data, id, c.key);
                      const all = parts.length === COURSE_PARTS.length;
                      const some = parts.length > 0 && !all;
                      const label = parts.length === 0 ? "Can’t see it" : all ? "Sees every part" : `Sees ${COURSE_PARTS.filter((p) => parts.includes(p.part)).map((p) => p.label.toLowerCase()).join(", ")}`;
                      return (
                        <td key={id} className="px-2 text-center">
                          <Tooltip>
                            <TooltipTrigger render={<span className="inline-flex" />}>
                              <Checkbox
                                checked={all}
                                indeterminate={some}
                                aria-label={`${spaceOf(id)?.name ?? id}: ${c.name}`}
                                onCheckedChange={() => void setParts(id, c.key, all ? [] : COURSE_PARTS.map((p) => p.part))}
                              />
                            </TooltipTrigger>
                            <TooltipPopup className="max-w-60">{label}</TooltipPopup>
                          </Tooltip>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {access.data?.problems.length ? (
          <div className="space-y-0.5 px-1">
            {access.data.problems.map((p, i) => (
              <p key={i} className="text-warning-foreground text-xs [overflow-wrap:anywhere]">
                {p}
              </p>
            ))}
          </div>
        ) : null}
        {courses.length ? <p className="px-1 text-muted-foreground text-xs">Pick single parts from the Courses page of a space.</p> : null}
      </Group>

      <ConnectDialog open={connect || !!again} again={again} onOpenChange={(o) => (o ? undefined : (setConnect(false), setAgain(null)))} />
      <DisconnectDialog connection={disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)} />
    </div>
  );
}
