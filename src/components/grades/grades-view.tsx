import { useCallback, useEffect, useId, useRef, useState } from "react";

import { openCourseImport, useSitesVersion } from "@/components/lms/import-store";
import { connectionName, isSignedOut, whenText } from "@/components/lms/sites";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { lmsGrades, lmsGradesRefresh, timeOf, type CourseGrades, type GradeItem } from "@/lib/grades-api";
import { lmsConnections, type LmsConnection } from "@/lib/lms";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

import { WhatIf } from "./what-if-panel";
import { calculate, letterFor, pct, trend, type CalcInput } from "./what-if";

/** A course's items in the calculator's terms (keys are positions: titles can repeat). */
export function calcInput(c: CourseGrades): CalcInput {
  return {
    groups: c.groups,
    items: c.items.map((i, n) => ({
      key: String(n),
      title: i.title,
      group: i.group,
      score: i.score,
      possible: i.possible,
      percent: i.percent,
      graded: i.graded,
      excused: i.excused,
      due: timeOf(i.due),
    })),
  };
}

type Refresh = { connection: string; done: number; total: number } | null;

/**
 * Grades, for every course imported into the space: the course grade and
 * which way it last moved, the groups and their weights, every item with its
 * score, status and the teacher's comments, and a what-if calculator. Read
 * from the space's files (fast); Refresh grades reads them from the course
 * site again with the person's own session. Signed out: the saved grades
 * stay, and Sign in again opens the course import's sign-in.
 */
export function GradesView({ space }: { space: Space }) {
  const [courses, setCourses] = useState<CourseGrades[] | null>(null);
  const [connections, setConnections] = useState<LmsConnection[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState<Refresh>(null);
  const [signedOut, setSignedOut] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState("");
  const [said, setSaid] = useState("");
  const headingId = useId();
  const sites = useSitesVersion();
  const signInRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    if (!inTauri()) return setCourses([]);
    try {
      const [g, cs] = await Promise.all([lmsGrades(space.id), lmsConnections(space.id).catch(() => [] as LmsConnection[])]);
      setCourses(g);
      setConnections(cs);
      setSignedOut(new Set(cs.filter((c) => !c.signedIn).map((c) => c.id)));
      setError("");
      return g;
    } catch (e) {
      setError(String(e));
    }
  }, [space.id]);
  // Again after a sign-in finishes (the course import's window), so Sign in again clears the notice.
  useEffect(() => void load(), [load, sites]);

  const school = (id: string) => {
    const c = connections.find((x) => x.id === id);
    return c ? connectionName(c) : "your course site";
  };

  async function doRefresh(connection: string) {
    if (refresh) return;
    setProblem("");
    setSaid("");
    const before = courses ?? [];
    const name = school(connection);
    let failed = "";
    setRefresh({ connection, done: 0, total: before.filter((c) => c.connection === connection).length });
    announce(`Reading your grades from ${name}…`);
    try {
      await lmsGradesRefresh(space.id, connection, (e) => {
        if (e.type === "progress" && e.total != null) setRefresh({ connection, done: e.done ?? 0, total: e.total });
        else if (e.type === "error") failed ||= e.message;
      });
    } catch (e) {
      failed ||= String(e);
    }
    setRefresh(null);
    if (failed && isSignedOut(failed)) {
      setSignedOut((s) => new Set(s).add(connection));
      const text = `You’ve been signed out of ${name}, so the grades couldn’t be read. The grades below are from the last time.`;
      setProblem("");
      announce(text);
      requestAnimationFrame(() => signInRef.current?.focus());
      return;
    }
    const after = (await load()) ?? before;
    if (failed) {
      setProblem(`Some grades couldn’t be read from ${name}. ${failed}`);
      return;
    }
    const fresh = newlyGraded(before, after);
    const text = `Grades updated from ${name}. ${fresh.length ? `New: ${fresh.slice(0, 3).join("; ")}${fresh.length > 3 ? `, and ${fresh.length - 3} more` : ""}.` : "No new grades."}`;
    setSaid(text);
    announce(text);
  }

  const connIds = [...new Set((courses ?? []).map((c) => c.connection))];
  const outIds = connIds.filter((id) => signedOut.has(id));

  return (
    <section aria-labelledby={headingId} data-grades-view={space.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-5 px-6 pt-6 pb-10">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={headingId} className="text-xl font-semibold text-ink">
              Grades
            </h2>
            <p className="text-sm text-ink-secondary">From the courses imported into {space.name}. Phaethon only reads them: nothing changes on your course site.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {connIds.map((id) => (
              <Button
                key={id}
                type="button"
                variant="outline"
                data-grades-refresh={id}
                disabled={!!refresh}
                aria-describedby={refresh?.connection === id ? `${headingId}-progress` : undefined}
                onClick={() => void doRefresh(id)}
              >
                <Icon name={refresh?.connection === id ? "spinner" : "retry"} className={refresh?.connection === id ? "motion-safe:animate-spin" : undefined} />
                {connIds.length > 1 ? `Refresh grades from ${school(id)}` : "Refresh grades"}
              </Button>
            ))}
          </div>
        </header>
        <p id={`${headingId}-progress`} role="status" className={cn("text-sm text-ink-secondary", !refresh && !said && "sr-only")} data-grades-status="">
          {refresh ? `Reading your grades from ${school(refresh.connection)}… ${refresh.total ? `${Math.min(refresh.done + 1, refresh.total)} of ${refresh.total} courses` : ""}` : said}
        </p>
        {outIds.map((id) => (
          <div key={id} className="flex flex-wrap items-start gap-3 rounded-lg border border-transparent bg-warning-soft px-4 py-3 text-base text-warning-ink forced-colors:border-[CanvasText]" data-grades-signed-out={id}>
            <Icon name="lock" className="mt-0.5 shrink-0" />
            <p className="min-w-0 flex-1 basis-60">
              You’ve been signed out of {school(id)}, so Phaethon can’t read new grades. The grades below are from the last time. Sign in again, then refresh.
            </p>
            <Button ref={signInRef} type="button" size="sm" data-grades-signin={id} onClick={() => openCourseImport({ space: space.id, connection: id, at: "signin" })}>
              Sign in again…
            </Button>
          </div>
        ))}
        {problem && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-base text-danger-ink">
            <Icon name="error" className="mt-0.5 shrink-0" />
            <span className="min-w-0 wrap-break-word">{problem}</span>
          </p>
        )}
        {error ? (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-base text-danger-ink">
            <p className="flex items-start gap-2">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">The grades in {space.name} couldn’t be read. {error}</span>
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <Icon name="retry" />
              Try again
            </Button>
          </div>
        ) : courses === null ? (
          <p role="status" className="flex items-center gap-2 text-md text-ink-secondary">
            <Icon name="spinner" className="motion-safe:animate-spin" />
            Loading grades…
          </p>
        ) : courses.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface px-5 py-4" data-grades-empty="">
            <p className="text-md font-medium text-ink">No grades here yet</p>
            <p className="text-base text-ink-secondary">Grades come from your school’s course site. Import your courses into {space.name}, and their grades show here.</p>
            <Button type="button" onClick={() => openCourseImport({ space: space.id })}>
              <Icon name="book" />
              Import courses…
            </Button>
          </div>
        ) : (
          courses.map((c) => <CourseCard key={`${c.connection}:${c.courseId}`} space={space.id} course={c} />)
        )}
      </div>
    </section>
  );
}

/** "HW 4 in Calculus II: 8/10" for each item graded in `after` but not in `before`. */
function newlyGraded(before: CourseGrades[], after: CourseGrades[]): string[] {
  const out: string[] = [];
  for (const c of after) {
    const old = before.find((b) => b.connection === c.connection && b.courseId === c.courseId);
    for (const i of c.items) {
      const was = old?.items.find((o) => o.title === i.title);
      if (i.graded && (!was || !was.graded)) out.push(`${i.title} in ${c.course}${scoreText(i) ? `, ${scoreText(i)}` : ""}`);
    }
  }
  return out;
}

const num = (n: number) => String(Math.round(n * 100) / 100);

function scoreText(i: GradeItem): string {
  if (i.score != null && i.possible != null) return `${num(i.score)}/${num(i.possible)}`;
  if (i.score != null) return num(i.score);
  return "";
}

function dueText(due: GradeItem["due"]): string {
  const ms = timeOf(due);
  return ms == null ? "" : new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function CourseCard({ space, course }: { space: string; course: CourseGrades }) {
  const id = useId();
  const input = calcInput(course);
  const calc = calculate(input);
  const moved = trend(input);
  const site = course.current;
  const percent = site.percent ?? calc.percent;
  const letter = site.letter ?? (percent != null ? letterFor(percent) : undefined);
  const updated = timeOf(course.updated);

  return (
    <section aria-labelledby={`${id}-h`} className="flex flex-col gap-4 rounded-xl border border-line bg-raised p-5 shadow-sm" data-grades-course={course.courseId}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-60 flex-col gap-1">
          <h3 id={`${id}-h`} className="text-lg font-semibold text-ink wrap-break-word">
            {course.course}
          </h3>
          {updated != null && <p className="text-sm text-ink-secondary">Updated {whenText(updated)}</p>}
        </div>
        <div className="flex flex-col items-end gap-0.5 text-end" data-grades-current="">
          <p className="text-2xl font-semibold text-ink tabular-nums">
            {percent != null ? pct(percent) : "No grade yet"}
            {letter && <span className="text-xl text-ink-secondary"> {letter}</span>}
          </p>
          <p className="text-sm text-ink-secondary">{site.percent != null ? "Course grade, as your course site shows it" : percent != null ? "Calculated from your scores" : "Nothing graded yet"}</p>
          {moved && Math.abs(moved.delta) >= 0.05 && (
            <p className="flex items-center gap-1 text-sm font-medium text-ink" data-grades-trend="">
              <Icon name={moved.delta > 0 ? "chevron-up" : "chevron-down"} className="size-(--ph-icon-size-sm)" />
              {moved.delta > 0 ? "Up" : "Down"} {pct(Math.abs(moved.delta)).replace("%", "")} points after {moved.since}
            </p>
          )}
        </div>
      </div>

      {course.note && (
        <p className="text-sm text-ink-secondary" data-grades-note="">
          {course.note}
        </p>
      )}

      {course.groups.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-sm font-semibold text-ink-secondary">{calc.usesWeights ? "How it’s weighted" : "Groups (counted by points)"}</h4>
          <ul className="flex flex-wrap gap-2" data-grades-groups="">
            {calc.groups.map((g) => (
              <li key={g.name} className="flex min-w-0 flex-col rounded-lg border border-line bg-surface px-3 py-2">
                <span className="text-base font-medium text-ink wrap-break-word">{g.name}</span>
                <span className="text-sm text-ink-secondary">
                  {g.weight != null ? `${num(g.weight)}% of the grade` : calc.usesWeights ? "Not weighted" : "By points"}
                  {" · "}
                  {g.percent != null ? `average ${pct(g.percent)}` : "nothing graded"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ItemsTable course={course} captionId={`${id}-h`} />
      <WhatIf space={space} course={course} input={input} sitePercent={site.percent ?? null} />
    </section>
  );
}

function Flags({ i }: { i: GradeItem }) {
  const flags: { icon: "warning" | "error" | "info" | "check"; text: string; tone: string }[] = [];
  if (i.excused) flags.push({ icon: "info", text: "Excused", tone: "text-ink-secondary" });
  if (i.missing) flags.push({ icon: "error", text: "Missing", tone: "text-danger-ink" });
  if (i.late) flags.push({ icon: "warning", text: "Late", tone: "text-warning-ink" });
  if (!i.graded && !i.excused) flags.push({ icon: "info", text: i.submitted ? "Submitted, not graded yet" : "Not graded yet", tone: "text-ink-secondary" });
  if (!flags.length) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {flags.map((f) => (
        <li key={f.text} className={cn("flex items-center gap-1 text-sm font-medium", f.tone)}>
          <Icon name={f.icon} className="size-(--ph-icon-size-sm)" />
          {f.text}
        </li>
      ))}
    </ul>
  );
}

function ItemsTable({ course, captionId }: { course: CourseGrades; captionId: string }) {
  const groups = course.groups.map((g) => g.name);
  const byGroup = [...groups, ...new Set(course.items.map((i) => i.group ?? "").filter((g) => !groups.includes(g)))];
  return (
    // A data table may scroll sideways in a narrow window (WCAG 1.4.10 allows it for tables); the region is focusable so the keyboard can scroll it.
    <div role="region" aria-labelledby={`${captionId} ${captionId}-items`} tabIndex={0} className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-[calc(34rem*var(--ph-ui-scale))] border-collapse text-base" data-grades-items="">
        <caption id={`${captionId}-items`} className="sr-only">
          Assignments and scores
        </caption>
        <thead>
          <tr className="border-b border-line bg-surface text-start text-sm text-ink-secondary">
            <th scope="col" className="px-3 py-2 text-start font-semibold">
              Assignment
            </th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">
              Score
            </th>
            <th scope="col" className="px-3 py-2 text-end font-semibold">
              Percent
            </th>
            <th scope="col" className="px-3 py-2 text-start font-semibold">
              Due
            </th>
            <th scope="col" className="px-3 py-2 text-start font-semibold">
              Status
            </th>
          </tr>
        </thead>
        {byGroup.map((g) => {
          const rows = course.items.filter((i) => (i.group ?? "") === g);
          if (!rows.length) return null;
          return (
            <tbody key={g || "none"} className="border-b border-line last:border-b-0">
              {byGroup.length > 1 && (
                <tr>
                  <th scope="colgroup" colSpan={5} className="bg-surface-sunken px-3 py-1.5 text-start text-sm font-semibold text-ink-secondary">
                    {g || "Other"}
                  </th>
                </tr>
              )}
              {rows.map((i, n) => {
                const percent = i.percent ?? (i.score != null && i.possible ? (i.score / i.possible) * 100 : undefined);
                return (
                  <tr key={`${i.title}-${n}`} className="border-t border-line align-top first:border-t-0">
                    <th scope="row" className="px-3 py-2 text-start font-medium text-ink">
                      <span className="wrap-break-word">{i.title}</span>
                      {i.comments.length > 0 && (
                        <Details summary={`Teacher’s comments (${i.comments.length})`} className="mt-0.5 font-normal">
                          {i.comments.map((t, k) => (
                            <p key={k} className="text-sm whitespace-pre-wrap text-ink wrap-break-word">
                              {t}
                            </p>
                          ))}
                        </Details>
                      )}
                    </th>
                    <td className="px-3 py-2 text-end tabular-nums text-ink">{i.excused ? "–" : scoreText(i) || (i.possible != null ? `–/${num(i.possible)}` : "–")}</td>
                    <td className="px-3 py-2 text-end tabular-nums text-ink">{!i.excused && i.graded && percent != null ? pct(percent) : "–"}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-ink-secondary">{dueText(i.due) || "–"}</td>
                    <td className="px-3 py-2">
                      <Flags i={i} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          );
        })}
      </table>
    </div>
  );
}
