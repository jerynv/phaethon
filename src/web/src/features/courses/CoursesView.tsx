import { useEffect, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SearchField, SearchFieldAction } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { ArtEmpty } from "./components/ArtEmpty";
import { CourseDetail } from "./components/CourseDetail";
import { CourseTree, type SiteGroup } from "./components/CourseTree";
import { ConnectDialog } from "./components/ConnectDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ImportRun } from "./components/ImportRun";
import { byShortName } from "./lib/course-name";
import { plural } from "./lib/sites";
import type { LmsConnection } from "./lib/types";
import { partsOf, useCourses } from "./store";

/**
 * The Courses page of a space with study tools (docs/UI-REBUILD.md › Screens
 * › Courses; refs 7274, 02a1, 8bdf): on the left the course sites as folders
 * holding their courses (the pane folds away from the breadcrumb); on the
 * right the chosen course as one page, under a breadcrumb with its site's
 * actions and a `…` menu holding the course's settings.
 */
export function CoursesView({ space }: { space: SpaceView }) {
  const load = useCourses((s) => s.load);
  const connections = useCourses((s) => s.connections);
  const access = useCourses((s) => s.access);
  const run = useCourses((s) => s.run);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState(true);
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
  const groups = useMemo(() => {
    if (!connections.data) return [];
    const list = connections.data;
    const known = new Set(list.map((c) => c.id));
    const out: SiteGroup[] = list.map((c) => ({ id: c.id, connection: c as LmsConnection | null, courses: courses.filter((x) => x.connection === c.id).sort(byShortName) }));
    const orphans = courses.filter((x) => !known.has(x.connection));
    if (orphans.length) out.push({ id: "other", connection: null, courses: orphans.sort(byShortName) });
    return out;
  }, [connections.data, courses]);
  const ordered = groups.flatMap((g) => g.courses);
  const open = ordered.find((c) => c.key === openKey) ?? ordered.find((c) => partsOf(access.data, space.id, c.key).length > 0) ?? ordered[0];

  const signInAgain = (c: LmsConnection) => {
    setImporting(null);
    setAgain(c);
  };
  const runConnection = run ? connections.data?.find((c) => c.id === run.connection) : undefined;
  const hasAny = (connections.data?.length ?? 0) > 0 || courses.length > 0;
  const error = connections.error ?? access.error;
  const busy = run?.status === "running";

  const actions = {
    onImport: (c: LmsConnection) => setImporting(c),
    onSignIn: signInAgain,
    onDisconnect: (c: LmsConnection) => setDisconnecting(c),
    busy,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header />
      {loading ? (
        showSkeleton ? <CoursesSkeleton /> : null
      ) : error && !hasAny ? (
        <div className="mx-auto w-full max-w-(--page-max-width) px-8 pt-10">
          <SurfaceError title="Couldn’t load your course sites" message={error} onRetry={() => void load()} />
        </div>
      ) : !hasAny ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-10">
          {run ? (
            <div className="mx-auto max-w-(--page-max-width)">
              <ImportRun run={run} onSignInAgain={() => runConnection && signInAgain(runConnection)} />
            </div>
          ) : null}
          <ArtEmpty palette="sky" seed="courses-empty" title="No course sites" description="Connect Canvas, Brightspace, Moodle or Blackboard to import your courses.">
            <Button size="sm" onClick={() => setConnect(true)}>
              Connect a course site
            </Button>
          </ArtEmpty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={cn("flex w-70 shrink-0 flex-col border-r", !pane && open && "hidden")} aria-label="Courses">
            <div className="flex shrink-0 flex-col gap-(--pane-row-gap) px-2 pt-(--pane-top) pb-2">
              <div className="flex h-(--pane-row-height) items-center gap-2 pl-2">
                <h2 className="flex-1 type-title">Courses</h2>
                <Tooltip>
                  <TooltipTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label="Connect a course site" onClick={() => setConnect(true)} />}>
                    <Icon icon={icons.add} />
                  </TooltipTrigger>
                  <TooltipPopup>Connect a course site</TooltipPopup>
                </Tooltip>
              </div>
              <SearchField
                value={query}
                placeholder="Search courses"
                aria-label="Search courses"
                onChange={(e) => setQuery(e.target.value)}
                onClear={() => setQuery("")}
                trailing={
                  query ? (
                    <SearchFieldAction aria-label="Clear search" onClick={() => setQuery("")}>
                      <Icon icon={icons.close} />
                    </SearchFieldAction>
                  ) : null
                }
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t px-2 py-2" data-testid="course-list">
              <CourseTree space={space.id} groups={groups} query={query} openKey={open?.key} onOpen={setOpenKey} {...actions} />
            </div>
            <div className="flex h-(--footer-height) shrink-0 items-center border-t px-4 text-subtle-foreground text-xs tabular-nums" data-testid="course-count">
              <span className="truncate">
                {plural(courses.length, "course")} <span aria-hidden>·</span> {plural(connections.data?.length ?? 0, "site")}
              </span>
            </div>
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            {error ? (
              <div className="px-6 pt-4">
                <SurfaceError title="Couldn’t load your course sites" message={error} onRetry={() => void load()} />
              </div>
            ) : null}
            {open ? (
              <CourseDetail
                key={open.key}
                space={space.id}
                course={open}
                pane={pane}
                onPane={() => setPane((p) => !p)}
                connection={connections.data?.find((c) => c.id === open.connection) ?? null}
                run={run ? <ImportRun run={run} onSignInAgain={() => runConnection && signInAgain(runConnection)} /> : null}
                {...actions}
              />
            ) : (
              <div className="page-scroll flex min-h-0 flex-1 flex-col px-8 pt-10">
                {run ? (
                  <div className="mx-auto max-w-(--page-max-width)">
                    <ImportRun run={run} onSignInAgain={() => runConnection && signInAgain(runConnection)} />
                  </div>
                ) : null}
                <ArtEmpty palette="sky" seed="courses-none" title="No courses yet" description="Import courses from a connected site to browse their files here.">
                  {connections.data?.find((c) => c.signedIn) ? (
                    <Button size="sm" disabled={busy} onClick={() => setImporting(connections.data!.find((c) => c.signedIn)!)}>
                      <Icon icon={icons.download} />
                      Import courses
                    </Button>
                  ) : null}
                </ArtEmpty>
              </div>
            )}
          </div>
        </div>
      )}
      <ConnectDialog open={connect || !!again} again={again} onOpenChange={(o) => (o ? undefined : (setConnect(false), setAgain(null)))} onConnected={(c) => setImporting(c)} />
      <ImportDialog connection={importing} space={space.id} onOpenChange={(o) => !o && setImporting(null)} onSignInAgain={signInAgain} />
      <DisconnectDialog connection={disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)} />
    </div>
  );
}

function CoursesSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex w-70 shrink-0 flex-col border-r">
        <div className="flex flex-col gap-(--pane-row-gap) px-2 pt-(--pane-top) pb-2">
          <div className="flex h-(--pane-row-height) items-center pl-2">
            <Skeleton className="h-4 w-24 animate-none" />
          </div>
          <Skeleton className="h-(--search-field-height) w-full animate-none rounded-lg" />
        </div>
        <div className="flex flex-col gap-3 px-4 pt-3">
          <Skeleton className="h-7 w-full animate-none rounded-lg" />
          {["70%", "58%", "64%", "46%"].map((w) => (
            <Skeleton key={w} className="h-3 animate-none" style={{ width: w }} />
          ))}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-4 p-8">
        <Skeleton className="h-3 w-48 animate-none" />
        <Skeleton className="h-40 w-full max-w-(--page-max-width) animate-none rounded-card" />
      </div>
    </div>
  );
}
