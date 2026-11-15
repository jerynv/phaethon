import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNav } from "@/app/store";
import { ArtCanvas, paletteFor } from "@/components/art";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Spinner } from "@/components/ui/spinner";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { ToggleRow } from "@/components/ui/toggle-row";
import { FileIcon } from "@/features/viewer/FileIcon";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { lmsCourseContent } from "../api";
import { fileGroups, skippedGroups } from "../lib/content";
import { stepText } from "../lib/import-run";
import { connectionName, formatBytes, plural, whenText } from "../lib/sites";
import { COURSE_PARTS, type CourseContent, type CourseContentEntry, type CourseInfo, type CoursePart, type LmsConnection } from "../lib/types";
import { partsOf, useCourses } from "../store";

export type DetailTab = "overview" | "files" | "settings";

const SECTIONS: { kind: CourseContentEntry["kind"][]; label: string; icon: IconData }[] = [
  { kind: ["overview", "page"], label: "Pages", icon: icons.read },
  { kind: ["module"], label: "Modules", icon: icons.deck },
  { kind: ["assignment"], label: "Assignments", icon: icons.quiz },
];

const PART_HINTS: Record<CoursePart, string> = {
  overview: "The course’s home page",
  syllabus: "The syllabus and course policies",
  assignments: "Assignments, instructions and due dates",
  announcements: "Announcements and the files they attach",
  files: "Lecture notes, readings and other files",
  grades: "Scores and the grade book",
};

type SiteActions = { onImport: (c: LmsConnection) => void; onSignIn: (c: LmsConnection) => void; onDisconnect: (c: LmsConnection) => void; busy: boolean };

/**
 * One course (refs 7274, 02a1): a breadcrumb row with its site's actions,
 * then the tab chosen on the left. Overview: an art card with the course's
 * numbers. Files: its content in grouped lists to open in the viewer.
 * Settings: what this space sees of it.
 */
export function CourseDetail({
  space,
  course,
  tab,
  connection,
  run,
  onImport,
  onSignIn,
  onDisconnect,
  busy,
}: { space: string; course: CourseInfo; tab: DetailTab; connection: LmsConnection | null; run: ReactNode } & SiteActions) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const partsKey = parts.join(",");
  const reduce = useReducedMotion();

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

  const state = { content: parts.length ? content : null, error, retry: () => setTick((n) => n + 1), hidden: parts.length === 0 };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-2 border-b px-6">
        <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-2 text-sm">
          <Icon icon={icons.folder} className="size-4 text-muted-foreground" />
          <Truncate className="min-w-0 max-w-56 shrink text-muted-foreground">{connection ? connectionName(connection) : "Other courses"}</Truncate>
          <Icon icon={icons.chevronRight} className="size-3.5 text-subtle-foreground" />
          <Icon icon={icons.courses} className="size-4 text-muted-foreground" />
          <Truncate className="min-w-0 font-medium">{course.name}</Truncate>
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
        {connection ? (
          <Menu>
            <MenuTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label={`${connectionName(connection)} actions`} />}>
              <Icon icon={icons.more} />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => onSignIn(connection)}>
                <Icon icon={icons.signIn} />
                Sign in again
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" onClick={() => onDisconnect(connection)} disabled={!connection.signedIn}>
                <Icon icon={icons.disconnected} />
                Disconnect
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <motion.div
          key={tab}
          initial={reduce ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="mx-auto flex w-full max-w-(--page-max-width) flex-col gap-6 px-8 pt-8 pb-16"
        >
          {run}
          {tab === "overview" ? <Overview space={space} course={course} {...state} /> : tab === "files" ? <Files space={space} {...state} /> : <Settings space={space} course={course} />}
        </motion.div>
      </div>
    </div>
  );
}

type ContentState = { content: CourseContent | null; error: string | null; retry: () => void; hidden: boolean };

function Overview({ space, course, content, error, retry, hidden }: { space: string; course: CourseInfo } & ContentState) {
  const meta = [course.code, course.term, content?.updated ? `Updated ${whenText(content.updated)}` : null].filter(Boolean).join(" · ");
  const n = (kinds: CourseContentEntry["kind"][]) => (content ? content.entries.filter((e) => kinds.includes(e.kind)).length : "–");
  const bytes = content?.entries.reduce((s, e) => s + (e.bytes ?? 0), 0) ?? 0;
  return (
    <>
      <Card>
        <CardMedia className="h-24">
          <ArtCanvas palette={paletteFor(course.key)} seed={course.key} weave className="absolute inset-0" />
        </CardMedia>
        <CardHeader>
          <CardTitle className="text-xl">
            <Truncate>{course.name}</Truncate>
          </CardTitle>
          {meta ? <CardDescription className="truncate">{meta}</CardDescription> : null}
          <SiteState course={course} />
        </CardHeader>
        <CardContent className="@container">
          {hidden ? (
            <p className="rounded-xl border border-border/70 bg-well px-4 py-3 text-muted-foreground text-sm">This space can’t see this course. Turn on a part in Settings to browse it here.</p>
          ) : error ? (
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
      {content && !hidden ? <Recent space={space} entries={content.entries} /> : null}
      {content?.skipped?.length && !hidden ? <Skipped notes={content.skipped} /> : null}
    </>
  );
}

/** A few of the course's files to open straight away. */
function Recent({ space, entries }: { space: string; entries: CourseContentEntry[] }) {
  const openFile = useNav((s) => s.openFile);
  const viewing = useNav((s) => s.viewer);
  const files = entries.filter((e) => e.kind === "file").slice(0, 5);
  if (!files.length) return null;
  return (
    <EntryGroup label="Files" count={entries.filter((e) => e.kind === "file").length}>
      {files.map((e, i) => (
        <EntryRow key={`${e.path}#${i}`} entry={e} selected={viewing?.space === space && viewing.path === e.path} onOpen={() => openFile(space, e.path)} />
      ))}
    </EntryGroup>
  );
}

function Files({ space, content, error, retry, hidden }: { space: string } & ContentState) {
  const openFile = useNav((s) => s.openFile);
  const viewing = useNav((s) => s.viewer);
  const [query, setQuery] = useState("");
  const showSkeleton = useDelayed(!content && !error && !hidden);
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = content?.entries ?? [];
    return q ? all.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)) : all;
  }, [content, query]);

  if (hidden) return <Quiet>This space can’t see this course. Turn on a part in Settings to browse it here.</Quiet>;
  if (error) return <SurfaceError title="Couldn’t load this course" message={error} onRetry={retry} />;
  if (!content) return showSkeleton ? <div className="rounded-xl border bg-well p-1.5"><SkeletonRows count={6} withIcon /></div> : null;
  if (!content.entries.length) return <Quiet>Nothing was imported for the parts this space can see.</Quiet>;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <h2 className="flex-1 font-medium text-lg tracking-title">
          Content <span className="font-normal text-muted-foreground tabular-nums">{content.entries.length}</span>
        </h2>
        <div className="relative w-56">
          <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input size="sm" value={query} placeholder="Filter" aria-label="Filter content" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>
      {!entries.length ? (
        <p className="px-1 text-muted-foreground text-sm">Nothing matches “{query.trim()}”.</p>
      ) : (
        <>
          {fileGroups(entries).map((g) => (
            <EntryGroup key={g.id} label={g.label} icon={g.id === "attached" ? icons.announcement : undefined} count={g.entries.length} testId={g.id === "attached" ? "course-attached" : undefined}>
              {g.entries.map((e, i) => (
                <EntryRow key={`${e.path}#${i}`} entry={e} selected={viewing?.space === space && viewing.path === e.path} onOpen={() => openFile(space, e.path)} />
              ))}
            </EntryGroup>
          ))}
          {SECTIONS.map((s) => {
            const list = entries.filter((e) => s.kind.includes(e.kind));
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
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">{children}</div>;
}

/** What this space sees of the course: all of it at once, or part by part. */
function Settings({ space, course }: { space: string; course: CourseInfo }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const setParts = useCourses((s) => s.setParts);
  const all = COURSE_PARTS.map((p) => p.part);
  const set = (part: CoursePart, on: boolean) => void setParts(space, course.key, all.filter((p) => (p === part ? on : parts.includes(p))));
  return (
    <Card>
      <CardHeader>
        <CardTitle>What this space sees</CardTitle>
        <CardDescription>Chats, study tools and the plan in this space only use the parts that are on.</CardDescription>
      </CardHeader>
      <CardContent className="gap-0">
        <ToggleRow
          title="Show in this space"
          description={parts.length === 0 ? "Hidden here" : parts.length === all.length ? "Every part" : `${parts.length} of ${all.length} parts`}
          checked={parts.length > 0}
          onCheckedChange={(v) => void setParts(space, course.key, v ? all : [])}
          className="border-b pt-0"
        />
        <h4 className="mt-5 mb-1 text-subtle-foreground text-xs">Parts</h4>
        <div className="flex flex-col divide-y" aria-label="Parts this space can see">
          {COURSE_PARTS.map((p) => (
            <ToggleRow key={p.part} title={p.label} description={PART_HINTS[p.part]} checked={parts.includes(p.part)} onCheckedChange={(v) => set(p.part, v)} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
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
        "flex min-h-10 min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors hover:bg-card hover:shadow-card focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-card shadow-card",
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
            <p className="text-muted-foreground text-sm">Teachers lock files and pages until a date or until earlier work is done. They come in with the next import once they open.</p>
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
    <div className="flex flex-wrap items-center gap-2 pt-2 text-xs" data-testid="course-site-state">
      <Badge variant={conn.signedIn ? "success" : "warning"} size="sm">
        {conn.signedIn ? "Signed in" : "Signed out"}
      </Badge>
      {!conn.signedIn ? <span className="text-muted-foreground">Sign in again to import</span> : null}
      {active ? (
        <span className="flex min-w-0 items-center gap-1.5 text-foreground">
          <Spinner size="xs" />
          <span className="truncate tabular-nums">{mine.step ? stepText(mine) : "Waiting to import"}</span>
        </span>
      ) : mine?.result && run?.status !== "running" ? (
        <Badge variant="info" size="sm">
          Just imported
        </Badge>
      ) : null}
    </div>
  );
}
