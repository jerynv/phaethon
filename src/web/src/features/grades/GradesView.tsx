import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { ArtCanvas } from "@/components/art";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { BarLegend, StackedBar } from "@/components/ui/stacked-bar";
import { StatGrid, StatTile } from "@/components/ui/stat-tile";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { ArtEmpty } from "@/features/courses/components/ArtEmpty";
import { AutoHeight, EASE } from "@/features/study/components/motion";
import { JobBar } from "@/features/study/components/parts";
import { useLoad } from "@/features/study/use-load";
import { useDelayed } from "@/hooks/use-delayed";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { lmsGrades, lmsGradesRefresh } from "./api";
import {
  categories,
  courseHead,
  courseStats,
  dueSoon,
  dueWords,
  gradeSeries,
  levers,
  missingOrLate,
  recentlyGraded,
  type Ref,
  type SeriesPoint,
  type Sort,
  type SortKey,
  type Status,
  tableRows,
} from "./lib/focus";
import { newlyGraded, scoreText } from "./lib/newly";
import { calcItems, loadSeen, saveSeen, weightText } from "./lib/table";
import type { CourseGradeView, GradeItem } from "./lib/types";
import { calculate, FINAL, letterFor, pct, whatIf } from "./lib/what-if";

type Refresh = { done: number; total: number; course?: string };
const courseId = (c: CourseGradeView) => `grades-${c.connection}-${c.courseId}`.replace(/[^\w-]/g, "_");
const ALL = "all";
const DAY = 86_400_000;

/**
 * Grades (docs/UI-REBUILD.md › Screens › Grades; refs 0922, 91b5, b583).
 * All courses: a term card with each course's grade as a stat tile, then
 * what needs attention across them, then every course's table. One course:
 * its grade and numbers, what needs attention in it, how the grade is made
 * up and how it moved, and its table with scores to try on what's open.
 */
export function GradesView({ space }: { space: SpaceView }) {
  const grades = useLoad(() => lmsGrades(space.id), [space.id]);
  const skeleton = useDelayed(grades.loading && !grades.data);
  const [seen] = useState(() => loadSeen(space.id));
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const [refreshed, setRefreshed] = useState<number | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [focus, setFocus] = useState<string>(ALL);
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
  // With one course there is nothing to choose: it is the focus.
  const one = data?.length === 1 ? data[0]! : null;
  const focused = one ?? data?.find((c) => courseId(c) === focus) ?? null;
  const scope = useMemo(() => (focused ? [focused] : (data ?? [])), [focused, data]);
  const withItems = useMemo(() => scope.filter((c) => c.items.length), [scope]);

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
        title={focused && !one ? <Truncate className="font-medium">{focused.course}</Truncate> : undefined}
        actions={
          data?.length ? (
            <>
              <AnimatePresence mode="popLayout" initial={false}>
                {refreshed ? (
                  <motion.span key="ok" initial={{ opacity: 0, y: 2 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mr-1 flex items-center gap-1 text-success-foreground text-xs">
                    <Icon icon={icons.check} className="size-3.5" />
                    Up to date
                  </motion.span>
                ) : updated && !refresh ? (
                  <motion.span key="when" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="mr-1 text-subtle-foreground text-xs tabular-nums max-md:hidden">
                    Updated {relativeTime(updated).toLowerCase()}
                  </motion.span>
                ) : null}
              </AnimatePresence>
              <Button size="sm" variant="outline" disabled={!!refresh} onClick={() => void runRefresh()}>
                {refresh ? <Spinner size="sm" /> : <Icon icon={icons.reload} />}
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
                <div className="mx-auto flex h-9 max-w-(--page-wide-max-width) items-center gap-3 px-8 text-muted-foreground text-xs">
                  <Spinner size="xs" tone="muted" />
                  <span className="min-w-0 flex-1 truncate">{refresh.course ? `Reading grades for ${refresh.course}…` : "Reading your course sites…"}</span>
                  <span className="shrink-0 tabular-nums">
                    {Math.min(refresh.done, refresh.total)}/{refresh.total}
                  </span>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
        <div className="@container/page mx-auto flex min-h-full w-full max-w-(--page-wide-max-width) flex-col gap-8 px-8 pt-10 pb-16 @max-3xl/page:px-6">
          {grades.error ? <SurfaceError title="Couldn’t load your grades" message={cleanMessage(grades.error)} onRetry={grades.reload} /> : null}
          {refreshError ? <RefreshError message={refreshError} onRetry={() => void runRefresh()} onDismiss={() => setRefreshError(null)} /> : null}
          {skeleton ? <GradesSkeleton /> : null}
          {data && !data.length ? (
            <ArtEmpty palette="meadow" seed="grades-empty" title="No grades here yet" description="Connect your course site and import your courses to see their grades here.">
              <Button size="sm" onClick={() => useNav.getState().setView("courses")}>
                Open courses
              </Button>
            </ArtEmpty>
          ) : null}
          {data?.length ? (
            <>
              {!one ? (
                <div className="-mb-3 flex min-w-0 items-center gap-3 overflow-x-auto">
                  <SegmentedControl aria-label="Course" value={focused ? courseId(focused) : ALL} onValueChange={setFocus}>
                    <SegmentedControlItem value={ALL}>All courses</SegmentedControlItem>
                    {data.map((c) => (
                      <SegmentedControlItem key={courseId(c)} value={courseId(c)} className="max-w-48">
                        <span className="truncate">{c.course}</span>
                      </SegmentedControlItem>
                    ))}
                  </SegmentedControl>
                </div>
              ) : null}
              {focused ? <CourseOverview course={focused} now={now} refreshing={refresh?.course === focused.course} /> : <TermOverview courses={data} refreshing={refresh?.course} onPick={(c) => setFocus(courseId(c))} />}
              {withItems.length ? <Attention courses={withItems} fresh={fresh} now={now} /> : null}
              {focused && focused.items.length ? <CourseCharts course={focused} now={now} /> : null}
              {focused && !focused.items.length ? null : <AllTables courses={scope} fresh={fresh} now={now} />}
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
const rounded = (d: number) => Math.round(d * 10) / 10;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/** The one art surface of the page: a meadow strip across the top of the overview card. */
function OverviewMedia({ seed }: { seed: string }) {
  return (
    <CardMedia className="h-20">
      <ArtCanvas palette="meadow" seed={seed} weave className="absolute inset-0" />
    </CardMedia>
  );
}

// ---- All courses at a glance ----

function TermOverview({ courses, refreshing, onPick }: { courses: CourseGradeView[]; refreshing?: string; onPick: (c: CourseGradeView) => void }) {
  const heads = courses.map(courseHead);
  const graded = heads.reduce((n, h) => n + h.graded, 0);
  const open = heads.reduce((n, h) => n + h.open, 0);
  return (
    <Card data-testid="grades-courses">
      <OverviewMedia seed="grades-term" />
      <CardHeader>
        <CardTitle>This term</CardTitle>
        <CardDescription className="tabular-nums">
          {plural(courses.length, "course")} · {graded} graded · {open} still open
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3">
          {heads.map((h) => {
            const c = h.course;
            const moved = h.trend && Math.abs(h.trend.delta) >= 0.05 ? rounded(h.trend.delta) : undefined;
            return (
              <button
                key={courseId(c)}
                type="button"
                onClick={() => onPick(c)}
                className="group min-w-0 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring [&>[data-slot=stat-tile]]:transition-colors hover:[&>[data-slot=stat-tile]]:border-border-strong"
              >
                <StatTile
                  label={
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate">{c.course}</span>
                      {refreshing === c.course ? <Spinner size="xs" tone="muted" /> : null}
                    </span>
                  }
                  value={h.percent != null ? pct(h.percent) : "–"}
                  unit={h.percent != null ? h.letter : undefined}
                  delta={moved}
                  hint={h.percent != null ? `${h.graded} graded · ${h.open} to go` : c.note ? "No grades shown" : "Nothing graded yet"}
                />
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ---- One course at a glance ----

function CourseOverview({ course, now, refreshing }: { course: CourseGradeView; now: number; refreshing: boolean }) {
  const h = courseHead(course);
  const s = courseStats(course, now);
  const up = h.trend && h.trend.delta >= 0.05;
  const down = h.trend && h.trend.delta <= -0.05;
  return (
    <Card data-testid="grades-courses">
      <OverviewMedia seed={courseId(course)} />
      <div className="flex items-start gap-4 px-5 pt-5 pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <CardTitle className="flex min-w-0 items-center gap-2">
            <Truncate className="min-w-0">{course.course}</Truncate>
            {refreshing ? <Spinner size="sm" tone="muted" /> : null}
          </CardTitle>
          <CardDescription className="tabular-nums">
            {s.graded} of {s.total} graded · updated {relativeTime(course.updated).toLowerCase()}
          </CardDescription>
        </div>
        {h.percent != null ? (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <span className="flex items-baseline gap-1.5 tabular-nums">
              <span className="font-medium text-3xl text-foreground tracking-hero">{pct(h.percent)}</span>
              {h.letter ? <span className="text-lg text-muted-foreground">{h.letter}</span> : null}
            </span>
            {h.trend && (up || down) ? (
              <span className={cn("flex items-center gap-1 text-xs tabular-nums", up ? "text-success-foreground" : "text-destructive-foreground")}>
                <Icon icon={up ? icons.trendUp : icons.trendDown} className="size-3.5" />
                {up ? "+" : "−"}
                {Math.abs(h.trend.delta).toFixed(1)} since {h.trend.since}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      <CardContent className="@container">
        {course.note && !course.items.length ? (
          <p className="rounded-xl border border-border/70 bg-well px-4 py-3 text-muted-foreground text-sm [overflow-wrap:anywhere]">{course.note}</p>
        ) : (
          <StatGrid>
            <StatTile label="Graded" value={s.graded} unit={`of ${s.total}`} />
            <StatTile label="Still open" value={s.open} hint={s.dueThisWeek ? `${s.dueThisWeek} due this week` : "Nothing due this week"} />
            <StatTile label="Strongest" value={s.best ? pct(s.best.percent!) : "–"} hint={s.best?.name ?? "No categories yet"} />
            <StatTile label="Weakest" value={s.worst ? pct(s.worst.percent!) : "–"} hint={s.worst?.name ?? "Only one category so far"} />
          </StatGrid>
        )}
      </CardContent>
    </Card>
  );
}

// ---- How the grade is made up, and how it moved ----

const RANGES = [
  { value: "1w", label: "1W", days: 7 },
  { value: "1m", label: "1M", days: 30 },
  { value: "3m", label: "3M", days: 90 },
  { value: "term", label: "Term", days: Infinity },
] as const;
type Range = (typeof RANGES)[number]["value"];

function CourseCharts({ course, now }: { course: CourseGradeView; now: number }) {
  const cats = useMemo(() => categories(course), [course]);
  const series = useMemo(() => gradeSeries(course), [course]);
  const [range, setRange] = useState<Range>("1m");
  const days = RANGES.find((r) => r.value === range)!.days;
  const shown = series.filter((p) => p.at >= now - days * DAY);
  const usesWeights = course.groups.some((g) => (g.weight ?? 0) > 0);
  return (
    <section aria-label="Breakdown and trend" className="grid items-start gap-3 @3xl/page:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Breakdown</CardTitle>
        </CardHeader>
        <CardContent className="gap-4">
          {cats.length ? (
            <>
              <StackedBar segments={cats.map((c) => ({ id: c.name, label: c.name, value: c.weight }))} label={cats.map((c) => `${c.name} ${Math.round(c.weight)}${usesWeights ? "%" : " points"}`).join(", ")} />
              <BarLegend segments={cats.map((c) => ({ id: c.name, label: c.name, value: c.weight, display: c.percent != null ? pct(c.percent) : <span className="text-subtle-foreground">–</span> }))} />
            </>
          ) : (
            <p className="text-muted-foreground text-sm">This course doesn’t list categories.</p>
          )}
        </CardContent>
      </Card>
      <Card>
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <CardTitle className="min-w-0 flex-1">Trend</CardTitle>
          <SegmentedControl variant="outline" aria-label="Range" value={range} onValueChange={setRange}>
            {RANGES.map((r) => (
              <SegmentedControlItem key={r.value} value={r.value} className="min-w-10 px-2.5 text-xs">
                {r.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
        <CardContent>
          <TrendChart points={shown} current={courseHead(course).percent} />
        </CardContent>
      </Card>
    </section>
  );
}

const shortDate = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The grade now (the same figure as the course card, not the line's own last point, which can differ from the site's), then a thin blue line through the grade after each graded item (0922's rate chart), marked only at its end. */
function TrendChart({ points, current }: { points: SeriesPoint[]; current: number | null }) {
  if (points.length < 2) {
    return <div className="flex h-36 items-center justify-center rounded-xl border border-border/70 border-dashed text-muted-foreground text-sm">Not enough graded in this range to draw a line.</div>;
  }
  const lo = Math.max(0, Math.floor(Math.min(...points.map((p) => p.percent)) - 2));
  const hi = Math.min(100, Math.ceil(Math.max(...points.map((p) => p.percent)) + 2));
  const t0 = points[0]!.at;
  const last = points[points.length - 1]!;
  const t1 = last.at;
  const x = (t: number) => (t1 === t0 ? 50 : ((t - t0) / (t1 - t0)) * 100);
  const y = (v: number) => (hi === lo ? 50 : 100 - ((v - lo) / (hi - lo)) * 100);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(p.at)} ${y(p.percent)}`).join(" ");
  const delta = last.percent - points[0]!.percent;
  const flat = Math.abs(delta) < 0.05;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 tabular-nums">
        <span className="font-medium text-2xl text-foreground tracking-heading">{pct(current ?? last.percent)}</span>
        <span className={cn("text-xs", flat ? "text-muted-foreground" : delta > 0 ? "text-success-foreground" : "text-destructive-foreground")}>
          {flat ? "No change" : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}`} since {shortDate(t0)}
        </span>
      </div>
      <div className="flex gap-2">
        <div className="relative h-28 flex-1">
          <motion.svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
            className="absolute inset-0 size-full overflow-visible text-primary"
            initial={{ clipPath: "inset(0 100% 0 0)" }}
            animate={{ clipPath: "inset(0 0% 0 0)" }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <line x1="0" x2="100" y1="0" y2="0" className="stroke-border" vectorEffect="non-scaling-stroke" strokeDasharray="2 3" />
            <line x1="0" x2="100" y1="100" y2="100" className="stroke-border" vectorEffect="non-scaling-stroke" />
            <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </motion.svg>
          {points.map((p, i) => {
            const end = i === points.length - 1;
            return (
              <Tooltip key={`${p.at}-${i}`}>
                <TooltipTrigger
                  render={
                    <span className="-translate-x-1/2 -translate-y-1/2 group absolute flex size-3 items-center justify-center" style={{ left: `${x(p.at)}%`, top: `${y(p.percent)}%` }} />
                  }
                >
                  <span className={cn("size-2 rounded-full border-2 border-card bg-primary transition-opacity", end ? "opacity-100" : "opacity-0 group-hover:opacity-100")} />
                </TooltipTrigger>
                <TooltipPopup>
                  {p.title} · {pct(p.percent)} · {shortDate(p.at)}
                </TooltipPopup>
              </Tooltip>
            );
          })}
        </div>
        <div className="flex w-10 shrink-0 flex-col justify-between text-right text-2xs text-subtle-foreground tabular-nums">
          <span className="-translate-y-1/2">{hi}%</span>
          <span className="translate-y-1/2">{lo}%</span>
        </div>
      </div>
      <div className="flex justify-between pr-12 text-2xs text-subtle-foreground tabular-nums">
        <span>{shortDate(t0)}</span>
        <span>{shortDate(t1)}</span>
      </div>
    </div>
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
    <section className="grid gap-3 @3xl/page:grid-cols-2" aria-label="Needs attention" data-testid="grades-attention">
      <Panel icon={icons.time} title="Due soon" count={due.length} empty="Nothing due in the next week." testId="grades-due">
        {due.slice(0, 5).map((r) => (
          <Line key={`${courseId(r.course)}${r.key}`} r={r} many={many} right={<span className={cn("tabular-nums", r.due! - now < DAY * 1.5 && "font-medium text-warning-foreground")}>{dueWords(r.due, now)}</span>} />
        ))}
      </Panel>
      <Panel icon={icons.warning} title="Missing or late" count={missing.length} empty="Nothing missing or late." tone={missing.length ? "warning" : undefined} testId="grades-missing">
        {missing.slice(0, 5).map((r) => (
          <Line
            key={`${courseId(r.course)}${r.key}`}
            r={r}
            many={many}
            right={
              <Badge variant={r.item.missing ? "error" : "warning"} size="lg">
                {r.item.missing ? "Missing" : "Late"}
              </Badge>
            }
          />
        ))}
      </Panel>
      <Panel icon={icons.done} title="Recently graded" count={recent.length} empty="Nothing graded in the last two weeks." testId="grades-recent">
        {recent.slice(0, 5).map((r) => (
          <Line
            key={`${courseId(r.course)}${r.key}`}
            r={r}
            many={many}
            badge={
              fresh.has(r.item) ? (
                <Badge variant="info" size="default">
                  New
                </Badge>
              ) : null
            }
            right={<span className="text-foreground tabular-nums">{scoreText(r.item)}</span>}
          />
        ))}
      </Panel>
      <Panel icon={icons.goal} title="Worth the most" count={lever.length} empty="Everything is graded." testId="grades-levers">
        {lever.map((l) => (
          <Line key={`${courseId(l.course)}${l.key}`} r={l} many={many} sub={l.next ? `needs ${pct(l.next.percent)} for ${/^[AEFIO]/.test(l.next.letter) ? "an" : "a"} ${l.next.letter}` : undefined} right={<span className="text-foreground tabular-nums">{weightText(l.weight)}</span>} />
        ))}
      </Panel>
    </section>
  );
}

function Panel({ icon, title, hint, count, empty, tone, children, testId }: { icon: IconData; title: string; hint?: string; count: number; empty: string; tone?: "warning"; children: ReactNode; testId?: string }) {
  return (
    <Card className="min-w-0" data-testid={testId}>
      <div className="flex h-12 items-center gap-2 border-b px-5">
        <Icon icon={icon} className={cn("size-4", tone === "warning" ? "text-warning" : "text-muted-foreground")} />
        <h2 className="font-medium text-sm">{title}</h2>
        <span className="text-muted-foreground text-sm tabular-nums">{count || ""}</span>
        {hint ? <span className="ml-auto truncate text-subtle-foreground text-xs max-sm:hidden">{hint}</span> : null}
      </div>
      <div className="flex flex-col p-1.5">{count ? children : <p className="px-3.5 py-3 text-muted-foreground text-sm">{empty}</p>}</div>
    </Card>
  );
}

function Line({ r, many, right, badge, sub }: { r: Ref; many: boolean; right: ReactNode; badge?: ReactNode; sub?: string }) {
  return (
    <button type="button" onClick={() => jump(r.course)} className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3.5 py-1.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <Truncate className="min-w-0 text-sm">{r.item.title}</Truncate>
          {badge}
        </span>
        {many || sub ? <span className="truncate text-muted-foreground text-xs">{[many ? r.course.course : null, sub].filter(Boolean).join(" · ")}</span> : null}
      </span>
      <span className="shrink-0 text-muted-foreground text-sm">{right}</span>
    </button>
  );
}

// ---- Full tables ----

const STATUS: { value: Status; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "graded", label: "Graded" },
  { value: "attention", label: "Missing or late" },
];

function AllTables({ courses, fresh, now }: { courses: CourseGradeView[]; fresh: Set<GradeItem>; now: number }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [sort, setSort] = useState<Sort>({ key: "due", dir: 1 });
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const allClosed = courses.every((c) => closed[courseId(c)]);
  const filtering = !!query.trim() || status !== "all";
  // While filtering, only the courses with a match stay.
  const matching = useMemo(() => (filtering ? courses.filter((c) => tableRows(c, { query, status, sort }).length) : courses), [filtering, courses, query, status, sort]);
  return (
    <section className="flex flex-col gap-3" aria-label="All grades">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium text-lg tracking-title">{courses.length > 1 ? "All grades" : "Assignments"}</h2>
        <div className="relative w-56 max-sm:w-full">
          <Icon icon={icons.search} className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 text-muted-foreground" />
          <Input size="sm" value={query} placeholder="Filter assignments" aria-label="Filter assignments" className="*:data-[slot=input]:ps-8" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <SegmentedControl aria-label="Show" value={status} onValueChange={setStatus}>
          {STATUS.map((s) => (
            <SegmentedControlItem key={s.value} value={s.value} className="px-2.5 text-xs">
              {s.label}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {matching.length > 1 ? (
          <Button size="sm" variant="ghost-muted" onClick={() => setClosed(allClosed ? {} : Object.fromEntries(courses.map((c) => [courseId(c), true])))}>
            {allClosed ? "Expand all" : "Collapse all"}
          </Button>
        ) : null}
      </div>
      {!matching.length ? (
        <div className="flex h-11 items-center gap-2 px-1 text-muted-foreground text-sm">
          <span className="min-w-0 truncate">{query.trim() ? `Nothing matches “${query.trim()}”.` : "Nothing matches this filter."}</span>
          <Button
            size="xs"
            variant="ghost"
            className="text-primary"
            onClick={() => {
              setQuery("");
              setStatus("all");
            }}
          >
            Clear
          </Button>
        </div>
      ) : null}
      <div className="flex flex-col gap-4">
        {matching.map((c) => (
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
    // Not a Card: the card's clipping would stop the header from sticking.
    <section id={id} className="scroll-mt-3 rounded-card border bg-card shadow-card" data-testid="grades-course">
      <div className={cn("sticky top-0 z-10 flex h-13 items-center gap-2 rounded-t-card bg-card/95 px-3 backdrop-blur-sm", open ? "border-b" : "rounded-b-card")}>
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <motion.span animate={{ rotate: open ? 0 : -90 }} transition={{ duration: 0.15, ease: EASE }} className="flex shrink-0 text-muted-foreground">
            <Icon icon={icons.chevronDown} className="size-4" />
          </motion.span>
          <Truncate className="min-w-0 font-medium text-sm">{course.course}</Truncate>
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums max-sm:hidden">{plural(course.items.length, "item")}</span>
        </button>
        {edited ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setScores({})}>
            <Icon icon={icons.undo} />
            Reset
          </Button>
        ) : null}
        <div className="flex shrink-0 items-baseline gap-1.5 pr-2 tabular-nums">
          {r.changed && r.projected != null ? (
            <Tooltip>
              <TooltipTrigger render={<span className="rounded-md bg-primary/8 px-1.5 py-0.5 font-medium text-primary text-sm" />}>
                {pct(r.projected)} <span className="text-xs">{letterFor(r.projected)}</span>
              </TooltipTrigger>
              <TooltipPopup>With the scores you tried; now {h.percent != null ? pct(h.percent) : "–"}</TooltipPopup>
            </Tooltip>
          ) : (
            <>
              <span className="font-medium text-sm">{h.percent != null ? pct(h.percent) : "–"}</span>
              {h.letter ? <span className="text-muted-foreground text-xs">{h.letter}</span> : null}
            </>
          )}
        </div>
      </div>
      {/* Clip rather than hide the overflow, so the column header can still stick to the page's scroll. */}
      <AutoHeight className="overflow-clip">
        {open ? (
          course.note && !course.items.length ? (
            <p className="px-5 py-4 text-muted-foreground text-sm [overflow-wrap:anywhere]">{course.note}</p>
          ) : !course.items.length ? (
            <p className="px-5 py-4 text-muted-foreground text-sm">Nothing graded or assigned yet.</p>
          ) : (
            <>
              <Groups course={course} />
              {/* Clipped, not scrolled: a scroll box would stop the column header from sticking under the course row. */}
              <div className="overflow-x-clip">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead className="sticky top-13 z-5 bg-card/95 backdrop-blur-sm">
                    <tr className="text-muted-foreground text-xs [&>th]:border-b">
                      <Th label="Assignment" k="title" sort={sort} onSort={onSort} className="pl-5 text-left" />
                      <th className="h-9 w-36 pl-3 text-left font-normal">Category</th>
                      <Th label="Due" k="due" sort={sort} onSort={onSort} className="w-24 pl-3 text-left" />
                      <Th label="Score" k="score" sort={sort} onSort={onSort} className="w-28 pl-3 text-right" />
                      <Th label="Weight" k="weight" sort={sort} onSort={onSort} className="w-20 pr-5 pl-3 text-right" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length ? (
                      rows.map(({ key, item, weight }) => {
                        const editable = !item.graded && !item.excused;
                        const typed = scores[key] ?? "";
                        const bad = r.bad.includes(key);
                        return (
                          <tr key={key} className={cn("transition-colors hover:bg-accent/50 [&:not(:first-child)>td]:border-t", item.excused && "text-muted-foreground")}>
                            <td className="h-10 max-w-0 pl-5">
                              <div className="flex min-w-0 items-center gap-1.5">
                                <Truncate className="min-w-0">{item.title}</Truncate>
                                {item.missing ? (
                                  <Badge variant="error" size="default">
                                    Missing
                                  </Badge>
                                ) : null}
                                {item.late ? (
                                  <Badge variant="warning" size="default">
                                    Late
                                  </Badge>
                                ) : null}
                                {item.excused ? (
                                  <Badge variant="secondary" size="default">
                                    Excused
                                  </Badge>
                                ) : null}
                                {fresh.has(item) ? (
                                  <Badge variant="info" size="default">
                                    New
                                  </Badge>
                                ) : null}
                                {item.comments.length ? <Comments comments={item.comments} /> : null}
                              </div>
                            </td>
                            <td className="h-10 max-w-0 pl-3">
                              <Truncate className="text-muted-foreground text-xs">{item.group ?? "–"}</Truncate>
                            </td>
                            <td className="h-10 pl-3 text-muted-foreground text-xs tabular-nums">{dueWords(item.due ? Date.parse(item.due) : null, now) || "–"}</td>
                            <td className="h-10 pl-3 text-right tabular-nums">
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
                                  <span className="w-8 text-left text-muted-foreground text-xs">{item.possible ? `/${item.possible}` : "%"}</span>
                                </span>
                              ) : (
                                <span className={cn(item.missing && "text-destructive-foreground")}>{scoreText(item)}</span>
                              )}
                            </td>
                            <td className="h-10 pr-5 pl-3 text-right text-muted-foreground text-xs tabular-nums">{weightText(weight)}</td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={5} className="h-11 px-5 text-muted-foreground text-sm">
                          Nothing here matches.
                        </td>
                      </tr>
                    )}
                  </tbody>
                  <tfoot>
                    <tr className="bg-well font-medium [&>td]:border-t">
                      <td className="h-10 rounded-bl-card pl-5 text-sm" colSpan={3}>
                        Course total
                      </td>
                      <td className="h-10 pl-3 text-right tabular-nums">
                        {r.changed && r.projected != null ? <span className="text-primary">{pct(r.projected)}</span> : h.percent != null ? pct(h.percent) : "–"}
                      </td>
                      <td className="h-10 rounded-br-card pr-5 pl-3 text-right text-muted-foreground text-xs tabular-nums">100%</td>
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

/** The course's categories with their weights and standing, as quiet chips. */
function Groups({ course }: { course: CourseGradeView }) {
  const groups = useMemo(() => calculate({ groups: course.groups, items: calcItems(course) }).groups.filter((g) => g.counted > 0 || g.weight), [course]);
  if (!groups.length) return null;
  return (
    <div className="flex min-w-0 flex-wrap gap-1.5 border-b px-5 py-2.5 text-xs tabular-nums">
      {groups.map((g) => (
        <span key={g.name} className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full bg-muted px-2.5 text-muted-foreground">
          {g.name}
          {g.weight ? <span className="text-subtle-foreground">{g.weight}%</span> : null}
          <span className="text-foreground">{g.percent != null ? pct(g.percent) : "–"}</span>
        </span>
      ))}
    </div>
  );
}

function Th({ label, k, sort, onSort, className }: { label: string; k: SortKey; sort: Sort; onSort: (k: SortKey) => void; className?: string }) {
  const on = sort.key === k;
  return (
    <th className={cn("h-9 font-normal", className)} aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={() => onSort(k)} className={cn("inline-flex items-center gap-0.5 hover:text-foreground", on && "text-foreground")}>
        {label}
        {on ? <Icon icon={sort.dir === 1 ? icons.chevronUp : icons.chevronDown} className="size-3" /> : null}
      </button>
    </th>
  );
}

function Comments({ comments }: { comments: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" aria-label={`${comments.length} comments`} />}>
        <Icon icon={icons.message} className="size-3.5" />
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
    <div className="flex flex-col gap-8 motion-safe:animate-skeleton" aria-hidden>
      <div className="overflow-hidden rounded-card border">
        <div className="h-20 bg-muted" />
        <div className="flex flex-col gap-2 px-5 pt-5 pb-4">
          <Skeleton className="h-3 w-28 animate-none" />
          <Skeleton className="h-2.5 w-48 animate-none" />
        </div>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-3 px-5 pb-5">
          {[0, 1, 2].map((k) => (
            <div key={k} className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-well px-4 py-3.5">
              <Skeleton className="h-2.5 w-24 animate-none" />
              <Skeleton className="h-5 w-16 animate-none" />
              <Skeleton className="h-2 w-20 animate-none" />
            </div>
          ))}
        </div>
      </div>
      <div className="grid gap-3 @3xl/page:grid-cols-2">
        {[3, 2, 3, 2].map((n, k) => (
          <div key={k} className="rounded-card border">
            <div className="flex h-12 items-center border-b px-5">
              <Skeleton className="h-2.5 w-24 animate-none" />
            </div>
            <div className="p-1.5">
              {Array.from({ length: n }, (_, i) => (
                <div key={i} className="flex h-11 items-center gap-3 px-3.5">
                  <Skeleton className="h-2.5 animate-none" style={{ width: ["46%", "34%", "52%"][i] }} />
                  <span className="flex-1" />
                  <Skeleton className="h-2 w-10 animate-none" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
