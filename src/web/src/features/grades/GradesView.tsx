/**
 * Grades for one space: each course's current grade at a glance, then one
 * course's groups, items and the what-if panel. Refreshing reads the course
 * site again, with progress, and says what was newly graded.
 */
import { ArrowDownRightIcon, ArrowUpRightIcon, BadgeCheckIcon, ChevronRightIcon, ClockIcon, FileWarningIcon, MessageSquareTextIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { lmsConnections } from "../courses/api";
import { hiddenCourses } from "../courses/lib/reach";
import { courseKey, sameFolder } from "../courses/lib/selection";
import { connectionName, isSignedOut, plural, whenText } from "../courses/lib/sites";
import type { LmsConnection } from "../courses/lib/types";
import { announce } from "../courses/shared/announce";
import { useCourseContext } from "../courses/shared/course-context";
import { CourseFilter } from "../courses/shared/CourseFilter";
import { EduPage, EmptyState, ErrorState, LoadingRows, Meter, PageHeader, Progress, Section } from "../courses/shared/kit";
import { NoCourseAccess } from "../courses/shared/NoCourseAccess";
import { useSitesVersion } from "../courses/shared/signals";
import { lmsGrades, lmsGradesRefresh } from "./api";
import { itemPercent, newlyGraded, newlyText, scoreText } from "./lib/newly";
import type { CourseGradeView, GradeItem } from "./lib/types";
import { calculate, letterFor, pct, timeOf, trend, type CalcInput } from "./lib/what-if";
import { WhatIfPanel } from "./WhatIfPanel";

/** The calculator's input: items keyed by index, since titles repeat. */
function calcInput(c: CourseGradeView): CalcInput {
  return {
    groups: c.groups,
    items: c.items.map((i, n) => ({ key: String(n), title: i.title, group: i.group, score: i.score, possible: i.possible, percent: i.percent, graded: i.graded, excused: i.excused, due: timeOf(i.due) })),
  };
}

function shownGrade(c: CourseGradeView): { percent: number | null; letter: string | null; label: string } {
  const site = c.current.percent ?? null;
  const calc = calculate(calcInput(c)).percent;
  const percent = site ?? calc;
  return {
    percent,
    letter: c.current.letter ?? (percent != null ? letterFor(percent) : null),
    label: site != null ? "Course grade" : calc != null ? "Calculated grade" : "Not graded",
  };
}

type Refresh = { connection: string; done: number; total: number } | null;

export function GradesView({ spaceId }: { spaceId: string }) {
  const space = spaceId;
  const [courses, setCourses] = useState<CourseGradeView[] | null>(null);
  const [connections, setConnections] = useState<LmsConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState<Refresh>(null);
  const [status, setStatus] = useState<{ text: string; tone: "ok" | "warn" } | null>(null);
  const [signedOut, setSignedOut] = useState<string[]>([]);
  const ctx = useCourseContext(space);
  const version = useSitesVersion();
  const go = useNav((s) => s.go);
  const signInRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [g, c] = await Promise.all([lmsGrades(space), lmsConnections().catch(() => [] as LmsConnection[])]);
      setCourses(g);
      setConnections(c);
      setSignedOut(c.filter((x) => !x.signedIn).map((x) => x.id));
      return g;
    } catch (e) {
      setError(errorText(e));
      return null;
    }
  }, [space]);
  useEffect(() => {
    setCourses(null);
  }, [space]);
  useEffect(() => void load(), [load, version]);

  const selected = courses && ctx.selected ? courses.find((c) => courseKey(c.connection, c.courseId) === ctx.selected!.key || sameFolder(c.folder, ctx.selected!.folder)) : undefined;
  const usedConnections = connections.filter((c) => courses?.some((g) => g.connection === c.id) && (!selected || selected.connection === c.id));

  const doRefresh = async (conn: LmsConnection) => {
    const name = connectionName(conn);
    const before = courses ?? [];
    setStatus(null);
    setRefresh({ connection: conn.id, done: 0, total: 0 });
    announce(`Reading your grades from ${name}…`);
    let failure: string | null = null;
    const end = await lmsGradesRefresh(space, conn.id, (e) => {
      if (e.type === "progress") setRefresh({ connection: conn.id, done: e.done, total: e.total });
      else if (e.type === "error" && !failure) failure = e.message;
    });
    if (end.kind === "rejected") failure = errorText(end.error);
    setRefresh(null);
    if (failure && isSignedOut(failure)) {
      setSignedOut((s) => [...new Set([...s, conn.id])]);
      const text = `You’ve been signed out of ${name}. Sign in again, then refresh.`;
      setStatus({ text, tone: "warn" });
      announce(text);
      requestAnimationFrame(() => signInRef.current?.focus());
      return;
    }
    const after = await load();
    if (failure) {
      const text = `Some grades couldn’t be read from ${name}. ${failure}`;
      setStatus({ text, tone: "warn" });
      announce(text);
      return;
    }
    const fresh = after ? newlyGraded(before, after) : [];
    const text = `Grades updated from ${name}. ${
      fresh.length ? `New: ${fresh.slice(0, 3).map(newlyText).join("; ")}${fresh.length > 3 ? `, and ${fresh.length - 3} more` : ""}.` : "No new grades."
    }`;
    setStatus({ text, tone: "ok" });
    announce(text);
  };

  const hidden = hiddenCourses(ctx.reach, "grades");
  const options = (courses ?? []).map((c) => ({ folder: c.folder, name: c.course, key: courseKey(c.connection, c.courseId) }));

  return (
    <EduPage>
      <PageHeader
        title="Grades"
        back={selected ? { label: "All courses", onClick: () => ctx.select(null) } : undefined}
        focusKey={selected ? selected.courseId : undefined}
        actions={
          courses && courses.length > 0 ? (
            <>
              <CourseFilter options={options} value={selected?.folder ?? null} onChange={(o) => ctx.select(o ? { key: o.key, folder: o.folder, name: o.name } : null)} />
              {usedConnections.map((c) => (
                <Button key={c.id} variant="outline" disabled={!!refresh} onClick={() => void doRefresh(c)} data-grades-refresh={c.id}>
                  <RefreshCwIcon aria-hidden className={cn(refresh?.connection === c.id && "motion-safe:animate-spin")} />
                  {usedConnections.length > 1 ? `Refresh from ${connectionName(c)}` : "Refresh"}
                </Button>
              ))}
            </>
          ) : undefined
        }
      />

      {refresh && (
        <div className="-mt-4 flex flex-col gap-2" data-grades-refreshing="">
          <Progress value={refresh.total ? refresh.done / refresh.total : null} label="Reading grades" valueText={refresh.total ? `${refresh.done} of ${refresh.total} courses` : undefined} />
          <p className="text-sm text-muted-foreground">
            Reading your grades{refresh.total ? `: ${refresh.done + 1 > refresh.total ? refresh.total : refresh.done + 1} of ${plural(refresh.total, "course")}` : "…"}
          </p>
        </div>
      )}
      {status && !refresh && (
        <p className={cn("-mt-4 flex items-start gap-2 text-sm", status.tone === "ok" ? "text-muted-foreground" : "text-warning-foreground")} data-grades-status="">
          {status.tone === "ok" ? <BadgeCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-success-foreground" /> : <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />}
          {status.text}
        </p>
      )}

      {connections
        .filter((c) => signedOut.includes(c.id) && courses?.some((g) => g.connection === c.id))
        .map((c) => (
          <div key={c.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/32 bg-warning-surface px-4 py-3 text-sm" data-grades-signed-out={c.id}>
            <span className="text-warning-foreground">Signed out of {connectionName(c)}. These grades are from the last time you were signed in.</span>
            <Button ref={signInRef} size="sm" variant="outline" onClick={() => go({ kind: "courses" })}>
              Sign in again
            </Button>
          </div>
        ))}

      {error ? (
        <ErrorState title={`The grades in this space couldn’t be read.`} message={error} onRetry={() => void load()} />
      ) : !courses ? (
        <LoadingRows rows={3} label="Loading grades" />
      ) : courses.length === 0 ? (
        hidden ? (
          <NoCourseAccess why={hidden} part="grades" />
        ) : (
          <EmptyState icon={<BadgeCheckIcon />} title="No grades here yet" description="Import a course from your course site and its grades show here, with what-if math for what isn’t graded yet.">
            <Button onClick={() => go({ kind: "courses" })}>Import courses</Button>
          </EmptyState>
        )
      ) : selected ? (
        <CourseGrades key={`${selected.connection}/${selected.courseId}`} space={space} c={selected} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Courses">
          {courses.map((c) => (
            <CourseCard key={`${c.connection}/${c.courseId}`} c={c} onOpen={() => ctx.select({ key: courseKey(c.connection, c.courseId), connection: c.connection, courseId: c.courseId, folder: c.folder, name: c.course })} />
          ))}
        </ul>
      )}
    </EduPage>
  );
}

function CourseCard({ c, onOpen }: { c: CourseGradeView; onOpen: () => void }) {
  const g = shownGrade(c);
  const counted = c.items.filter((i) => i.graded && !i.excused).length;
  const t = trend(calcInput(c));
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group flex h-full w-full flex-col gap-3 rounded-2xl border bg-card p-5 text-start outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        data-grade-course={c.courseId}
      >
        <span className="flex w-full items-start justify-between gap-3">
          <span className="min-w-0 text-[0.9375rem] font-semibold text-foreground">{c.course}</span>
          <ChevronRightIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
        </span>
        <span className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">{g.percent == null ? "—" : pct(g.percent)}</span>
          {g.letter && g.percent != null && <span className="text-lg font-medium text-muted-foreground">{g.letter}</span>}
        </span>
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{g.label}</span>
          {c.items.length > 0 && <span>{counted} of {plural(c.items.length, "item")} graded</span>}
          {t && Math.abs(t.delta) >= 0.05 && (
            <span className={cn("inline-flex items-center gap-0.5", t.delta > 0 ? "text-success-foreground" : "text-destructive-foreground")}>
              {t.delta > 0 ? <ArrowUpRightIcon aria-hidden className="size-3.5" /> : <ArrowDownRightIcon aria-hidden className="size-3.5" />}
              {t.delta > 0 ? "Up" : "Down"} {Math.abs(Math.round(t.delta * 10) / 10)} after {t.since}
            </span>
          )}
        </span>
        {c.note && <span className="text-sm text-muted-foreground">{c.note}</span>}
      </button>
    </li>
  );
}

function CourseGrades({ space, c }: { space: string; c: CourseGradeView }) {
  const input = calcInput(c);
  const g = shownGrade(c);
  const r = calculate(input);
  const t = trend(input);
  const declared = c.groups.map((x) => x.name);
  const groupNames = [...declared, ...new Set(c.items.map((i) => i.group ?? "").filter((n) => !declared.includes(n)))];
  const byGroup = groupNames.map((name) => ({ name, items: c.items.map((item, n) => ({ item, n })).filter(({ item }) => (item.group ?? "") === name) })).filter((x) => x.items.length);
  const weighted = r.usesWeights;

  return (
    <>
      <section aria-label="Course grade" className="flex flex-col gap-4 rounded-2xl border bg-card p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-foreground">{c.course}</h2>
          <p className="flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-tight text-foreground tabular-nums">{g.percent == null ? "—" : pct(g.percent)}</span>
            {g.letter && g.percent != null && <span className="text-xl font-medium text-muted-foreground">{g.letter}</span>}
          </p>
          <p className="text-sm text-muted-foreground">
            {g.label}
            {t && Math.abs(t.delta) >= 0.05 && ` · ${t.delta > 0 ? "Up" : "Down"} ${Math.abs(Math.round(t.delta * 10) / 10)} points after ${t.since}`}
          </p>
          {c.note && <p className="text-sm text-muted-foreground">{c.note}</p>}
        </div>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <ClockIcon aria-hidden className="size-3.5" />
          Updated {whenText(c.updated)}
        </p>
      </section>

      {r.groups.length > 0 && (
        <Section title={weighted ? "How it’s weighted" : "Groups (counted by points)"}>
          <ul className="grid gap-x-6 gap-y-3 rounded-2xl border bg-card p-5 sm:grid-cols-2">
            {r.groups.map((grp) => (
              <li key={grp.name} className="flex flex-col gap-1.5">
                <span className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="font-medium text-foreground">{grp.name}</span>
                  <span className="text-muted-foreground tabular-nums">{grp.percent == null ? "nothing graded" : `average ${pct(grp.percent)}`}</span>
                </span>
                <Meter value={(grp.percent ?? 0) / 100} />
                <span className="text-sm text-muted-foreground">{weighted ? ((grp.weight ?? 0) > 0 ? `${grp.weight}% of the grade` : "Not counted in the weighted grade") : "By points"}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {c.items.length > 0 && (
        <Section title="Assignments">
          <div role="region" tabIndex={0} aria-label="Assignments and scores" className="overflow-x-auto rounded-2xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b text-start text-muted-foreground">
                  <th scope="col" className="px-4 py-2.5 text-start font-medium">Assignment</th>
                  <th scope="col" className="px-3 py-2.5 text-end font-medium">Score</th>
                  <th scope="col" className="px-3 py-2.5 text-end font-medium">Percent</th>
                  <th scope="col" className="px-3 py-2.5 text-start font-medium">Due</th>
                  <th scope="col" className="px-4 py-2.5 text-start font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {byGroup.map(({ name, items }) => (
                  <Fragment key={name || "other"}>
                    {byGroup.length > 1 && (
                      <tr className="bg-muted/50">
                        <th colSpan={5} scope="colgroup" className="px-4 py-1.5 text-start text-sm font-semibold text-foreground">
                          {name || "Other"}
                        </th>
                      </tr>
                    )}
                    {items.map(({ item, n }) => (
                      <ItemRow key={n} item={item} />
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <WhatIfPanel storeKey={`${space}:${c.connection}:${c.courseId}`} input={input} sitePercent={c.current.percent ?? null} />
    </>
  );
}

function ItemRow({ item }: { item: GradeItem }) {
  const p = itemPercent(item);
  const due = timeOf(item.due);
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-4 py-2.5 align-top">
        <span className="text-foreground">{item.title}</span>
        {item.comments.length > 0 && (
          <details className="group/c mt-1">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <MessageSquareTextIcon aria-hidden className="size-3.5" />
              {plural(item.comments.length, "comment")} from your teacher
            </summary>
            <ul className="mt-1.5 flex flex-col gap-1 border-s-2 ps-3 text-sm text-foreground">
              {item.comments.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="px-3 py-2.5 text-end align-top text-foreground tabular-nums">{scoreText(item)}</td>
      <td className="px-3 py-2.5 text-end align-top text-foreground tabular-nums">{p == null ? "" : pct(p)}</td>
      <td className="px-3 py-2.5 align-top whitespace-nowrap text-muted-foreground">{due ? new Date(due).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : ""}</td>
      <td className="px-4 py-2.5 align-top">
        <span className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
          {item.excused && <span className="text-muted-foreground">Excused</span>}
          {item.missing && (
            <span className="inline-flex items-center gap-1 text-destructive-foreground">
              <FileWarningIcon aria-hidden className="size-3.5" />
              Missing
            </span>
          )}
          {item.late && (
            <span className="inline-flex items-center gap-1 text-warning-foreground">
              <ClockIcon aria-hidden className="size-3.5" />
              Late
            </span>
          )}
          {!item.graded && !item.excused && <span className="text-muted-foreground">{item.submitted ? "Submitted, not graded yet" : "Not graded yet"}</span>}
        </span>
      </td>
    </tr>
  );
}
