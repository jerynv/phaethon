import { GraduationCapIcon } from "@phosphor-icons/react";
import { ChevronRightIcon, DownloadIcon, EllipsisIcon, LogInIcon, PlusIcon, UnplugIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { SurfaceError } from "@/components/errors";
import { Skeleton } from "@/components/ui/skeleton";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { CourseDetail } from "./components/CourseDetail";
import { ConnectDialog } from "./components/ConnectDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ImportRun } from "./components/ImportRun";
import { byCode } from "./lib/selection";
import { connectionName, hostOf, kindLabel, whenText } from "./lib/sites";
import { COURSE_PARTS, type CourseInfo, type LmsConnection } from "./lib/types";
import { partsOf, useCourses } from "./store";

/** The Courses page of a space with study tools: course sites, their courses, and what this space sees. */
export function CoursesView({ space }: { space: SpaceView }) {
  const load = useCourses((s) => s.load);
  const connections = useCourses((s) => s.connections);
  const access = useCourses((s) => s.access);
  const run = useCourses((s) => s.run);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [importing, setImporting] = useState<LmsConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<LmsConnection | null>(null);
  const loading = (connections.loading && !connections.data) || (access.loading && !access.data);
  const showSkeleton = useDelayed(loading);

  useEffect(() => {
    void load();
  }, [load]);

  const courses = access.data?.courses ?? [];
  const open = openKey ? courses.find((c) => c.key === openKey) : undefined;
  const groups = useMemo(() => {
    if (!connections.data) return [];
    const list = connections.data;
    const known = new Set(list.map((c) => c.id));
    const out = list.map((c) => ({ connection: c as LmsConnection | null, courses: courses.filter((x) => x.connection === c.id).sort(byCode) }));
    const orphans = courses.filter((x) => !known.has(x.connection));
    if (orphans.length) out.push({ connection: null, courses: orphans.sort(byCode) });
    return out;
  }, [connections.data, courses]);

  const signInAgain = (c: LmsConnection) => {
    setImporting(null);
    setAgain(c);
  };
  const runConnection = run ? connections.data?.find((c) => c.id === run.connection) : undefined;

  const title = open ? (
    <div className="flex min-w-0 items-center gap-1.5">
      <button type="button" className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setOpenKey(null)}>
        Courses
      </button>
      <span className="text-subtle-foreground">/</span>
      <Truncate className="min-w-0">{open.name}</Truncate>
    </div>
  ) : (
    "Courses"
  );

  const hasAny = (connections.data?.length ?? 0) > 0 || courses.length > 0;
  const error = connections.error ?? access.error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={title}
        actions={
          !open && hasAny ? (
            <Button size="xs" variant="ghost" onClick={() => setConnect(true)}>
              <PlusIcon />
              Connect site
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {open ? (
          <CourseDetail key={open.key} space={space.id} course={open} />
        ) : (
          <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-6 px-4 py-6">
            {error && !loading ? <SurfaceError title="Couldn’t load your course sites" message={error} onRetry={() => void load()} /> : null}
            {run ? <ImportRun run={run} onSignInAgain={() => runConnection && signInAgain(runConnection)} /> : null}
            {loading ? (
              showSkeleton ? <CoursesSkeleton /> : null
            ) : !hasAny && !error ? (
              <Empty size="compact">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <GraduationCapIcon weight="regular" />
                  </EmptyMedia>
                  <EmptyTitle>No course sites</EmptyTitle>
                  <EmptyDescription>Connect Canvas, Brightspace, Moodle or Blackboard to bring your courses’ files, assignments and grades into Phaethon.</EmptyDescription>
                </EmptyHeader>
                <EmptyContent>
                  <Button size="sm" onClick={() => setConnect(true)}>
                    Connect a course site
                  </Button>
                </EmptyContent>
              </Empty>
            ) : !connections.data ? null : (
              groups.map((g) => (
                <section key={g.connection?.id ?? "other"} className="space-y-2">
                  {g.connection ? (
                    <ConnectionHeader
                      c={g.connection}
                      busy={run?.status === "running"}
                      onImport={() => setImporting(g.connection)}
                      onSignIn={() => signInAgain(g.connection!)}
                      onDisconnect={() => setDisconnecting(g.connection)}
                    />
                  ) : (
                    <div className="flex h-7 items-center px-1">
                      <h2 className="font-medium text-sm">Other courses</h2>
                    </div>
                  )}
                  {g.courses.length ? (
                    <div className="flex flex-col gap-0.5 rounded-xl border p-1">
                      {g.courses.map((c) => (
                        <CourseRow key={c.key} space={space.id} course={c} onOpen={() => setOpenKey(c.key)} />
                      ))}
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed px-3.5 py-3">
                      <span className="text-muted-foreground text-sm">No courses imported from this site yet.</span>
                      {g.connection?.signedIn ? (
                        <Button size="xs" variant="outline" disabled={run?.status === "running"} onClick={() => setImporting(g.connection)}>
                          Import courses
                        </Button>
                      ) : null}
                    </div>
                  )}
                </section>
              ))
            )}
          </div>
        )}
      </div>
      <ConnectDialog open={connect || !!again} again={again} onOpenChange={(o) => (o ? undefined : (setConnect(false), setAgain(null)))} onConnected={(c) => setImporting(c)} />
      <ImportDialog connection={importing} space={space.id} onOpenChange={(o) => !o && setImporting(null)} onSignInAgain={signInAgain} />
      <DisconnectDialog connection={disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)} />
    </div>
  );
}

function ConnectionHeader({ c, busy, onImport, onSignIn, onDisconnect }: { c: LmsConnection; busy: boolean; onImport: () => void; onSignIn: () => void; onDisconnect: () => void }) {
  const meta = [kindLabel(c.kind), c.schoolName ? hostOf(c.address) : null, c.lastSync ? `Imported ${whenText(c.lastSync)}` : "Not imported yet"].filter(Boolean).join(" · ");
  return (
    <div className="flex min-h-9 items-center gap-2 px-1">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 font-medium text-sm">
            <Truncate>{connectionName(c)}</Truncate>
          </h2>
          {!c.signedIn ? (
            <Badge variant="warning" size="sm" className="shrink-0">
              Signed out
            </Badge>
          ) : null}
        </div>
        <p className="truncate text-2xs text-muted-foreground tabular-nums">{meta}</p>
      </div>
      {c.signedIn ? (
        busy ? (
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <Button size="xs" variant="outline" disabled>
                <DownloadIcon />
                Import
              </Button>
            </TooltipTrigger>
            <TooltipPopup>An import is running</TooltipPopup>
          </Tooltip>
        ) : (
          <Button size="xs" variant="outline" onClick={onImport}>
            <DownloadIcon />
            Import
          </Button>
        )
      ) : (
        <Button size="xs" variant="outline" onClick={onSignIn}>
          <LogInIcon />
          Sign in
        </Button>
      )}
      <Menu>
        <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${connectionName(c)} actions`} />}>
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={onSignIn}>
            <LogInIcon />
            Sign in again
          </MenuItem>
          <MenuSeparator />
          <MenuItem variant="destructive" onClick={onDisconnect} disabled={!c.signedIn}>
            <UnplugIcon />
            Disconnect
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function CourseRow({ space, course, onOpen }: { space: string; course: CourseInfo; onOpen: () => void }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const setParts = useCourses((s) => s.setParts);
  const on = parts.length > 0;
  const summary = !on ? "Hidden here" : parts.length === COURSE_PARTS.length ? "All parts" : `${parts.length} of ${COURSE_PARTS.length} parts`;
  return (
    <div className="group flex h-9 items-center gap-1 rounded-md pr-2 transition-colors hover:bg-accent/60">
      <button type="button" onClick={onOpen} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2.5 text-left">
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <Truncate className={on ? "text-sm" : "text-muted-foreground text-sm"}>{course.name}</Truncate>
          {course.code ? <span className="max-w-32 shrink-0 truncate text-muted-foreground text-xs">{course.code}</span> : null}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{summary}</span>
        <ChevronRightIcon className="size-3.5 shrink-0 text-subtle-foreground group-hover:text-muted-foreground" strokeWidth={2} />
      </button>
      <Tooltip>
        <TooltipTrigger render={<span className="flex items-center pl-1" />}>
          <Switch size="sm" checked={on} onCheckedChange={(v) => void setParts(space, course.key, v ? COURSE_PARTS.map((p) => p.part) : [])} aria-label={`${course.name} in this space`} />
        </TooltipTrigger>
        <TooltipPopup>{on ? "Hide from this space" : "Show in this space"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function CoursesSkeleton() {
  return (
    <div className="space-y-2 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex h-9 flex-col justify-center gap-1.5 px-1">
        <Skeleton className="h-2.5 w-48 animate-none" />
        <Skeleton className="h-2 w-64 animate-none" />
      </div>
      <div className="flex flex-col gap-0.5 rounded-xl border p-1">
        {["58%", "34%", "46%"].map((w) => (
          <div key={w} className="flex h-9 items-center gap-3 px-2.5">
            <Skeleton className="h-2.5 animate-none" style={{ width: w }} />
            <span className="flex-1" />
            <Skeleton className="h-2 w-14 animate-none" />
            <Skeleton className="h-4 w-7 animate-none rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
