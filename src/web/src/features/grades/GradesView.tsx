import { ChartNoAxesColumnIcon, MessageSquareTextIcon, RotateCcwIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { JobBar } from "@/features/study/components/parts";
import { useLoad } from "@/features/study/use-load";
import { useDelayed } from "@/hooks/use-delayed";
import { relativeTime } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { lmsGrades, lmsGradesRefresh } from "./api";
import { newlyGraded, scoreText } from "./lib/newly";
import { calcItems, itemWeights, keyedItems, loadSeen, saveSeen, weightText } from "./lib/table";
import type { CourseGradeView, GradeItem } from "./lib/types";
import { calculate, FINAL, letterFor, pct, whatIf } from "./lib/what-if";

type Refresh = { done: number; total: number; course?: string };

/**
 * Grades per course: a compact table (assignment, category, score, weight),
 * the course total, scores to try on what isn't graded yet ("what if"), and
 * marks on what was graded since the last look. Refreshing reads the course
 * sites again, course by course.
 */
export function GradesView({ space }: { space: SpaceView }) {
  const grades = useLoad(() => lmsGrades(space.id), [space.id]);
  const skeleton = useDelayed(grades.loading && !grades.data);
  const [seen] = useState(() => loadSeen(space.id));
  const [refresh, setRefresh] = useState<Refresh | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const latest = useRef<CourseGradeView[] | undefined>(undefined);
  latest.current = grades.data;

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

  const runRefresh = async () => {
    if (!data?.length) return;
    setRefreshError(null);
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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title="Grades"
        actions={
          data?.length ? (
            <>
              {updated && !refresh ? <span className="mr-1 text-2xs text-muted-foreground tabular-nums max-[980px]:hidden">Updated {relativeTime(updated).toLowerCase()}</span> : null}
              <Button size="xs" variant="outline" disabled={!!refresh} onClick={() => void runRefresh()}>
                {refresh ? <Spinner size="xs" /> : <RotateCwIcon />}
                {refresh ? "Refreshing…" : "Refresh"}
              </Button>
            </>
          ) : null
        }
      />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        {refresh ? (
          <div className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur-sm">
            <JobBar value={refresh.total ? refresh.done / refresh.total : 0} />
            <div className="mx-auto flex h-8 max-w-4xl items-center gap-3 px-4 text-muted-foreground text-xs">
              <span className="min-w-0 flex-1 truncate">{refresh.course ? `Reading grades for ${refresh.course}…` : "Reading your course sites…"}</span>
              <span className="shrink-0 tabular-nums">
                {Math.min(refresh.done, refresh.total)}/{refresh.total}
              </span>
            </div>
          </div>
        ) : null}
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
          {grades.error ? <SurfaceError title="Couldn’t load your grades" message={cleanMessage(grades.error)} onRetry={grades.reload} /> : null}
          {refreshError ? <RefreshError message={refreshError} onRetry={() => void runRefresh()} onDismiss={() => setRefreshError(null)} /> : null}
          {skeleton ? <GradesSkeleton /> : null}
          {data && !data.length ? (
            <Empty className="min-h-[60vh]">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ChartNoAxesColumnIcon />
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
          {data?.map((c) => <CourseCard key={`${c.connection}/${c.courseId}`} course={c} fresh={fresh} />)}
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

function CourseCard({ course, fresh }: { course: CourseGradeView; fresh: Set<GradeItem> }) {
  const [scores, setScores] = useState<Record<string, string>>({});
  const input = useMemo(() => ({ groups: course.groups, items: calcItems(course) }), [course]);
  const weights = useMemo(() => itemWeights(course), [course]);
  const r = useMemo(() => whatIf(input, { scores, finalWeight: "", finalScore: "", target: "A", on: FINAL }), [input, scores]);
  const groups = useMemo(() => calculate(input).groups.filter((g) => g.counted > 0 || g.weight), [input]);
  const keyed = keyedItems(course.items);
  const current = course.current.percent ?? r.now;
  const letter = course.current.letter ?? (current != null ? letterFor(current) : undefined);
  const edited = Object.values(scores).some((s) => s.trim());

  return (
    <section className="overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-3 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <Truncate className="font-medium text-sm">{course.course}</Truncate>
          {groups.length ? (
            <div className="flex min-w-0 gap-3 overflow-hidden text-2xs text-muted-foreground tabular-nums">
              {groups.map((g) => (
                <span key={g.name} className="shrink-0 whitespace-nowrap">
                  {g.name}
                  {g.weight ? <span className="text-subtle-foreground"> {g.weight}%</span> : null}
                  <span className="text-foreground/80"> {g.percent != null ? pct(g.percent) : "–"}</span>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {edited ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setScores({})}>
            <RotateCcwIcon />
            Reset
          </Button>
        ) : null}
        <div className="flex shrink-0 items-baseline gap-1.5 tabular-nums">
          {r.changed && r.projected != null ? (
            <Tooltip>
              <TooltipTrigger render={<span className="rounded-md bg-primary/8 px-1.5 font-semibold text-lg text-primary" />}>
                {pct(r.projected)} <span className="font-medium text-xs">{letterFor(r.projected)}</span>
              </TooltipTrigger>
              <TooltipPopup>With the scores you tried; now {current != null ? pct(current) : "–"}</TooltipPopup>
            </Tooltip>
          ) : (
            <>
              <span className="font-semibold text-lg">{current != null ? pct(current) : "–"}</span>
              {letter ? <span className="font-medium text-muted-foreground text-xs">{letter}</span> : null}
            </>
          )}
        </div>
      </div>
      {course.note && !course.items.length ? (
        <p className="px-4 py-3 text-muted-foreground text-xs [overflow-wrap:anywhere]">{course.note}</p>
      ) : !course.items.length ? (
        <p className="px-4 py-3 text-muted-foreground text-xs">Nothing graded or assigned yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="text-2xs text-muted-foreground">
                <th className="h-7 pl-4 text-left font-medium">Assignment</th>
                <th className="h-7 w-40 pl-3 text-left font-medium">Category</th>
                <th className="h-7 w-28 pl-3 text-right font-medium">Score</th>
                <th className="h-7 w-20 pr-4 pl-3 text-right font-medium">Weight</th>
              </tr>
            </thead>
            <tbody>
              {keyed.map(({ key, item }) => {
                const open = !item.graded && !item.excused;
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
                    <td className="h-8 pl-3 text-right tabular-nums">
                      {open ? (
                        <span className="inline-flex items-center justify-end gap-1">
                          <input
                            aria-label={`Try a score for ${item.title}`}
                            inputMode="decimal"
                            placeholder="–"
                            value={typed}
                            onChange={(e) => setScores((s) => ({ ...s, [key]: e.target.value }))}
                            className={cn(
                              "h-6 w-12 rounded-md border border-transparent bg-transparent px-1.5 text-right text-sm tabular-nums outline-none placeholder:text-subtle-foreground hover:border-input focus:border-ring",
                              typed.trim() && !bad && "border-primary/40 bg-primary/8 text-primary",
                              bad && "border-destructive/60 bg-destructive/6 text-destructive-foreground",
                            )}
                          />
                          <span className="text-muted-foreground text-xs">{item.possible ? `/${item.possible}` : "%"}</span>
                        </span>
                      ) : (
                        <span className={cn(item.missing && "text-error-foreground")}>{scoreText(item)}</span>
                      )}
                    </td>
                    <td className="h-8 pr-4 pl-3 text-right text-muted-foreground text-xs tabular-nums">{weightText(weights.get(key))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t bg-muted/40 font-medium">
                <td className="h-8 pl-4 text-xs" colSpan={2}>
                  Course total
                </td>
                <td className="h-8 pl-3 text-right tabular-nums">
                  {r.changed && r.projected != null ? <span className="text-primary">{pct(r.projected)}</span> : current != null ? pct(current) : "–"}
                </td>
                <td className="h-8 pr-4 pl-3 text-right text-muted-foreground text-xs tabular-nums">100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function Comments({ comments }: { comments: string[] }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 text-muted-foreground" aria-label={`${comments.length} comments`} />}>
        <MessageSquareTextIcon className="size-3.5" strokeWidth={2} />
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
    <div className="flex flex-col gap-4 motion-safe:animate-skeleton" aria-hidden>
      {[5, 4].map((n, k) => (
        <div key={k} className="overflow-hidden rounded-xl border">
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-2.5 w-48 animate-none" />
              <Skeleton className="h-2 w-64 animate-none" />
            </div>
            <Skeleton className="h-4 w-14 animate-none" />
          </div>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="flex h-8 items-center gap-3 border-t px-4 first:border-t-0">
              <div className="flex-1">
                <Skeleton className="h-2.5 animate-none" style={{ width: ["42%", "31%", "50%", "36%", "45%"][i] }} />
              </div>
              <Skeleton className="h-2 w-20 animate-none" />
              <Skeleton className="h-2.5 w-12 animate-none" />
              <Skeleton className="h-2 w-8 animate-none" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
