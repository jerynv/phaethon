import { useEffect, useState } from "react";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { SiteMark } from "@/components/site-mark";
import { icons } from "@/components/icons";
import { SkeletonCard } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDelayed } from "@/hooks/use-delayed";
import { ConnectDialog } from "./components/ConnectDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { SpaceAccess } from "./components/SpaceAccess";
import { connectionName, hostOf, kindLabel, whenText } from "./lib/sites";
import type { LmsConnection } from "./lib/types";
import { useCourses } from "./store";

function Group({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex h-6 items-center justify-between gap-2 px-1">
        <h3 className="text-subtle-foreground text-xs">{label}</h3>
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
  const [connect, setConnect] = useState(false);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<LmsConnection | null>(null);
  const showConnSkeleton = useDelayed(connections.loading && !connections.data);

  useEffect(() => {
    void load();
  }, [load]);

  const list = connections.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <Group
        label="Course sites"
        action={
          list.length ? (
            <Button size="xs" variant="ghost" onClick={() => setConnect(true)}>
              <Icon icon={icons.add} />
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
          <div className="flex min-h-11 items-center gap-3 rounded-card border bg-card px-4 py-3">
            <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground"><Icon icon={icons.courses} className="size-4" /></span>
            <span className="min-w-0 flex-1 text-muted-foreground text-sm">No course sites connected.</span>
            <Button size="xs" variant="outline" onClick={() => setConnect(true)}>
              Connect site
            </Button>
          </div>
        ) : (
          <div className="divide-y rounded-card border bg-card">
            {list.map((c) => (
              <div key={c.id} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
                <SiteMark connection={c} className="size-6" />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <Truncate className="min-w-0 font-medium text-sm">{connectionName(c)}</Truncate>
                    <Badge variant={c.signedIn ? "success" : "warning"} size="lg" className="shrink-0">
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
        <SpaceAccess />
        {access.data?.problems.length ? (
          <div className="space-y-0.5 px-1">
            {access.data.problems.map((p, i) => (
              <p key={i} className="text-warning-foreground text-xs [overflow-wrap:anywhere]">
                {p}
              </p>
            ))}
          </div>
        ) : null}
        {access.data?.courses.length ? <p className="px-1 text-muted-foreground text-xs">Pick single parts from the Courses page of a space.</p> : null}
      </Group>

      <ConnectDialog open={connect || !!again} again={again} onOpenChange={(o) => (o ? undefined : (setConnect(false), setAgain(null)))} />
      <DisconnectDialog connection={disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)} />
    </div>
  );
}
