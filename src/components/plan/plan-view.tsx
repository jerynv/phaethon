import { Checkbox, NativeSelect } from "vic-ui";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import { hiddenCourses, NoCourseAccess, useCourseReach } from "@/components/lms/course-reach";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/menu";
import { WorkspacePage, WorkspacePageHeader, WorkspaceSection } from "@/components/ui/workspace-page";
import { Icon } from "@/icons";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { courseMatches } from "@/components/study/course-grid";

import { start as startTimer, useFocusTimer } from "./focus-timer-store";
import { FocusTimer } from "./focus-timer";
import {
  DEFAULT_STATE,
  decksByCourse,
  planExamsGet,
  planExamsSet,
  planSave,
  planStateGet,
  planStateSet,
  planUpcoming,
  requestSpaceView,
  type CourseRef,
  type Exam,
  type PlanState,
  type Upcoming,
} from "./plan-api";
import { addDays, dayName, localDay, makePlan, planMarkdown, type Session } from "./schedule";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Shown Monday first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

const openFile = (space: string, path: string) => (inTauri() ? invoke<void>("file_open", { space, path }) : Promise.resolve());

const newId = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * The study planner for a space: today's sessions to check off, a focus
 * timer, the exams you add, what's due from your imported courses, and a
 * schedule that spreads review before each exam and work before each due
 * date over the days you study, never more a day than you choose. Saved as
 * study/plan.md on Save; check-offs and settings are kept by the core.
 */
export function PlanView({ space }: { space: Space }) {
  const [upcoming, setUpcoming] = useState<Upcoming[] | null>(null);
  const [courses, setCourses] = useState<CourseRef[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [st, setSt] = useState<PlanState>(DEFAULT_STATE);
  const [decks, setDecks] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [course, setCourse] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [week, setWeek] = useState(0);
  const headingId = useId();
  const today = localDay(Date.now());

  const load = useCallback(async () => {
    try {
      const [u, e, s, d] = await Promise.all([planUpcoming(space.id), planExamsGet(space.id), planStateGet(space.id), decksByCourse(space.id)]);
      setUpcoming(u.items);
      setCourses(u.courses);
      setExams(e);
      setSt(s);
      setDecks(d);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [space.id]);
  useEffect(() => void load(), [load]);

  const input = useMemo(
    () => ({ today, exams, due: upcoming ?? [], studyDays: st.studyDays, sessionsPerDay: st.sessionsPerDay, decks }),
    [today, exams, upcoming, st.studyDays, st.sessionsPerDay, decks],
  );
  const plan = useMemo(() => makePlan(input), [input]);
  const done = useMemo(() => new Set(st.done), [st.done]);

  async function saveState(next: PlanState) {
    const before = st;
    setSt(next);
    try {
      setSt(await planStateSet(space.id, next));
    } catch (e) {
      setSt(before);
      announce(`That change couldn’t be saved. ${String(e)}`);
    }
  }

  function toggleDone(s: Session, on: boolean) {
    const next = on ? [...st.done.filter((d) => d !== s.id), s.id] : st.done.filter((d) => d !== s.id);
    void saveState({ ...st, done: next });
    announce(on ? `${s.title}: done.` : `${s.title}: not done.`);
  }

  async function save() {
    try {
      const path = await planSave(space.id, planMarkdown(plan, input, done, st.sessionMinutes));
      setSaved(path);
      announce(`Plan saved to ${path}.`);
    } catch (e) {
      setSaved("");
      announce(`The plan couldn’t be saved. ${String(e)}`);
    }
  }

  const selected = courses.find((c) => c.folder === course);
  const matches = (name?: string) => !course || courseMatches(name, course, selected?.name ?? "");
  const visiblePlan = { ...plan, days: plan.days.map((d) => ({ ...d, sessions: d.sessions.filter((s) => matches(s.course)) })).filter((d) => d.sessions.length) };
  const todays = visiblePlan.days.find((d) => d.day === today)?.sessions ?? [];
  const dueToday = (upcoming ?? []).filter((u) => localDay(u.due) === today && matches(u.folder));
  // FullCalendar's event-array pattern: deadlines and saved exams share one dated agenda.
  const agenda = [...(upcoming ?? []), ...exams.map((e) => ({ course: courses.find((c) => c.folder === e.course)?.name ?? e.course ?? "Exam", folder: e.course ?? "", title: e.title, due: new Date(`${e.date}T12:00:00`).getTime(), link: "" }))]
    .filter((item) => localDay(item.due) >= today && (!course || matches(item.folder)))
    .sort((a, b) => a.due - b.due);

  return (
    <section aria-labelledby={headingId} data-plan-view={space.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
      <WorkspacePage className="gap-4 pt-5">
        <WorkspacePageHeader
          title="Plan"
          headingProps={{ id: headingId }}
          actions={<><TimerPopover /><Button type="button" variant="outline" size="sm" onClick={() => void save()} data-plan-save=""><Icon name="download" />Export plan</Button></>}
        />
        {error && (
          <div role="alert" className="flex flex-col items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-base text-danger-ink">
            <p className="flex items-start gap-2">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-break-word">The plan for {space.name} couldn’t be read. {error}</span>
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              <Icon name="retry" />
              Try again
            </Button>
          </div>
        )}
        {courses.length > 0 && <div className="flex min-w-0 items-center gap-2" data-plan-course=""><label htmlFor={`${headingId}-course`} className="shrink-0 text-sm text-ink-secondary">Course</label><NativeSelect id={`${headingId}-course`} value={course ?? ""} onChange={(event) => { setCourse(event.target.value || null); setDay(null); }} data-plan-course-filter="" className="max-w-full min-w-0 w-auto"><option value="">All courses</option>{courses.map((item) => <option key={item.folder} value={item.folder}>{item.name}</option>)}</NativeSelect></div>}
        <div className="flex items-center justify-between gap-2"><h3 className="text-base font-semibold text-ink">{week === 0 ? "Next seven days" : `${dayName(addDays(today, week * 7))} – ${dayName(addDays(today, week * 7 + 6))}`}</h3><div className="flex gap-1"><Button type="button" variant="ghost" size="icon-sm" aria-label="Previous week" disabled={week === 0} onClick={() => { setWeek((value) => Math.max(0, value - 1)); setDay(null); }}><Icon name="chevron-left" /></Button><Button type="button" variant="ghost" size="icon-sm" aria-label="Next week" onClick={() => { setWeek((value) => value + 1); setDay(null); }}><Icon name="chevron-right" /></Button></div></div>
        <nav aria-label="Agenda days" className="grid grid-cols-7 gap-1" data-plan-week="">
          {Array.from({ length: 7 }, (_, i) => addDays(today, week * 7 + i)).map((date) => {
            const count = agenda.filter((item) => localDay(item.due) === date).length;
            const active = day === date;
            return <Button key={date} type="button" variant={active ? "default" : "ghost"} aria-pressed={active} onClick={() => setDay(active ? null : date)} className="h-auto [&>.ui-button-face]:h-auto [&>.ui-button-face]:px-1 [&>.ui-button-face]:py-1"><span className="flex flex-col gap-0.5"><span className="text-xs font-normal">{new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span><span className="text-lg tabular-nums">{Number(date.slice(-2))}</span><span className="text-xs font-normal">{count ? `${count} due` : "—"}</span></span></Button>;
          })}
        </nav>
        <ComingUp space={space.id} items={upcoming === null ? null : agenda.filter((item) => day ? localDay(item.due) === day : localDay(item.due) >= addDays(today, week * 7) && localDay(item.due) <= addDays(today, week * 7 + 6))} />
        <Today space={space.id} sessions={todays} due={dueToday} done={done} onToggle={toggleDone} loading={upcoming === null} />
        <Details summary="Exams"><Exams key={course ?? "all"} space={space} exams={exams} courses={courses} onChange={setExams} visibleCourse={course ?? undefined} /></Details>
        <Schedule
          space={space.id}
          plan={visiblePlan}
          st={st}
          done={done}
          onState={(s) => void saveState(s)}
          onToggle={toggleDone}
          saved={saved}
        />
      </WorkspacePage>
    </section>
  );
}

function TimerPopover() {
  const timer = useFocusTimer();
  return <Popover.Root><Popover.Trigger asChild><Button type="button" variant="ghost" size="sm" data-plan-timer=""><Icon name={timer.running ? "pause" : "play"} />{timer.running ? "Focus running" : "Focus timer"}</Button></Popover.Trigger><Popover.Portal><Popover.Content align="end" sideOffset={8} className="max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto p-4"><FocusTimer /></Popover.Content></Popover.Portal></Popover.Root>;
}

function SessionRow({ space, s, done, onToggle, focus }: { space: string; s: Session; done: boolean; onToggle: (s: Session, on: boolean) => void; focus?: boolean }) {
  const timer = useFocusTimer();
  const id = useId();
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-plan-session={s.id}>
      <Checkbox
        id={id}

        checked={done}
        onChange={(e) => onToggle(s, e.target.checked)}
      />
      <div className="flex min-w-0 flex-1 basis-48 flex-col">
        <label htmlFor={id} className={cn("text-base font-medium text-ink wrap-break-word", done && "text-ink-secondary line-through")}>
          {s.title}
        </label>
        <span className="text-sm text-ink-secondary">
          {[s.course, s.kind === "work" ? `due ${dayName(s.target)}` : `exam ${dayName(s.target)}`].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {s.decks.map((d) => (
          <Button key={d} type="button" variant="outline" size="sm" onClick={() => requestSpaceView({ space, view: "study", deck: d })} aria-label={`Study the deck ${d}`}>
            <Icon name="book" />
            {d}
          </Button>
        ))}
        {s.link && (
          <Button type="button" variant="ghost" size="sm" onClick={() => void openFile(space, s.link!.split("#")[0])} aria-label={`Details of ${s.title.replace(/^Work on /, "")}`}>
            <Icon name="file-text" />
            Details
          </Button>
        )}
        {focus && !done && (
          <Button type="button" variant="ghost" size="sm" disabled={timer.running} onClick={() => startTimer(s.title)} data-plan-focus={s.id} aria-label={`Focus on ${s.title}`}>
            <Icon name="play" />
            Focus
          </Button>
        )}
      </div>
    </li>
  );
}

function Today({ space, sessions, due, done, onToggle, loading }: { space: string; sessions: Session[]; due: Upcoming[]; done: Set<string>; onToggle: (s: Session, on: boolean) => void; loading: boolean }) {
  const id = useId();
  const left = sessions.filter((s) => !done.has(s.id)).length;
  return (
    <WorkspaceSection
      title="Today"
      titleId={id}
      data-plan-today=""
      actions={sessions.length > 0 && <p className="text-sm text-ink-secondary">{left === 0 ? "All done" : `${left} of ${sessions.length} left`}</p>}
    >
      {loading ? (
        <p className="text-base text-ink-secondary">Loading…</p>
      ) : sessions.length === 0 && due.length === 0 ? (
        <p className="text-base text-ink-secondary">Nothing planned for today.</p>
      ) : (
        <>
          {sessions.length > 0 && (
            <ul aria-labelledby={id} className="flex flex-col divide-y divide-line">
              {sessions.map((s) => (
                <SessionRow key={s.id} space={space} s={s} done={done.has(s.id)} onToggle={onToggle} focus />
              ))}
            </ul>
          )}
          {due.length > 0 && (
            <p className="flex items-start gap-2 text-base text-ink" data-plan-due-today="">
              <Icon name="warning" className="mt-0.5 shrink-0 text-warning-ink" />
              <span>Due today: {due.map((u) => `${u.title} (${u.course})`).join("; ")}.</span>
            </p>
          )}
        </>
      )}
    </WorkspaceSection>
  );
}

function Exams({ space, exams, courses, onChange, visibleCourse }: { space: Space; exams: Exam[]; courses: CourseRef[]; onChange: (e: Exam[]) => void; visibleCourse?: string }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [course, setCourse] = useState(visibleCourse ?? "");
  const [problem, setProblem] = useState<{ field: "title" | "date" | "save"; text: string } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const today = localDay(Date.now());

  async function add(e: FormEvent) {
    e.preventDefault();
    setProblem(null);
    if (!title.trim()) {
      setProblem({ field: "title", text: "Give the exam a name, like “Test 1”." });
      titleRef.current?.focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setProblem({ field: "date", text: "Choose the exam’s date." });
      dateRef.current?.focus();
      return;
    }
    try {
      const next = await planExamsSet(space.id, [...exams, { id: newId(), title: title.trim(), date, ...(course ? { course } : {}) }]);
      onChange(next);
      announce(`${title.trim()} added for ${dayName(date)}. The schedule now includes it.`);
      setTitle("");
      setDate("");
      titleRef.current?.focus();
    } catch (err) {
      setProblem({ field: "save", text: `The exam couldn’t be saved. ${String(err)}` });
    }
  }

  async function remove(x: Exam, index: number) {
    try {
      const next = await planExamsSet(space.id, exams.filter((e) => e.id !== x.id));
      onChange(next);
      announce(`${x.title} removed.`);
      requestAnimationFrame(() => {
        const buttons = listRef.current?.querySelectorAll<HTMLElement>("[data-exam-remove]");
        (buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)] ?? titleRef.current)?.focus();
      });
    } catch (err) {
      announce(`${x.title} couldn’t be removed. ${String(err)}`);
    }
  }

  const err = (f: "title" | "date") => (problem?.field === f ? `${id}-err` : undefined);

  return (
    <WorkspaceSection title="Exams" titleId={id} data-plan-exams="">
      {exams.length === 0 ? (
        <p className="text-sm text-ink-secondary">No exams yet.</p>
      ) : (
        <ul ref={listRef} aria-labelledby={id} className="flex flex-col divide-y divide-line">
          {exams.filter((exam) => !visibleCourse || exam.course === visibleCourse).map((x, i) => (
            <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" data-exam={x.id}>
              <div className="flex min-w-0 flex-1 basis-48 flex-col">
                <span className={cn("text-base font-medium wrap-break-word", x.date < today ? "text-ink-secondary" : "text-ink")}>{x.title}</span>
                <span className="text-sm text-ink-secondary">
                  {[dayName(x.date), x.date < today ? "past" : null, courses.find((c) => c.folder === x.course)?.name ?? x.course].filter(Boolean).join(" · ")}
                </span>
              </div>
              <Button type="button" variant="ghost" size="sm" data-exam-remove={x.id} aria-label={`Remove ${x.title}`} onClick={() => void remove(x, i)}>
                <Icon name="remove" />
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="flex flex-col gap-2 border-t border-line pt-3" aria-labelledby={`${id}-add`} noValidate>
        <h4 id={`${id}-add`} className="text-sm font-semibold text-ink-secondary">
          Add an exam
        </h4>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-base text-ink">
            Name
            <Input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Test 1" maxLength={120} aria-invalid={!!err("title") || undefined} aria-describedby={err("title")} data-exam-title="" />
          </label>
          <label className="flex flex-col gap-1 text-base text-ink">
            Date
            <Input ref={dateRef} type="date" value={date} min={today} onChange={(e) => setDate(e.target.value)} aria-invalid={!!err("date") || undefined} aria-describedby={err("date")} className="w-auto" data-exam-date="" />
          </label>
          {courses.length > 0 && (
            <label className="flex min-w-0 flex-col gap-1 text-base text-ink">
              Course
              <NativeSelect value={course} onChange={(e) => setCourse(e.target.value)} className="w-auto max-w-full" data-exam-course="">
                <option value="">Not tied to a course</option>
                {courses.map((c) => (
                  <option key={c.folder} value={c.folder}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          )}
          <Button type="submit" data-exam-add="">
            <Icon name="plus" />
            Add exam
          </Button>
        </div>
        {problem && (
          <p id={`${id}-err`} role="alert" className="flex items-center gap-1.5 text-sm text-danger-ink">
            <Icon name="error" className="size-(--ph-icon-size-sm)" />
            {problem.text}
          </p>
        )}
      </form>
    </WorkspaceSection>
  );
}

function ComingUp({ space, items }: { space: string; items: Upcoming[] | null }) {
  const id = useId();
  const hidden = hiddenCourses(useCourseReach(space), ["overview", "assignments"]);
  const shown = (items ?? []).slice(0, 12);
  return (
    <WorkspaceSection title="Agenda" titleId={id} className="gap-2 pt-3" data-plan-upcoming="">
      {items === null ? (
        <p className="text-base text-ink-secondary">Loading…</p>
      ) : shown.length === 0 && hidden ? (
        <NoCourseAccess why={hidden} part="assignments" />
      ) : shown.length === 0 ? (
        <p className="text-sm text-ink-secondary">Nothing due.</p>
      ) : (
        <ul aria-labelledby={id} className="flex flex-col divide-y divide-line">
          {shown.map((u) => (
            <li key={`${u.link}-${u.due}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <div className="flex min-w-0 flex-1 basis-48 flex-col">
                <span className="text-base font-medium text-ink wrap-break-word">{u.title}</span>
                <span className="text-sm text-ink-secondary">
                  {u.course} · due {new Date(u.due).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                </span>
              </div>
              {u.link && <Button type="button" variant="ghost" size="sm" onClick={() => void openFile(space, u.link.split("#")[0])} aria-label={`Details of ${u.title}`}>
                <Icon name="file-text" />
                Details
              </Button>}
            </li>
          ))}
        </ul>
      )}
      {items && items.length > shown.length && <p className="text-sm text-ink-secondary">And {items.length - shown.length} more later.</p>}
    </WorkspaceSection>
  );
}

function Schedule({
  space,
  plan,
  st,
  done,
  onState,
  onToggle,
  saved,
}: {
  space: string;
  plan: ReturnType<typeof makePlan>;
  st: PlanState;
  done: Set<string>;
  onState: (s: PlanState) => void;
  onToggle: (s: Session, on: boolean) => void;
  saved: string;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  const days = all ? plan.days : plan.days.slice(0, 7);
  return (
    <WorkspaceSection
      title="Schedule"
      titleId={id}
      data-plan-schedule=""
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {saved && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void openFile(space, saved)} data-plan-open="">
              <Icon name="file-text" />
              Open plan.md
            </Button>
          )}
        </div>
      }
    >
      <Details summary="Schedule settings">
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-semibold text-ink-secondary">Days you study</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {WEEK_ORDER.map((d) => {
            const on = st.studyDays.includes(d);
            const only = on && st.studyDays.length === 1;
            return (
              <label key={d} className="flex min-h-(--ph-target-min) items-center gap-1.5 text-base text-ink">
                <Checkbox
                  checked={on}
                  aria-disabled={only || undefined}
                  onChange={(e) => {
                    if (only) {
                      announce("Keep at least one day to study on.");
                      return;
                    }
                    onState({ ...st, studyDays: e.target.checked ? [...st.studyDays, d] : st.studyDays.filter((x) => x !== d) });
                  }}
                  data-plan-day={d}
                />
                {WEEKDAYS[d]}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-base text-ink">
        <label className="flex items-center gap-1.5">
          At most
          <NativeSelect value={st.sessionsPerDay} onChange={(e) => onState({ ...st, sessionsPerDay: Number(e.target.value) })} className="w-auto" data-plan-per-day="">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </NativeSelect>
          sessions a day
        </label>
        <label className="flex items-center gap-1.5">
          of
          <NativeSelect value={st.sessionMinutes} onChange={(e) => onState({ ...st, sessionMinutes: Number(e.target.value) })} className="w-auto">
            {[...new Set([15, 25, 30, 45, 60, 90, st.sessionMinutes])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} minutes
                </option>
              ))}
          </NativeSelect>
        </label>
      </div>
      </Details>
      {plan.unplaced.length > 0 && (
        <p className="flex items-start gap-2 rounded-lg bg-warning-soft px-3 py-2 text-base text-warning-ink" data-plan-unplaced="">
          <Icon name="warning" className="mt-0.5 shrink-0" />
          <span>
            {plan.unplaced.length === 1 ? "One session doesn’t fit" : `${plan.unplaced.length} sessions don’t fit`} before {plan.unplaced.length === 1 ? "its date" : "their dates"}. Add a study day or allow more sessions a day.
          </span>
        </p>
      )}
      {plan.days.length === 0 ? (
        <p className="text-base text-ink-secondary">Nothing to plan yet. Add an exam, or import courses with due dates.</p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Schedule by day" data-plan-days="">
          {days.map((d) => (
            <li key={d.day} className="flex flex-col">
              <h4 className="text-base font-semibold text-ink">{dayName(d.day)}</h4>
              <ul className="flex flex-col divide-y divide-line">
                {d.sessions.map((s) => (
                  <SessionRow key={s.id} space={space} s={s} done={done.has(s.id)} onToggle={onToggle} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {plan.days.length > 7 && (
        <div>
          <Button type="button" variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll(!all)}>
            <Icon name={all ? "chevron-up" : "chevron-down"} />
            {all ? "Show the next week only" : `Show all ${plan.days.length} days`}
          </Button>
        </div>
      )}
    </WorkspaceSection>
  );
}
