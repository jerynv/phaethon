import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Spinner } from "@/components/ui/spinner";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { FileIcon } from "@/features/viewer/FileIcon";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { lmsCourseContent } from "../api";
import { fileGroups, skippedGroups } from "../lib/content";
import { stepText } from "../lib/import-run";
import { connectionName, formatBytes, plural, whenText } from "../lib/sites";
import type { CourseContent, CourseContentEntry, CourseInfo, LmsConnection } from "../lib/types";
import { partsOf, useCourses } from "../store";
import { CourseSettingsDialog } from "./CourseSettingsDialog";

const SECTIONS: { kind: CourseContentEntry["kind"][]; label: string; icon: IconData }[] = [
  { kind: ["overview", "page"], label: "Pages", icon: icons.read },
  { kind: ["module"], label: "Modules", icon: icons.deck },
  { kind: ["assignment"], label: "Assignments", icon: icons.quiz },
];

type SiteActions = { onImport: (c: LmsConnection) => void; onSignIn: (c: LmsConnection) => void; onDisconnect: (c: LmsConnection) => void; busy: boolean };

/**
 * One course (refs 7274, 02a1, dc42) as one page: a breadcrumb row with the
 * pane toggle, Import and a `…` menu (Course settings, the site's sign-in),
 * then a card with the course's term and numbers, then its content in grouped
 * lists to open in the viewer.
 */
export function CourseDetail({
  space,
  course,
  pane,
  onPane,
  connection,
  run,
  onImport,
  onSignIn,
  onDisconnect,
  busy,
}: { space: string; course: CourseInfo; pane: boolean; onPane: () => void; connection: LmsConnection | null; run: ReactNode } & SiteActions) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const partsKey = parts.join(",");
  const reduce = useReducedMotion();
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    if (!partsKey) return;
    let live = true;
    setError(null);
    const t = setTimeout(() => {
      lmsCourseContent(space, course.key).then(
        (c) => live && setContent(c),
        (e) => live && setError(cleanMessage(e)),
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [space, course.key, partsKey, tick]);

  const state = { content: parts.length ? content : null, error, retry: () => setTick((n) => n + 1), hidden: parts.length === 0, onSettings: () => setSettings(true) };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 px-6 @container/crumb">
        <Tooltip>
          <TooltipTrigger render={<Button size="icon-sm" variant="ghost-muted" className="-ml-2" aria-label={pane ? "Hide the course list" : "Show the course list"} aria-pressed={!pane} onClick={onPane} />}>
            <Icon icon={icons.sidebar} />
          </TooltipTrigger>
          <TooltipPopup>{pane ? "Hide the course list" : "Show the course list"}</TooltipPopup>
        </Tooltip>
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          {/* The site gives up its room first, and goes when the row is narrow, so the course keeps its name. */}
          <span className="flex min-w-8 shrink-4 items-center gap-2 @max-md/crumb:hidden">
            <Icon icon={icons.folder} className="size-4 shrink-0 text-muted-foreground" />
            <Truncate className="min-w-0 max-w-56 text-muted-foreground">{connection ? connectionName(connection) : "Other courses"}</Truncate>
            <Icon icon={icons.chevronRight} className="size-3.5 shrink-0 text-subtle-foreground" />
          </span>
          <Icon icon={icons.courses} className="size-4 shrink-0 text-muted-foreground" />
          <Truncate className="min-w-16 shrink font-medium" aria-current="page">
            {course.name}
          </Truncate>
        </nav>
        {connection ? (
          connection.signedIn ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onImport(connection)}>
              {busy ? <Spinner size="sm" /> : <Icon icon={icons.download} />}
              {busy ? "Importing…" : "Import"}
            </Button>
          ) : (
            <Button size="sm" onClick={() => onSignIn(connection)}>
              <Icon icon={icons.signIn} />
              Sign in
            </Button>
          )
        ) : null}
        <Menu>
          <MenuTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label="Course actions" />}>
            <Icon icon={icons.more} />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => setSettings(true)}>
              <Icon icon={icons.settings} />
              Course settings
            </MenuItem>
            {connection ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => onSignIn(connection)}>
                  <Icon icon={icons.signIn} />
                  Sign in again
                </MenuItem>
                <MenuItem variant="destructive" onClick={() => onDisconnect(connection)}>
                  <Icon icon={icons.disconnected} />
                  Disconnect {connectionName(connection)}
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
      <div className="page-scroll min-h-0 flex-1">
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="mx-auto flex w-full max-w-(--page-max-width) flex-col gap-6 px-8 pt-8 pb-16"
        >
          {run}
          <Overview course={course} {...state} />
          <Files space={space} {...state} />
          {content?.skipped?.length && !state.hidden ? <Skipped notes={content.skipped} /> : null}
        </motion.div>
      </div>
      <CourseSettingsDialog space={space} course={course} open={settings} onOpenChange={setSettings} />
    </div>
  );
}

type ContentState = { content: CourseContent | null; error: string | null; retry: () => void; hidden: boolean; onSettings: () => void };

/** The course's term and sign-in state, and its numbers. The breadcrumb already names it. */
function Overview({ course, content, error, retry, hidden }: { course: CourseInfo } & ContentState) {
  const meta = [course.term, content?.updated ? `Updated ${whenText(content.updated)}` : null].filter(Boolean).join(" · ");
  const n = (kinds: CourseContentEntry["kind"][]) => (content ? content.entries.filter((e) => kinds.includes(e.kind)).length : "–");
  const bytes = content?.entries.reduce((s, e) => s + (e.bytes ?? 0), 0) ?? 0;
  if (hidden) return null;
  return (
    <Card>
      <CardContent className="@container">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2" data-testid="course-meta">
          <SiteState course={course} />
          {meta ? <p className="min-w-0 truncate text-muted-foreground text-xs tabular-nums">{meta}</p> : null}
        </div>
        {error ? (
          <SurfaceError title="Couldn’t load this course" message={error} onRetry={retry} />
        ) : (
          <StatGrid>
            <StatTile label="Files" value={n(["file"])} hint={content ? formatBytes(bytes) : undefined} />
            <StatTile label="Pages" value={n(["overview", "page"])} />
            <StatTile label="Modules" value={n(["module"])} />
            <StatTile label="Assignments" value={n(["assignment"])} />
          </StatGrid>
        )}
      </CardContent>
    </Card>
  );
}

function Files({ space, content, error, hidden, onSettings }: { space: string } & ContentState) {
  const openFile = useNav((s) => s.openFile);
  const viewing = useNav((s) => s.viewer);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const showSkeleton = useDelayed(!content && !error && !hidden);
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = content?.entries ?? [];
    return q ? all.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)) : all;
  }, [content, query]);

  if (hidden)
    return (
      <Quiet>
        <p>This space can’t see this course.</p>
        <Button size="sm" variant="outline" onClick={onSettings}>
          <Icon icon={icons.settings} />
          Course settings
        </Button>
      </Quiet>
    );
  if (error) return null;
  if (!content) return showSkeleton ? <div className="rounded-xl border bg-well p-1.5"><SkeletonRows count={6} withIcon /></div> : null;
  if (!content.entries.length) return <Quiet>Nothing was imported for the parts this space can see.</Quiet>;
  return (
    <section className="flex flex-col gap-6" aria-label="Course content">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-medium text-base tracking-title">
          Content <span className="font-normal text-muted-foreground tabular-nums">{content.entries.length}</span>
        </h2>
        <Tabs value={kind} onValueChange={(v: string) => setKind(v)}>
          <TabsList aria-label="Kind" size="sm">
            <TabsTab value="all">All</TabsTab>
            <TabsTab value="files">Files</TabsTab>
            {SECTIONS.map((s) => (
              <TabsTab key={s.label} value={s.label}>
                {s.label}
              </TabsTab>
            ))}
          </TabsList>
        </Tabs>
        <div className="relative w-48">
          <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input size="sm" value={query} placeholder="Filter" aria-label="Filter content" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {!entries.length ? (
        <p className="px-1 text-muted-foreground text-sm">Nothing matches “{query.trim()}”.</p>
      ) : (
        <>
          {(kind === "all" || kind === "files" ? fileGroups(entries) : []).map((g) => (
            <EntryGroup key={g.id} label={g.label} icon={g.id === "attached" ? icons.announcement : undefined} count={g.entries.length} testId={g.id === "attached" ? "course-attached" : undefined}>
              {g.entries.map((e, i) => (
                <EntryRow key={`${e.path}#${i}`} entry={e} selected={viewing?.space === space && viewing.path === e.path} onOpen={() => openFile(space, e.path)} />
              ))}
            </EntryGroup>
          ))}
          {SECTIONS.map((s) => {
            const list = kind === "all" || kind === s.label ? entries.filter((e) => s.kind.includes(e.kind)) : [];
            if (!list.length) return null;
            return (
              <EntryGroup key={s.label} label={s.label} count={list.length}>
                {list.map((e, i) => (
                  <EntryRow
                    key={`${e.path}#${e.anchor ?? ""}#${i}`}
                    entry={e}
                    icon={s.icon}
                    selected={viewing?.space === space && viewing.path === e.path && (e.kind === "overview" || e.kind === "page")}
                    onOpen={() => openFile(space, e.path)}
                  />
                ))}
              </EntryGroup>
            );
          })}
          {content.truncated ? <p className="px-1 text-muted-foreground text-xs">Showing the first {plural(content.entries.length, "item")}.</p> : null}
        </>
      )}
    </section>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">{children}</div>;
}

function EntryGroup({ label, icon, count, children, testId }: { label: string; icon?: IconData; count: number; children: ReactNode; testId?: string }) {
  return (
    <section className="flex flex-col gap-2" data-testid={testId}>
      <h3 className="flex items-center gap-1.5 px-1 text-muted-foreground text-xs">
        {icon ? <Icon icon={icon} className="size-3.5" /> : null}
        {label} <span className="tabular-nums">{count}</span>
      </h3>
      <div className="flex flex-col rounded-xl border border-border/70 bg-well p-1.5">{children}</div>
    </section>
  );
}

function EntryRow({ entry: e, icon, selected, onOpen }: { entry: CourseContentEntry; icon?: IconData; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-row-selected hover:bg-row-selected",
      )}
    >
      {e.kind === "file" ? <FileIcon name={e.title} /> : <Icon icon={icon ?? icons.fileText} className="size-4 text-muted-foreground" />}
      <span className="flex min-w-0 flex-1 flex-col">
        {e.kind === "file" ? <MiddleTruncate value={e.title} className="min-w-0 [&>span]:whitespace-pre" /> : <Truncate className="min-w-0">{e.title}</Truncate>}
        {e.from ? <Truncate className="min-w-0 text-muted-foreground text-xs">{e.from}</Truncate> : null}
      </span>
      {e.kind === "file" && e.bytes != null ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatBytes(e.bytes)}</span> : null}
    </button>
  );
}

/** What the last import couldn't bring in: locked items (with why they wait) first, then the rest. */
function Skipped({ notes }: { notes: string[] }) {
  const g = skippedGroups(notes);
  return (
    <section className="flex flex-col gap-2" data-testid="course-skipped">
      <h3 className="px-1 text-muted-foreground text-xs">Not imported last time</h3>
      <Card>
        {g.locked.length ? (
          <div className="flex flex-col gap-1.5 px-5 py-4">
            <p className="flex items-center gap-2 text-sm">
              <Icon icon={icons.locked} className="size-4 text-muted-foreground" />
              {plural(g.locked.length, "item")} locked on the course site
            </p>
            <p className="text-muted-foreground text-sm">They’re imported once the course opens them.</p>
            <ul className="flex flex-col gap-0.5 pt-1">
              {g.locked.map((n, i) => (
                <li key={i} className="truncate text-muted-foreground text-xs">
                  {n.what}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {g.other.length ? (
          <ul className={cn("flex flex-col gap-1.5 px-5 py-4", g.locked.length && "border-t")}>
            {g.other.map((n, i) => (
              <li key={i} className="flex min-w-0 items-start gap-2 text-sm">
                <Icon icon={icons.error} className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {n.what}
                  {n.why ? <span className="text-muted-foreground">: {n.why}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
    </section>
  );
}

/** Whether the course's site is signed in, and this course's import as it runs. */
function SiteState({ course }: { course: CourseInfo }) {
  const conn = useCourses((s) => s.connections.data?.find((c) => c.id === course.connection));
  const run = useCourses((s) => (s.run?.connection === course.connection ? s.run : null));
  const mine = run?.courses.find((c) => c.id === course.courseId);
  if (!conn) return null;
  const active = run?.status === "running" && mine && !mine.result && !mine.failed;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="course-site-state">
      <Badge variant={conn.signedIn ? "success" : "warning"} size="lg">
        {conn.signedIn ? "Signed in" : "Signed out"}
      </Badge>
      {!conn.signedIn ? <span className="text-muted-foreground">Sign in again to import</span> : null}
      {active ? (
        <span className="flex min-w-0 items-center gap-1.5 text-foreground">
          <Spinner size="xs" />
          <span className="truncate tabular-nums">{mine.step ? stepText(mine) : "Waiting to import"}</span>
        </span>
      ) : mine?.result && run?.status !== "running" ? (
        <Badge variant="info" size="lg">
          Just imported
        </Badge>
      ) : null}
    </div>
  );
}
