import { useEffect, useMemo, useState } from "react";
import { useViewActive } from "@/app/Header";
import type { SpaceView } from "@/app/api";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { endText } from "../lib/import-run";
import { visibleCourses } from "../lib/selection";
import { whenText } from "../lib/sites";
import type { LmsConnection } from "../lib/types";
import { useCourses } from "../store";
import { ConnectDialog } from "./ConnectDialog";
import { CourseProgress } from "./ImportRun";

const STALE_AFTER = 24 * 60 * 60 * 1000;

/** Canvas controls for the composer and the chat's right gutter, scoped to this space. */
export function useChatCourseUpdate(space: SpaceView) {
  const active = useViewActive();
  const connections = useCourses((s) => s.connections.data);
  const access = useCourses((s) => s.access.data);
  const loadConnections = useCourses((s) => s.loadConnections);
  const loadAccess = useCourses((s) => s.loadAccess);
  const run = useCourses((s) => s.run);
  const startUpdate = useCourses((s) => s.startUpdate);
  const cancelUpdate = useCourses((s) => s.cancelImport);
  const dismissRun = useCourses((s) => s.dismissRun);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [now, setNow] = useState(Date.now);
  const [dismissedAt, setDismissedAt] = useState<number>();
  const courses = useMemo(() => {
    if (!access || !connections || !space.educationEnabled) return [];
    const canvas = new Set(connections.filter((c) => c.kind === "canvas").map((c) => c.id));
    return visibleCourses(access, space.id).filter((c) => canvas.has(c.connection));
  }, [access, connections, space.id, space.educationEnabled]);
  const hasCourses = courses.length > 0;

  useEffect(() => {
    if (!active || !space.educationEnabled) return;
    void loadConnections();
    void loadAccess();
  }, [active, loadAccess, loadConnections, space.educationEnabled]);

  useEffect(() => {
    if (!active || !hasCourses) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 60_000);
    return () => window.clearInterval(timer);
  }, [active, hasCourses]);

  if (!active || !hasCourses) return null;

  // The oldest snapshot is the most recent time we can say all of these
  // courses were up to date, even if a newer run refreshed only some of them.
  const updated = Math.min(...courses.map((c) => c.partial ? 0 : c.updated ?? 0));
  const missed = updated ? now - updated >= STALE_AFTER : true;
  const stale = missed && (dismissedAt === undefined || now - dismissedAt >= STALE_AFTER);
  const time = relativeTime(updated, now).replace(/^(Just now|Yesterday)$/, (text) => text.toLowerCase());
  const status = updated ? `Canvas updated ${time}` : "Canvas update time unknown";
  const timestamp = updated ? `Oldest course update · ${whenText(updated, now)}` : status;
  const busy = run?.status === "running";
  const canvasRun = run?.update && run.space === space.id && run.courses.every((row) => courses.some((c) => c.key === row.id)) ? run : null;
  const running = canvasRun?.status === "running";
  const completed = canvasRun?.courses.filter((c) => c.result || c.failed).length ?? 0;
  const runStatus = canvasRun && (running ? `${completed} of ${canvasRun.courses.length} courses` : endText(canvasRun));
  const reconnect = connections?.find((c) => c.id === canvasRun?.signInConnection);
  const update = () => startUpdate(space.id, courses);
  const label = running ? "Stop Canvas update" : reconnect ? "Sign in to Canvas" : "Update Canvas";
  const icon = running ? icons.stop : reconnect ? icons.signIn : icons.reload;
  const statusLine = running || canvasRun?.status === "failed" ? runStatus : status;
  const detail = canvasRun?.cancelError ?? canvasRun?.error ?? (running ? runStatus : timestamp);
  const control = (
    <div className="flex shrink-0 items-center gap-1">
      <span className="hidden text-subtle-foreground text-xs tabular-nums @min-[38rem]/composer:inline">{statusLine}</span>
      <Tooltip>
        <TooltipTrigger render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className={cn(stale && !canvasRun && "text-warning-foreground")}
            aria-label={label}
            disabled={running ? canvasRun.cancelling : busy}
            onClick={running ? () => void cancelUpdate() : reconnect ? () => setAgain(reconnect) : update}
          />
        }>
          {canvasRun?.cancelling ? <Spinner size="xs" /> : <Icon icon={icon} />}
          {running ? <CourseProgress run={canvasRun} decorative className="pointer-events-none absolute inset-x-1 bottom-0 overflow-hidden rounded-full" /> : null}
        </TooltipTrigger>
        <TooltipPopup>{label} · {detail}</TooltipPopup>
      </Tooltip>
    </div>
  );

  const panel = (
    <>
      {canvasRun || (stale && !busy) ? (
        // This gutter begins outside the centred 46rem conversation and
        // composer. The composer control also works in a narrow window.
        <aside aria-label="Canvas update" className="absolute top-3 right-4 z-10 hidden w-56 @min-[78rem]/chat:block">
          {canvasRun ? (
            <Card className="gap-1 px-3 py-2.5 text-xs">
              <CourseProgress run={canvasRun} className="absolute inset-x-0 top-0" />
              <div className="flex items-center gap-1.5">
                {running ? <Spinner size="xs" /> : <Icon icon={canvasRun.status === "failed" ? icons.warning : icons.courses} className="size-3.5 shrink-0" />}
                <p className="min-w-0 flex-1 font-medium">{running ? "Updating Canvas…" : runStatus}</p>
                {!running ? (
                  <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss Canvas update" onClick={dismissRun}>
                    <Icon icon={icons.close} />
                  </Button>
                ) : null}
              </div>
              {running ? <p className="pl-5 text-muted-foreground tabular-nums">{runStatus}</p> : null}
              {canvasRun.cancelError ? <p className="text-destructive-foreground [overflow-wrap:anywhere]">{canvasRun.cancelError}</p> : null}
            </Card>
          ) : (
            <Alert variant="warning" surface="glass" controlAlignment="first-line" className="text-xs">
              <Icon icon={icons.warning} />
              <AlertTitle>Update Canvas?</AlertTitle>
              <AlertDescription>
                {updated ? `Last updated ${whenText(updated, now)}` : "Update time unknown"}
                <Button size="xs" variant="outline" className="self-start" onClick={update}>Update</Button>
              </AlertDescription>
              <AlertAction>
                <Button size="icon-xs" variant="ghost-muted" aria-label="Dismiss Canvas reminder" onClick={() => setDismissedAt(Date.now())}>
                  <Icon icon={icons.close} />
                </Button>
              </AlertAction>
            </Alert>
          )}
        </aside>
      ) : null}
      <ConnectDialog open={!!again} again={again} onOpenChange={(o) => !o && setAgain(null)} onConnected={() => useCourses.getState().dismissRun()} />
    </>
  );
  return { control, panel };
}
