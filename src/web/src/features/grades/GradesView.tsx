import { ArrowClockwise, ArrowCounterClockwise, CaretDown, CaretUp, ChartBar, ChatCenteredText, MagnifyingGlass, TrendDown, TrendUp, Warning } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { AutoHeight, EASE } from "@/features/study/components/motion";
import { JobBar } from "@/features/study/components/parts";
import { useLoad } from "@/features/study/use-load";
import { useDelayed } from "@/hooks/use-delayed";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { lmsGrades, lmsGradesRefresh } from "./api";
import { courseHead, dueSoon, dueWords, levers, missingOrLate, recentlyGraded, type Ref, type Sort, type SortKey, type Status, tableRows } from "./lib/focus";
import { newlyGraded, scoreText } from "./lib/newly";
import { calcItems, loadSeen, saveSeen, weightText } from "./lib/table";
import type { CourseGradeView, GradeItem } from "./lib/types";
import { calculate, FINAL, letterFor, pct, whatIf } from "./lib/what-if";

type Refresh = { done: number; total: number; course?: string };
const courseId = (c: CourseGradeView) => `grades-${c.connection}-${c.courseId}`.replace(/[^\w-]/g, "_");

/**
 * Grades with what matters on top: each course's grade and how it moved;
 * then what's due soon, missing or late, graded since the last look, and
 * the open work worth the most of a grade; then every course's full table,
 * collapsible, sortable and filterable, with sticky course headers and
 * scores to try on what isn't graded yet.
 */
export function GradesView({ space }: { space: SpaceView }) {
  const grades = useLoad(() => lmsGrades(space.id), [space.id]);
  const skeleton = useDelayed(grades.loading && !grades.data);
  const [seen] = useState(() => loadSeen(space.id));
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const [refreshed, setRefreshed] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const latest = useRef<CourseGradeView[] | undefined>(undefined);
  latest.current = grades.data;
  const [now] = useState(() => Date.now());

  // What was graded since the last visit (or, on a first visit, by a refresh); the visit counts as seen when the page closes.
  const [first, setFirst] = useState<CourseGradeView[] | null>(null);
  if (!seen && !first && grades.data) setFirst(grades.data);
  const baseline = seen ?? first;
  const fresh = useMemo(() => {
    if (!baseline || !grades.data) return new Set<GradeItem>();
    return new Set(newlyGraded(baseline, grades.data).map((n) => n.item));
  }, [baseline, grades.data]);
  useEffect(() => () => void (latest.current && saveSeen(space.id, latest.current)), [space.id]);

  const data = grades.data;
  const updated = data?.length ? Math.max(...data.map((c) => c.updated)) : null;
  const withItems = useMemo(() => (data ?? []).filter((c) => c.items.length), [data]);

  const runRefresh = async () => {
    if (!data?.length) return;
    setRefreshError(null);
    setRefreshed(null);
    const connections = [...new Set(data.map((c) => c.connection))];
    const total = data.length;
    let done = 0;
    setRefresh({ done: 0, total });
    let failed: string | null = null;
    for (const connection of connections) {
      const end = await lmsGradesRefresh(space.id, connection, (e) => {
        if (e.type === "progress") setRefresh({ done: done + e.done, total, course: data.find((c) => c.courseId === e.course)?.course });
        else if (e.type === "course") grades.setData((d) => d?.map((c) => (c.connection === e.grades.connection && c.courseId === e.grades.courseId ? e.grades : c)));
        else if (e.type === "error") failed = e.message;
      });
      done += data.filter((c) => c.connection === connection).length;
      if (end.kind === "rejected") failed = cleanMessage(end.error);
      if (failed) break;
    }
    setRefresh(null);
    if (failed) setRefreshError(failed);
    else setRefreshed(Date.now());
  };

  useEffect(() => {
    if (!refreshed) return;
    const t = setTimeout(() => setRefreshed(null), 2400);
    return () => clearTimeout(t);
  }, [refreshed]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title="Grades"
        actions={
          data?.length ? (
            <>
              <AnimatePresence mode="popLayout" initial={false}>
                {refreshed ? (
                  <motion.span key="ok" initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mr-1 text-2xs text-success-foreground">
                    Up to date
                  </motion.span>
                ) : updated && !refresh ? (
                  <motion.span key="when" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mr-1 text-2xs text-muted-foreground tabular-nums max-md:hidden">
                    Updated {relativeTime(updated).toLowerCase()}
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <Button size="xs" variant="outline" disabled={!!refresh} onClick={() => void runRefresh()}>
                {refresh ? <Spinner size="xs" /> : <ArrowClockwise weight="light" />}
                {refresh ? "Refreshing…" : "Refresh"}
              </Button>
            </>
          ) : null
        }
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto" data-testid="grades-scroll">
        <AnimatePresence initial={false}>
          {refresh ? (
            <motion.div
              key="refresh"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.18, ease: EASE }}
              className="sticky top-0 z-20 overflow-hidden border-b bg-background/95 backdrop-blur-sm"
            >
              <div className="relative">
                <JobBar value={refresh.total ? refresh.done / refresh.total : 0} />
                <div className="mx-auto flex h-8 max-w-5xl items-center gap-3 px-4 text-muted-foreground text-xs">
                  <span className="min-w-0 flex-1 truncate">{refresh.course ? `Reading grades for ${refresh.course}…` : "Reading your course sites…"}</span>
                  <span className="shrink-0 tabular-nums">
                    {Math.min(refresh.done, refresh.total)}/{refresh.total}
                  </span>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-5">
          {grades.error ? <SurfaceError title="Couldn’t load your grades" message={cleanMessage(grades.error)} onRetry={grades.reload} /> : null}
          {refreshError ? <RefreshError message={refreshError} onRetry={() => void runRefresh()} onDismiss={() => setRefreshError(null)} /> : null}
          {skeleton ? <GradesSkeleton /> : null}
          {data && !data.length ? (
            <Empty className="min-h-[60vh]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChartBar weight="light" />
                </EmptyMedia>
                <EmptyTitle>No grades here yet</EmptyTitle>
                <EmptyDescription>Connect your course site and import your courses to see their grades here.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button size="sm" onClick={() => useNav.getState().setView("courses")}>
                  Open courses
                </Button>
              </EmptyContent>
            </Empty>
          ) : null}
          {data?.length ? (
            <>
              <CourseStrip courses={data} refreshing={refresh?.course} />
              {withItems.length ? <Attention courses={withItems} fresh={fresh} now={now} /> : null}
              <AllTables courses={data} fresh={fresh} now={now} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RefreshError({ message, onRetry, onDismiss }: { message: string; onRetry: () => void; onDismiss: () => void }) {
  const signedOut = /signed ?out|sign in again/i.test(message);
  return (
    <SurfaceError
      title={signedOut ? "Your course site signed you out" : "Couldn’t refresh your grades"}
      message={signedOut ? "Sign in again from Courses, then refresh. The grades below are from the last time they were read." : `${message} The grades below are from the last time they were read.`}
      actions={signedOut ? [{ label: "Open courses", onClick: () => useNav.getState().setView("courses"), primary: true }, { label: "Dismiss", onClick: onDismiss }] : [{ label: "Dismiss", onClick: onDismiss }]}
      onRetry={signedOut ? undefined : onRetry}
    />
  );
}

const jump = (c: CourseGradeView) => document.getElementById(courseId(c))?.scrollIntoView({ behavior: "smooth", block: "start" });

// ---- Each course at a glance ----

function CourseStrip({ courses, refreshing }: { courses: CourseGradeView[]; refreshing?: string }) {
  return (
    <section aria-label="Courses" className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2" data-testid="grades-courses">
      {courses.map((c) => {
        const h = courseHead(c);
        const up = h.trend && h.trend.delta > 0.05;
        const down = h.trend && h.trend.delta < -0.05;
        return (
          <button
            key={courseId(c)}
            type="button"
            onClick={() => jump(c)}
            className="group relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-xl border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <Truncate className="min-w-0 flex-1 font-medium text-xs">{c.course}</Truncate>
              {refreshing === c.course ? <Spinner size="xs" className="text-muted-foreground" /> : null}
            </span>
            {h.percent != null ? (
              <span className="flex items-baseline gap-1.5 tabular-nums">
                <span className="font-semibold text-xl tracking-tight">{pct(h.percent)}</span>
                {h.letter ? <span className="font-medium text-muted-foreground text-xs">{h.letter}</span> : null}
                {h.trend && (up || down) ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className={cn("ml-auto flex items-center gap-0.5 text-xs", up ? "text-success-foreground" : "text-error-foreground")} />}>
                      {up ? <TrendUp weight="bold" className="size-3.5" /> : <TrendDown weight="bold" className="size-3.5" />}
                      {`${up ? "+" : "−"}${Math.abs(h.trend.delta).toFixed(1)}`}
                    </TooltipTrigger>
                    <TooltipPopup>Since {h.trend.since} was graded</TooltipPopup>
                  </Tooltip>
                ) : null}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">{c.note ? "No grades shown" : "Nothing graded yet"}</span>
            )}
            <span className="text-2xs text-muted-foreground tabular-nums">
              {h.graded} graded · {h.open} to go
            </span>
          </button>
        );
      })}
    </section>
  );
}

// ---- What needs attention ----

function Attention({ courses, fresh, now }: { courses: CourseGradeView[]; fresh: Set<GradeItem>; now: number }) {
  const due = dueSoon(courses, now);
  const missing = missingOrLate(courses);
  const recent = recentlyGraded(courses, fresh, now);
  const lever = levers(courses);
  const many = courses.length > 1;
  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="Needs attention" data-testid="grades-attention">
      <Panel title="Due soon" count={due.length} empty="Nothing due in the next week." testId="grades-due">
        {due.slice(0, 6).map((r) => (
          <Line key={`${courseId(r.course)}${r.key}`} r={r} many={many} right={<span className={cn("tabular-nums", r.due! - now < 86_400_000 * 1.5 && "font-medium text-warning-foreground")}>{dueWords(r.due, now)}</span>} />
        ))}
      </Panel>
      <Panel title="Missing or late" count={missing.length} empty="Nothing missing or late." tone={missing.length ? "warning" : undefined} testId="grades-missing">
        {missing.slice(0, 6).map((r) => (
          <Line
            key={`${courseId(r.course)}${r.key}`}
            r={r}
            many={many}
            right={
              <Badge variant={r.item.missing ? "error" : "warning"} size="sm">
                {r.item.missing ? "Missing" : "Late"}
              </Badge>
            }
          />
        ))}
      </Panel>
      <Panel title="Recently graded" count={recent.length} empty="Nothing graded in the last two weeks." testId="grades-recent">
        {recent.slice(0, 6).map((r) => (
          <Line
            key={`${courseId(r.course)}${r.key}`}
            r={r}
            many={many}
            badge={fresh.has(r.item) ? <Badge variant="info" size="sm">New</Badge> : null}
            right={<span className="tabular-nums">{scoreText(r.item)}</span>}
          />
        ))}
      </Panel>
      <Panel title="Biggest levers" hint="Open work worth the most of a grade" count={lever.length} empty="Everything is graded." testId="grades-levers">
        {lever.map((l) => (
          <Line
            key={`${courseId(l.course)}${l.key}`}
            r={l}
            many={many}
            sub={l.next ? `${pct(l.next.percent)} here for ${l.next.letter}` : undefined}
            right={<span className="tabular-nums">{weightText(l.weight)}</span>}
          />
        ))}
      </Panel>
    </section>
  );
}

function Panel({ title, hint, count, empty, tone, children, testId }: { title: string; hint?: string; count: number; empty: string; tone?: "warning"; children: ReactNode; testId?: string }) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border bg-card" data-testid={testId}>
      <div className="flex h-8 items-center gap-1.5 border-b px-3">
        {tone === "warning" ? <Warning weight="fill" className="size-3.5 text-warning" /> : null}
        <h2 className="font-medium text-xs">{title}</h2>
        <span className="text-2xs text-muted-foreground tabular-nums">{count || ""}</span>
        {hint ? <span className="ml-auto truncate text-2xs text-subtle-foreground max-sm:hidden">{hint}</span> : null}
      </div>
      <div className="flex flex-col py-1">{count ? children : <p className="px-3 py-2 text-muted-foreground text-xs">{empty}</p>}</div>
    </div>
  );
}

function Line({ r, many, right, badge, sub }: { r: Ref; many: boolean; right: ReactNode; badge?: ReactNode; sub?: string }) {
  return (
    <button type="button" onClick={() => jump(r.course)} className="flex min-h-8 w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-sm transition-colors hover:bg-accent/50">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <Truncate className="min-w-0">{r.item.title}</Truncate>
          {badge}
        </span>
        {many || sub ? <span className="truncate text-2xs text-muted-foreground">{[many ? r.course.course : null, sub].filter(Boolean).join(" · ")}</span> : null}
      </span>
      <span className="shrink-0 text-muted-foreground text-xs">{right}</span>
    </button>
  );
}

// ---- Full tables ----

const STATUS: { value: Status; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "graded", label: "Graded" },
  { value: "attention", label: "Missing / late" },
];

function AllTables({ courses, fresh, now }: { courses: CourseGradeView[]; fresh: Set<GradeItem>; now: number }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [sort, setSort] = useState<Sort>({ key: "due", dir: 1 });
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const allClosed = courses.every((c) => closed[courseId(c)]);
  return (
    <section className="flex flex-col gap-2" aria-label="All grades">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium text-sm">All grades</h2>
        <div className="relative w-48 max-sm:w-full">
          <MagnifyingGlass weight="light" className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 z-10 size-3.5 text-muted-foreground" />
          <Input size="compact" value={query} placeholder="Filter assignments" aria-label="Filter assignments" className="*:data-[slot=input]:ps-7" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <ToggleGroup aria-label="Show" value={[status]} onValueChange={(v: unknown[]) => v[0] && setStatus(v[0] as Status)}>
          {STATUS.map((s) => (
            <ToggleGroupItem key={s.value} value={s.value} className="text-xs">
              {s.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button size="xs" variant="ghost-muted" onClick={() => setClosed(allClosed ? {} : Object.fromEntries(courses.map((c) => [courseId(c), true])))}>
          {allClosed ? "Expand all" : "Collapse all"}
        </Button>
      </div>
      <div className="flex flex-col gap-3">
        {courses.map((c) => (
          <CourseTable
            key={courseId(c)}
            course={c}
            fresh={fresh}
            now={now}
            query={query}
            status={status}
            sort={sort}
            onSort={(key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === "title" || key === "due" ? 1 : -1 }))}
            open={!closed[courseId(c)]}
            onToggle={() => setClosed((m) => ({ ...m, [courseId(c)]: !m[courseId(c)] }))}
          />
        ))}
      </div>
    </section>
  );
}

function CourseTable({
  course,
  fresh,
  now,
  query,
  status,
  sort,
  onSort,
  open,
  onToggle,
}: {
  course: CourseGradeView;
  fresh: Set<GradeItem>;
  now: number;
  query: string;
  status: Status;
  sort: Sort;
  onSort: (k: SortKey) => void;
  open: boolean;
  onToggle: () => void;
}) {
  const [scores, setScores] = useState<Record<string, string>>({});
  const input = useMemo(() => ({ groups: course.groups, items: calcItems(course) }), [course]);
  const r = useMemo(() => whatIf(input, { scores, finalWeight: "", finalScore: "", target: "A", on: FINAL }), [input, scores]);
  const h = courseHead(course);
  const rows = useMemo(() => tableRows(course, { query, status, sort }), [course, query, status, sort]);
  const edited = Object.values(scores).some((s) => s.trim());
  const id = courseId(course);

  return (
    <section id={id} className="scroll-mt-2 rounded-xl border bg-card" data-testid="grades-course">
      <div className="sticky top-0 z-10 flex items-center gap-2 rounded-t-xl border-b bg-card/95 px-2 py-1.5 backdrop-blur-sm">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/50">
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: 0.15, ease: EASE }} className="shrink-0 text-muted-foreground">
            <CaretDown weight="bold" className="size-3" />
          </motion.span>
          <Truncate className="min-w-0 font-medium text-sm">{course.course}</Truncate>
          <span className="shrink-0 text-2xs text-muted-foreground tabular-nums max-sm:hidden">{plural(course.items.length, "item")}</span>
        </button>
        {edited ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setScores({})}>
            <ArrowCounterClockwise weight="light" />
            Reset
          </Button>
        ) : null}
        <div className="flex shrink-0 items-baseline gap-1.5 pr-2 tabular-nums">
          {r.changed && r.projected != null ? (
            <Tooltip>
              <TooltipTrigger render={<span className="rounded-md bg-primary/8 px-1.5 font-semibold text-primary text-sm" />}>
                {pct(r.projected)} <span className="font-medium text-xs">{letterFor(r.projected)}</span>
              </TooltipTrigger>
              <TooltipPopup>With the scores you tried; now {h.percent != null ? pct(h.percent) : "–"}</TooltipPopup>
            </Tooltip>
          ) : (
            <>
              <span className="font-semibold text-sm">{h.percent != null ? pct(h.percent) : "–"}</span>
              {h.letter ? <span className="font-medium text-muted-foreground text-xs">{h.letter}</span> : null}
            </>
          )}
        </div>
      </div>
      <AutoHeight>
        {open ? (
          course.note && !course.items.length ? (
            <p className="px-4 py-3 text-muted-foreground text-xs [overflow-wrap:anywhere]">{course.note}</p>
          ) : !course.items.length ? (
            <p className="px-4 py-3 text-muted-foreground text-xs">Nothing graded or assigned yet.</p>
          ) : (
            <>
              <Groups course={course} />
              <div className="overflow-x-auto">
                <table className="w-full min-w-xl text-sm">
                  <thead>
                    <tr className="text-2xs text-muted-foreground">
                      <Th label="Assignment" k="title" sort={sort} onSort={onSort} className="pl-4 text-left" />
                      <th className="h-7 w-36 pl-3 text-left font-medium">Category</th>
                      <Th label="Due" k="due" sort={sort} onSort={onSort} className="w-20 pl-3 text-left" />
                      <Th label="Score" k="score" sort={sort} onSort={onSort} className="w-28 pl-3 text-right" />
                      <Th label="Weight" k="weight" sort={sort} onSort={onSort} className="w-20 pr-4 pl-3 text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length ? (
                      rows.map(({ key, item, weight }) => {
                        const editable = !item.graded && !item.excused;
                        const typed = scores[key] ?? "";
                        const bad = r.bad.includes(key);
                        return (
                          <tr key={key} className={cn("border-t", item.excused && "text-muted-foreground")}>
                            <td className="h-8 max-w-0 pl-4">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <Truncate className="min-w-0">{item.title}</Truncate>
                                {item.missing ? <Badge variant="error" size="sm">Missing</Badge> : null}
                                {item.late ? <Badge variant="warning" size="sm">Late</Badge> : null}
                                {item.excused ? <Badge variant="secondary" size="sm">Excused</Badge> : null}
                                {fresh.has(item) ? <Badge variant="info" size="sm">New</Badge> : null}
                                {item.comments.length ? <Comments comments={item.comments} /> : null}
                              </div>
                            </td>
                            <td className="h-8 max-w-0 pl-3">
                              <Truncate className="text-muted-foreground text-xs">{item.group ?? "–"}</Truncate>
                            </td>
                            <td className="h-8 pl-3 text-muted-foreground text-xs tabular-nums">{dueWords(item.due ? Date.parse(item.due) : null, now) || "–"}</td>
                            <td className="h-8 pl-3 text-right tabular-nums">
                              {editable ? (
                                <span className="inline-flex items-center justify-end gap-1">
                                  <Input
                                    size="compact"
                                    aria-label={`Try a score for ${item.title}`}
                                    aria-invalid={bad || undefined}
                                    inputMode="decimal"
                                    placeholder="–"
                                    value={typed}
                                    onChange={(e) => setScores((s) => ({ ...s, [key]: e.target.value }))}
                                    className={cn("w-14 [&_input]:text-right [&_input]:tabular-nums", typed.trim() && !bad && "border-primary/40 bg-primary/8 text-primary")}
                                  />
                                  <span className="text-muted-foreground text-xs">{item.possible ? `/${item.possible}` : "%"}</span>
                                </span>
                              ) : (
                                <span className={cn(item.missing && "text-error-foreground")}>{scoreText(item)}</span>
                              )}
                            </td>
                            <td className="h-8 pr-4 pl-3 text-right text-muted-foreground text-xs tabular-nums">{weightText(weight)}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr className="border-t">
                        <td colSpan={5} className="h-9 px-4 text-muted-foreground text-xs">
                          Nothing here matches.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="border-t bg-muted/40 font-medium">
                      <td className="h-8 pl-4 text-xs" colSpan={3}>
                        Course total
                      </td>
                      <td className="h-8 pl-3 text-right tabular-nums">
                        {r.changed && r.projected != null ? <span className="text-primary">{pct(r.projected)}</span> : h.percent != null ? pct(h.percent) : "–"}
                      </td>
                      <td className="h-8 pr-4 pl-3 text-right text-muted-foreground text-xs tabular-nums">100%</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )
        ) : null}
      </AutoHeight>
    </section>
  );
}

/** The course's categories with their weights and standing, in one line. */
function Groups({ course }: { course: CourseGradeView }) {
  const groups = useMemo(() => calculate({ groups: course.groups, items: calcItems(course) }).groups.filter((g) => g.counted > 0 || g.weight), [course]);
  if (!groups.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 border-b px-4 py-1.5 text-2xs text-muted-foreground tabular-nums">
      {groups.map((g) => (
        <span key={g.name} className="whitespace-nowrap">
          {g.name}
          {g.weight ? <span className="text-subtle-foreground"> {g.weight}%</span> : null}
          <span className="text-foreground/80"> {g.percent != null ? pct(g.percent) : "–"}</span>
        </span>
      ))}
    </div>
  );
}

function Th({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k;
  return (
    <th className={cn("h-7 font-medium", className)} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(k)} className={cn("inline-flex items-center gap-0.5 hover:text-foreground", on && "text-foreground")}>
        {label}
        {on ? sort.dir === 1 ? <CaretUp weight="bold" className="size-2.5" /> : <CaretDown weight="bold" className="size-2.5" /> : null}
      </button>
    </th>
  );
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function Comments({ comments }: { comments: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" aria-label={`${comments.length} comments`} />}>
        <ChatCenteredText weight="light" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        <div className="flex flex-col gap-1">
          {comments.map((c, i) => (
            <p key={i} className="[overflow-wrap:anywhere]">
              {c}
            </p>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function GradesSkeleton() {
  return (
    <div className="flex flex-col gap-6 motion-safe:animate-skeleton" aria-hidden>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
        {[0, 1, 2].map((k) => (
          <div key={k} className="flex flex-col gap-2 rounded-xl border px-3 py-3">
            <Skeleton className="h-2 w-24 animate-none" />
            <Skeleton className="h-4 w-16 animate-none" />
            <Skeleton className="h-2 w-20 animate-none" />
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {[3, 2, 3, 2].map((n, k) => (
          <div key={k} className="rounded-xl border">
            <div className="flex h-8 items-center border-b px-3">
              <Skeleton className="h-2 w-20 animate-none" />
            </div>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="flex h-8 items-center gap-3 px-3">
                <Skeleton className="h-2.5 animate-none" style={{ width: ["46%", "34%", "52%"][i] }} />
                <span className="flex-1" />
                <Skeleton className="h-2 w-10 animate-none" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
