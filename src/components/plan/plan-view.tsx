import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { fieldClasses, Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import type { Space } from "@/lib/spaces";
import { inTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

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
import { dayName, localDay, makePlan, planMarkdown, type Session } from "./schedule";

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

  const todays = plan.days.find((d) => d.day === today)?.sessions ?? [];
  const dueToday = (upcoming ?? []).filter((u) => localDay(u.due) === today);

  return (
    <section aria-labelledby={headingId} data-plan-view={space.id} className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-5 px-6 pt-6 pb-10">
        <header className="flex flex-col gap-0.5">
          <h2 id={headingId} className="text-xl font-semibold text-ink">
            Study plan
          </h2>
          <p className="text-sm text-ink-secondary">For {space.name}: from your exams and what’s due in your imported courses.</p>
        </header>
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
        <Today space={space.id} sessions={todays} due={dueToday} done={done} onToggle={toggleDone} loading={upcoming === null} />
        <FocusTimer />
        <Exams space={space} exams={exams} courses={courses} onChange={setExams} />
        <ComingUp space={space.id} items={upcoming} />
        <Schedule
          space={space.id}
          plan={plan}
          st={st}
          done={done}
          onState={(s) => void saveState(s)}
          onToggle={toggleDone}
          onSave={() => void save()}
          saved={saved}
        />
      </div>
    </section>
  );
}

function Card({ title, id, children, extra, data }: { title: string; id: string; children: ReactNode; extra?: ReactNode; data: string }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-line bg-raised p-5 shadow-sm" {...{ [`data-plan-${data}`]: "" }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className="text-lg font-semibold text-ink">
          {title}
        </h3>
        {extra}
      </div>
      {children}
    </section>
  );
}

function SessionRow({ space, s, done, onToggle, focus }: { space: string; s: Session; done: boolean; onToggle: (s: Session, on: boolean) => void; focus?: boolean }) {
  const timer = useFocusTimer();
  const id = useId();
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-plan-session={s.id}>
      <input
        id={id}
        type="checkbox"
        checked={done}
        onChange={(e) => onToggle(s, e.target.checked)}
        className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
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
    <Card
      title="Today"
      id={id}
      data="today"
      extra={sessions.length > 0 && <p className="text-sm text-ink-secondary">{left === 0 ? "All done" : `${left} of ${sessions.length} left`}</p>}
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
    </Card>
  );
}

function Exams({ space, exams, courses, onChange }: { space: Space; exams: Exam[]; courses: CourseRef[]; onChange: (e: Exam[]) => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [course, setCourse] = useState("");
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
    <Card title="Exams" id={id} data="exams">
      {exams.length === 0 ? (
        <p className="text-base text-ink-secondary">No exams yet. Add one and the schedule spreads review sessions before it.</p>
      ) : (
        <ul ref={listRef} aria-labelledby={id} className="flex flex-col divide-y divide-line">
          {exams.map((x, i) => (
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
              <select value={course} onChange={(e) => setCourse(e.target.value)} className={cn(fieldClasses, "min-h-(--ph-control-height) w-auto max-w-full px-2")} data-exam-course="">
                <option value="">Not tied to a course</option>
                {courses.map((c) => (
                  <option key={c.folder} value={c.folder}>
                    {c.name}
                  </option>
                ))}
              </select>
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
    </Card>
  );
}

function ComingUp({ space, items }: { space: string; items: Upcoming[] | null }) {
  const id = useId();
  const shown = (items ?? []).slice(0, 12);
  return (
    <Card title="Coming up in your courses" id={id} data="upcoming">
      {items === null ? (
        <p className="text-base text-ink-secondary">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-base text-ink-secondary">Nothing due in your imported courses. Import courses from your school’s course site to see their due dates here.</p>
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
              <Button type="button" variant="ghost" size="sm" onClick={() => void openFile(space, u.link.split("#")[0])} aria-label={`Details of ${u.title}`}>
                <Icon name="file-text" />
                Details
              </Button>
            </li>
          ))}
        </ul>
      )}
      {items && items.length > shown.length && <p className="text-sm text-ink-secondary">And {items.length - shown.length} more later.</p>}
    </Card>
  );
}

function Schedule({
  space,
  plan,
  st,
  done,
  onState,
  onToggle,
  onSave,
  saved,
}: {
  space: string;
  plan: ReturnType<typeof makePlan>;
  st: PlanState;
  done: Set<string>;
  onState: (s: PlanState) => void;
  onToggle: (s: Session, on: boolean) => void;
  onSave: () => void;
  saved: string;
}) {
  const id = useId();
  const [all, setAll] = useState(false);
  const days = all ? plan.days : plan.days.slice(0, 7);
  return (
    <Card
      title="Schedule"
      id={id}
      data="schedule"
      extra={
        <div className="flex flex-wrap items-center gap-2">
          {saved && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void openFile(space, saved)} data-plan-open="">
              <Icon name="file-text" />
              Open plan.md
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onSave} data-plan-save="">
            <Icon name="download" />
            Save as plan.md
          </Button>
        </div>
      }
    >
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-sm font-semibold text-ink-secondary">Days you study</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {WEEK_ORDER.map((d) => {
            const on = st.studyDays.includes(d);
            const only = on && st.studyDays.length === 1;
            return (
              <label key={d} className="flex min-h-(--ph-target-min) items-center gap-1.5 text-base text-ink">
                <input
                  type="checkbox"
                  checked={on}
                  aria-disabled={only || undefined}
                  onChange={(e) => {
                    if (only) {
                      announce("Keep at least one day to study on.");
                      return;
                    }
                    onState({ ...st, studyDays: e.target.checked ? [...st.studyDays, d] : st.studyDays.filter((x) => x !== d) });
                  }}
                  className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
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
          <select value={st.sessionsPerDay} onChange={(e) => onState({ ...st, sessionsPerDay: Number(e.target.value) })} className={cn(fieldClasses, "min-h-(--ph-control-height) w-auto px-2")} data-plan-per-day="">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          sessions a day
        </label>
        <label className="flex items-center gap-1.5">
          of
          <select value={st.sessionMinutes} onChange={(e) => onState({ ...st, sessionMinutes: Number(e.target.value) })} className={cn(fieldClasses, "min-h-(--ph-control-height) w-auto px-2")}>
            {[...new Set([15, 25, 30, 45, 60, 90, st.sessionMinutes])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} minutes
                </option>
              ))}
          </select>
        </label>
      </div>
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
    </Card>
  );
}
