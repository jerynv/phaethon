import { useEffect, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SearchField, SearchFieldAction } from "@/components/ui/search-field";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { useNarrow } from "@/hooks/use-narrow";
import { cn } from "@/lib/utils";
import { ArtEmpty } from "./components/ArtEmpty";
import { CourseDetail } from "./components/CourseDetail";
import { CourseTree, type SiteGroup } from "./components/CourseTree";
import { ConnectDialog } from "./components/ConnectDialog";
import { DeleteCourseDialog } from "./components/DeleteCourseDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ImportRun } from "./components/ImportRun";
import { byShortName } from "./lib/course-name";
import { plural } from "./lib/sites";
import type { CourseInfo, LmsConnection } from "./lib/types";
import { partsOf, useCourses } from "./store";

/**
 * The Courses page of a space with study tools (docs/UI-REBUILD.md › Screens
 * › Courses; refs 7274, 02a1, 8bdf): on the left the course sites as folders
 * holding their courses (the pane folds away from the breadcrumb); on the
 * right the chosen course as one page, under a breadcrumb with its site's
 * actions and a `…` menu holding the course's settings. Too narrow for both
 * side by side (`SPLIT_MIN_WIDTH`, the `@2xl` container size), it shows one at
 * a time: the course, with the breadcrumb's pane toggle bringing the list up
 * in its place, and choosing a course going back to it.
 */
const SPLIT_MIN_WIDTH = 672;
export function CoursesView({ space }: { space: SpaceView }) {
  const load = useCourses((s) => s.load);
  const connections = useCourses((s) => s.connections);
  const access = useCourses((s) => s.access);
  const run = useCourses((s) => s.run);
  const startUpdate = useCourses((s) => s.startUpdate);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState(true);
  // In a narrow page the list stands in for the course while it is asked for.
  const [listUp, setListUp] = useState(false);
  const [bodyRef, narrow] = useNarrow<HTMLDivElement>(SPLIT_MIN_WIDTH);
  const [connect, setConnect] = useState(false);
  const [again, setAgain] = useState<LmsConnection | null>(null);
  const [reopenImport, setReopenImport] = useState(false);
  const [importing, setImporting] = useState<LmsConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState<LmsConnection | null>(null);
  const [deleting, setDeleting] = useState<CourseInfo | null>(null);
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
  const listShown = narrow ? listUp || !open : pane;
  const choose = (key: string) => {
    setOpenKey(key);
    setListUp(false);
  };

  const signInAgain = (c: LmsConnection, openImport = true) => {
    setImporting(null);
    setReopenImport(openImport);
    setAgain(c);
  };
  const runConnection = connections.data?.find((c) => c.id === run?.signInConnection);
  const signInForRun = () => runConnection && signInAgain(runConnection, !run?.update);
  const hasAny = (connections.data?.length ?? 0) > 0 || courses.length > 0;
  const error = connections.error ?? access.error;
  const busy = run?.status === "running";
  const canUpdate = groups.some((group) => group.connection?.signedIn && group.courses.length);
  const updating = busy && !!run?.update;
  const update = () => {
    setListUp(false);
    startUpdate(space.id, courses);
  };

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
              <ImportRun run={run} onSignInAgain={signInForRun} />
            </div>
          ) : null}
          <ArtEmpty palette="sky" seed="courses-empty" title="No course sites" description="Connect Canvas, Brightspace, Moodle or Blackboard to import your courses.">
            <Button size="sm" onClick={() => setConnect(true)}>
              Connect a course site
            </Button>
          </ArtEmpty>
        </div>
      ) : (
        <div ref={bodyRef} className="flex min-h-0 flex-1">
          <aside className={cn("flex shrink-0 flex-col", narrow ? "flex-1" : "w-70 border-r", !listShown && open && "hidden")} aria-label="Courses">
            <div className="flex shrink-0 flex-col gap-(--pane-row-gap) px-2 pt-(--pane-top) pb-2">
              <div className="flex h-(--pane-row-height) items-center gap-2 pl-2">
                <h2 className="flex-1 type-title">Courses</h2>
                {narrow && canUpdate ? (
                  <Tooltip>
                    <TooltipTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label="Update courses" disabled={busy} onClick={update} />}>
                      {updating ? <Spinner size="sm" /> : <Icon icon={icons.reload} />}
                    </TooltipTrigger>
                    <TooltipPopup>Update courses</TooltipPopup>
                  </Tooltip>
                ) : null}
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
              <CourseTree space={space.id} groups={groups} query={query} openKey={open?.key} onOpen={choose} {...actions} />
            </div>
            <div className="flex h-(--footer-height) shrink-0 items-center border-t px-4 text-subtle-foreground text-xs tabular-nums" data-testid="course-count">
              <span className="truncate">
                {plural(courses.length, "course")} <span aria-hidden>·</span> {plural(connections.data?.length ?? 0, "site")}
              </span>
            </div>
          </aside>
          <div className={cn("flex min-w-0 flex-1 flex-col", narrow && listShown && "hidden")}>
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
                pane={listShown}
                onPane={() => (narrow ? setListUp((u) => !u) : setPane((p) => !p))}
                connection={connections.data?.find((c) => c.id === open.connection) ?? null}
                run={run ? <ImportRun run={run} onSignInAgain={signInForRun} /> : null}
                onUpdate={canUpdate ? update : undefined}
                updating={updating}
                onDelete={() => setDeleting(open)}
                {...actions}
              />
            ) : (
              <div className="page-scroll flex min-h-0 flex-1 flex-col px-8 pt-10">
                {run ? (
                  <div className="mx-auto max-w-(--page-max-width)">
                    <ImportRun run={run} onSignInAgain={signInForRun} />
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
      <ConnectDialog open={connect || !!again} again={again} onOpenChange={(o) => (o ? undefined : (setConnect(false), setAgain(null)))} onConnected={(c) => {
        if (!again || reopenImport) setImporting(c);
        else useCourses.getState().dismissRun();
      }} />
      <ImportDialog connection={importing} space={space.id} onOpenChange={(o) => !o && setImporting(null)} onSignInAgain={signInAgain} />
      <DisconnectDialog connection={disconnecting} onOpenChange={(o) => !o && setDisconnecting(null)} />
      {deleting ? <DeleteCourseDialog course={deleting} onClose={() => setDeleting(null)} /> : null}
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
