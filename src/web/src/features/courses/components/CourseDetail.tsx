import { BookOpenText, Check, ClipboardText, FileText, Lock, MagnifyingGlass, Megaphone, Stack, WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Toggle, ToggleGroup } from "@/components/ui/toggle-group";
import { FileIcon } from "@/features/viewer/FileIcon";
import { cn } from "@/lib/utils";
import { useDelayed } from "@/hooks/use-delayed";
import { lmsCourseContent } from "../api";
import { fileGroups, skippedGroups } from "../lib/content";
import { stepText } from "../lib/import-run";
import { formatBytes, plural, whenText } from "../lib/sites";
import { COURSE_PARTS, type CourseContent, type CourseContentEntry, type CourseInfo } from "../lib/types";
import { partsOf, useCourses } from "../store";

const SECTIONS: { kind: CourseContentEntry["kind"][]; label: string; icon: ReactNode }[] = [
  { kind: ["overview", "page"], label: "Pages", icon: <BookOpenText weight="light" className="size-4 shrink-0 text-muted-foreground" /> },
  { kind: ["module"], label: "Modules", icon: <Stack weight="light" className="size-4 shrink-0 text-muted-foreground" /> },
  { kind: ["assignment"], label: "Assignments", icon: <ClipboardText weight="light" className="size-4 shrink-0 text-muted-foreground" /> },
];

/** The parts a space may see of one course, as compact toggles. */
export function PartToggles({ space, course }: { space: string; course: string }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course));
  const setParts = useCourses((s) => s.setParts);
  return (
    <ToggleGroup
      multiple
      variant="outline"
      size="xs"
      value={parts}
      onValueChange={(v) => void setParts(space, course, COURSE_PARTS.map((p) => p.part).filter((p) => (v as string[]).includes(p)))}
      className="flex-wrap gap-1.5"
      aria-label="Parts this space can see"
    >
      {COURSE_PARTS.map((p) => (
        <Toggle key={p.part} value={p.part} className="group/part h-6 gap-1 rounded-md px-2 font-normal text-muted-foreground text-xs data-pressed:border-primary/40 data-pressed:bg-primary/8 data-pressed:text-foreground dark:data-pressed:bg-primary/16">
          <Check weight="bold" className="hidden size-3 text-primary group-data-pressed/part:block" />
          {p.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

/** One course: what this space sees of it, and its content to open in the viewer. */
export function CourseDetail({ space, course }: { space: string; course: CourseInfo }) {
  const parts = useCourses((s) => partsOf(s.access.data, space, course.key));
  const openFile = useNav((s) => s.openFile);
  const viewing = useNav((s) => s.viewer);
  const [content, setContent] = useState<CourseContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState("");
  const partsKey = parts.join(",");
  const showSkeleton = useDelayed(!content && !error && parts.length > 0);

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

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = content?.entries ?? [];
    return q ? all.filter((e) => e.title.toLowerCase().includes(q) || e.path.toLowerCase().includes(q)) : all;
  }, [content, query]);

  const meta = [course.code, course.term, content?.updated ? `Updated ${whenText(content.updated)}` : null].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-6 px-4 py-6">
      <div className="min-w-0 space-y-0.5">
        <h2 className="min-w-0 font-semibold text-lg tracking-[-0.01em]">
          <Truncate>{course.name}</Truncate>
        </h2>
        {meta ? <p className="truncate text-muted-foreground text-xs">{meta}</p> : null}
        <SiteState course={course} />
      </div>

      <section className="space-y-2">
        <h3 className="font-medium text-2xs text-muted-foreground">This space can see</h3>
        <PartToggles space={space} course={course.key} />
      </section>

      <section className="space-y-2">
        <div className="flex h-7 items-center gap-2">
          <h3 className="flex-1 font-medium text-2xs text-muted-foreground">
            Content{content && parts.length ? <span className="ml-1.5 tabular-nums">{content.entries.length}</span> : null}
          </h3>
          {content && content.entries.length > 12 && parts.length ? (
            <div className="relative w-48">
              <MagnifyingGlass weight="light" className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 text-muted-foreground" />
              <Input size="compact" value={query} placeholder="Filter" className="*:data-[slot=input]:ps-7" onChange={(e) => setQuery(e.target.value)} />
            </div>
          ) : null}
        </div>

        {parts.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">This space can’t see this course. Turn on a part above to browse it here.</div>
        ) : error ? (
          <SurfaceError title="Couldn’t load this course" message={error} onRetry={() => setTick((n) => n + 1)} />
        ) : !content ? (
          showSkeleton ? (
            <div className="rounded-xl border p-1">
              <SkeletonRows count={6} withIcon />
            </div>
          ) : null
        ) : content.entries.length === 0 ? (
          <div className="rounded-xl border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">Nothing was imported for the parts this space can see.</div>
        ) : entries.length === 0 ? (
          <p className="px-1 py-3 text-muted-foreground text-sm">Nothing matches “{query.trim()}”.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {fileGroups(entries).map((g) => (
              <EntryGroup key={g.id} label={g.label} icon={g.id === "attached" ? <Megaphone weight="light" className="size-3.5" /> : null} count={g.entries.length} testId={g.id === "attached" ? "course-attached" : undefined}>
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
          </div>
        )}
      </section>

      {content?.skipped?.length && parts.length ? <Skipped notes={content.skipped} /> : null}
    </div>
  );
}

function EntryGroup({ label, icon, count, children, testId }: { label: string; icon?: ReactNode; count: number; children: ReactNode; testId?: string }) {
  return (
    <div className="space-y-1" data-testid={testId}>
      <p className="flex items-center gap-1.5 px-1 text-2xs text-muted-foreground">
        {icon}
        {label} <span className="tabular-nums">{count}</span>
      </p>
      <div className="flex flex-col gap-0.5 rounded-xl border p-1">{children}</div>
    </div>
  );
}

function EntryRow({ entry: e, icon, selected, onOpen }: { entry: CourseContentEntry; icon?: ReactNode; selected: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className={cn("flex min-h-7 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent", selected && "bg-row-selected")}>
      {e.kind === "file" ? <FileIcon name={e.title} /> : (icon ?? <FileText weight="light" className="size-4 shrink-0 text-muted-foreground" />)}
      <span className="flex min-w-0 flex-1 flex-col">
        {e.kind === "file" ? <MiddleTruncate value={e.title} className="min-w-0 [&>span]:whitespace-pre" /> : <Truncate className="min-w-0">{e.title}</Truncate>}
        {e.from ? <Truncate className="min-w-0 text-2xs text-muted-foreground">{e.from}</Truncate> : null}
      </span>
      {e.kind === "file" && e.bytes != null ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{formatBytes(e.bytes)}</span> : null}
    </button>
  );
}

/** What the last import couldn't bring in: locked items (with why they wait) first, then the rest. */
function Skipped({ notes }: { notes: string[] }) {
  const g = skippedGroups(notes);
  return (
    <section className="space-y-2" data-testid="course-skipped">
      <h3 className="font-medium text-2xs text-muted-foreground">Not imported last time</h3>
      <div className="flex flex-col rounded-xl border">
        {g.locked.length ? (
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-sm">
              <Lock weight="light" className="size-4 text-muted-foreground" />
              {plural(g.locked.length, "item")} locked on the course site
            </p>
            <p className="text-muted-foreground text-xs">Teachers lock files and pages until a date or until earlier work is done. They come in with the next import once they open.</p>
            <ul className="flex flex-col gap-0.5 pt-0.5">
              {g.locked.map((n, i) => (
                <li key={i} className="truncate text-xs">
                  {n.what}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {g.other.length ? (
          <ul className={cn("flex flex-col gap-1 px-3 py-2.5", g.locked.length && "border-t")}>
            {g.other.map((n, i) => (
              <li key={i} className="flex min-w-0 items-start gap-1.5 text-xs">
                <WarningCircle weight="light" className="mt-0.5 size-3.5 shrink-0 text-warning-foreground" />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {n.what}
                  {n.why ? <span className="text-muted-foreground">: {n.why}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
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
    <div className="flex items-center gap-2 pt-1 text-xs" data-testid="course-site-state">
      <span className={cn("size-1.5 shrink-0 rounded-full", conn.signedIn ? "bg-success" : "bg-warning")} />
      <span className="text-muted-foreground">{conn.signedIn ? "Signed in" : "Signed out: sign in from Courses to import again"}</span>
      {active ? (
        <>
          <span className="text-subtle-foreground">·</span>
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            <Spinner size="xs" />
            <span className="truncate tabular-nums">{mine.step ? stepText(mine) : "Waiting to import"}</span>
          </span>
        </>
      ) : mine?.result && run?.status !== "running" ? (
        <>
          <span className="text-subtle-foreground">·</span>
          <span className="text-success-foreground">Just imported</span>
        </>
      ) : null}
    </div>
  );
}
