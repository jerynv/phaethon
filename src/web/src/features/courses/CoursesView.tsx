import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { ArtEmpty } from "./components/ArtEmpty";
import { CourseDetail, type DetailTab } from "./components/CourseDetail";
import { ConnectDialog } from "./components/ConnectDialog";
import { DisconnectDialog } from "./components/DisconnectDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ImportRun } from "./components/ImportRun";
import { byCode } from "./lib/selection";
import { connectionName, kindLabel, plural } from "./lib/sites";
import type { CourseInfo, LmsConnection } from "./lib/types";
import { partsOf, useCourses } from "./store";

/**
 * The Courses page of a space with study tools (docs/UI-REBUILD.md › Screens
 * › Courses; refs 7274, 02a1, 8bdf): on the left the course sites as folders
 * holding their courses (the pane folds away from the breadcrumb); on the
 * right the chosen course, under a breadcrumb with its site's actions and
 * underline tabs for Overview · Files · Settings.
 */
export function CoursesView({ space }: { space: SpaceView }) {
  const load = useCourses((s) => s.load);
  const connections = useCourses((s) => s.connections);
  const access = useCourses((s) => s.access);
  const run = useCourses((s) => s.run);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<Record<string, boolean>>({});
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
    const out = list.map((c) => ({ id: c.id, connection: c as LmsConnection | null, courses: courses.filter((x) => x.connection === c.id).sort(byCode) }));
    const orphans = courses.filter((x) => !known.has(x.connection));
    if (orphans.length) out.push({ id: "other", connection: null, courses: orphans.sort(byCode) });
    return out;
  }, [connections.data, courses]);
  const ordered = groups.flatMap((g) => g.courses);
  const open = ordered.find((c) => c.key === openKey) ?? ordered[0];

  const signInAgain = (c: LmsConnection) => {
    setImporting(null);
    setAgain(c);
  };
  const runConnection = run ? connections.data?.find((c) => c.id === run.connection) : undefined;
  const hasAny = (connections.data?.length ?? 0) > 0 || courses.length > 0;
  const error = connections.error ?? access.error;
  const q = query.trim().toLowerCase();
  const busy = run?.status === "running";

  const actions = {
    onImport: (c: LmsConnection) => setImporting(c),
    onSignIn: signInAgain,
    onDisconnect: (c: LmsConnection) => setDisconnecting(c),
    busy,
  };

  const isHidden = (c: CourseInfo) => partsOf(access.data, space.id, c.key).length === 0;
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
          <ArtEmpty palette="sky" seed="courses-empty" title="No course sites" description="Connect Canvas, Brightspace, Moodle or Blackboard to bring your courses’ files, assignments and grades into Phaethon.">
            <Button size="sm" onClick={() => setConnect(true)}>
              Connect a course site
            </Button>
          </ArtEmpty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className={cn("flex w-70 shrink-0 flex-col border-r", !pane && open && "hidden")} aria-label="Courses">
            <div className="flex h-14 shrink-0 items-center gap-2 px-4">
              <h2 className="flex-1 font-medium text-lg tracking-title">Courses</h2>
              <Tooltip>
                <TooltipTrigger render={<Button size="icon-sm" aria-label="Connect a course site" onClick={() => setConnect(true)} />}>
                  <Icon icon={icons.add} />
                </TooltipTrigger>
                <TooltipPopup>Connect a course site</TooltipPopup>
              </Tooltip>
            </div>
            <div className="flex flex-col gap-3 px-4 pb-3">
              <div className="relative">
                <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
                <Input size="sm" value={query} placeholder="Search courses" aria-label="Search courses" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto border-t px-2 py-2" data-testid="course-list">
              {groups.map((g) => {
                const list = q ? g.courses.filter((c) => c.name.toLowerCase().includes(q) || (c.code ?? "").toLowerCase().includes(q)) : g.courses;
                if (q && !list.length) return null;
                const isFolded = !q && folded[g.id];
                return (
                  <div key={g.id} className="flex flex-col">
                    <SiteRow
                      connection={g.connection}
                      folded={!!isFolded}
                      onFold={() => setFolded((f) => ({ ...f, [g.id]: !f[g.id] }))}
                      {...actions}
                    />
                    <AnimatePresence initial={false}>
                      {!isFolded ? (
                        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
                          <div className="ml-4 flex flex-col border-l pl-2">
                            {list.filter((c) => !isHidden(c)).map((c) => (
                              <CourseRow key={c.key} space={space.id} course={c} selected={open?.key === c.key} onOpen={() => setOpenKey(c.key)} />
                            ))}
                            {list.some(isHidden) ? (
                              <>
                                <p className="mt-2 flex h-6 items-center px-2 text-2xs text-subtle-foreground">Hidden from this space</p>
                                {list.filter(isHidden).map((c) => (
                                  <CourseRow key={c.key} space={space.id} course={c} selected={open?.key === c.key} onOpen={() => setOpenKey(c.key)} />
                                ))}
                              </>
                            ) : null}
                            {!g.courses.length && g.connection?.signedIn ? (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setImporting(g.connection)}
                                className="flex h-8 items-center gap-2 rounded-md px-2 text-primary text-sm hover:bg-primary/6 disabled:opacity-60"
                              >
                                <Icon icon={icons.download} className="size-4" />
                                Import courses
                              </button>
                            ) : !g.courses.length ? (
                              <p className="px-2 py-1.5 text-muted-foreground text-xs">No courses imported yet.</p>
                            ) : null}
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                );
              })}
              {q && !groups.some((g) => g.courses.some((c) => c.name.toLowerCase().includes(q) || (c.code ?? "").toLowerCase().includes(q))) ? (
                <p className="px-2 py-2 text-muted-foreground text-sm">No course matches “{query.trim()}”.</p>
              ) : null}
            </div>
            <div className="flex h-11 shrink-0 items-center justify-end gap-1.5 border-t px-4 text-subtle-foreground text-xs tabular-nums">
              {plural(courses.length, "course")} <span aria-hidden>·</span> {plural(connections.data?.length ?? 0, "site")}
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
                tab={tab}
                onTab={setTab}
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
                <ArtEmpty palette="sky" seed="courses-none" title="No courses yet" description="Import courses from a connected site to browse their files and choose what this space sees.">
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

type SiteActions = { onImport: (c: LmsConnection) => void; onSignIn: (c: LmsConnection) => void; onDisconnect: (c: LmsConnection) => void; busy: boolean };

/** A site in the tree: a folder that folds its courses away, its sign-in state, and its actions on hover. */
function SiteRow({ connection: c, folded, onFold, onImport, onSignIn, onDisconnect, busy }: { connection: LmsConnection | null; folded: boolean; onFold: () => void } & SiteActions) {
  return (
    <div className="group flex h-8 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-accent">
      <button type="button" aria-expanded={!folded} onClick={onFold} className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <Icon icon={folded ? icons.folder : icons.folderOpen} className="size-4 text-muted-foreground" />
        <Truncate className="min-w-0 font-medium">{c ? connectionName(c) : "Other courses"}</Truncate>
        {c ? (
          <Tooltip>
            <TooltipTrigger render={<span className={cn("size-1.5 shrink-0 rounded-full", c.signedIn ? "bg-success" : "bg-warning")} aria-label={c.signedIn ? "Signed in" : "Signed out"} />} />
            <TooltipPopup>
              {kindLabel(c.kind)} · {c.signedIn ? "signed in" : "signed out"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </button>
      {c && !c.signedIn ? (
        <Button size="xs" variant="ghost" className="text-primary" onClick={() => onSignIn(c)}>
          Sign in
        </Button>
      ) : null}
      {c ? (
        <Menu>
          <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${connectionName(c)} actions`} className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-popup-open:opacity-100" />}>
            <Icon icon={icons.more} />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={!c.signedIn || busy} onClick={() => onImport(c)}>
              <Icon icon={icons.download} />
              Import courses
            </MenuItem>
            <MenuItem onClick={() => onSignIn(c)}>
              <Icon icon={icons.signIn} />
              Sign in again
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => onDisconnect(c)}>
              <Icon icon={icons.disconnected} />
              Disconnect
            </MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}

function CourseRow({ space, course, selected, onOpen }: { space: string; course: CourseInfo; selected: boolean; onOpen: () => void }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const hidden = parts.length === 0;
  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      className={cn(
        "flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-row-selected hover:bg-row-selected",
      )}
    >
      <Icon icon={icons.courses} className={cn("size-4", selected ? "text-foreground" : "text-muted-foreground")} />
      <Truncate className={cn("min-w-0 flex-1", hidden && "text-muted-foreground")}>{course.name}</Truncate>
      {hidden ? <span className="shrink-0 text-2xs text-subtle-foreground">Hidden</span> : course.code ? <span className="max-w-20 shrink-0 truncate text-2xs text-subtle-foreground">{course.code}</span> : null}
    </button>
  );
}

function CoursesSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex w-70 shrink-0 flex-col gap-3 border-r p-4">
        <Skeleton className="h-4 w-24 animate-none" />
        <Skeleton className="h-7 w-full animate-none rounded-lg" />
        <Skeleton className="h-7 w-full animate-none rounded-lg" />
        {["70%", "58%", "64%", "46%"].map((w) => (
          <Skeleton key={w} className="h-3 animate-none" style={{ width: w }} />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-4 p-8">
        <Skeleton className="h-3 w-48 animate-none" />
        <Skeleton className="h-40 w-full max-w-(--page-max-width) animate-none rounded-card" />
      </div>
    </div>
  );
}
