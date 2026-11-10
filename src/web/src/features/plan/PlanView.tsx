/**
 * Plan for one space: what's due and the exams coming up first, then the
 * schedule the planner made (review sessions spread before each exam, a work
 * session before each deadline) with check-offs and a focus timer, the exams
 * you add, and the plan as a markdown file.
 */
import { AlertTriangleIcon, CalendarDaysIcon, DownloadIcon, ExternalLinkIcon, FileTextIcon, GraduationCapIcon, LayersIcon, PlusIcon, Settings2Icon, TimerIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { courseMatches, folderKey } from "../courses/lib/selection";
import { hiddenCourses } from "../courses/lib/reach";
import { announce } from "../courses/shared/announce";
import { useCourseContext } from "../courses/shared/course-context";
import { CourseFilter } from "../courses/shared/CourseFilter";
import { EduPage, EmptyState, ErrorState, LoadingRows, PageHeader, Section } from "../courses/shared/kit";
import { NoCourseAccess } from "../courses/shared/NoCourseAccess";
import { useSitesVersion } from "../courses/shared/signals";
import { studyOverview } from "../study/api";
import { useStudyStore } from "../study/store";
import { planExamsGet, planExamsSet, planSave, planStateGet, planStateSet, planUpcoming, DEFAULT_STATE, type CourseRef, type Exam, type PlanState, type Upcoming } from "./api";
import { FocusTimerButton } from "./FocusTimer";
import { useFocusTimer } from "./lib/focus-timer";
import { addDays, dayName, localDay, makePlan, planMarkdown, weekday, type Session } from "./lib/schedule";

type Data = { courses: CourseRef[]; items: Upcoming[]; exams: Exam[]; state: PlanState; decks: { title: string; course?: string; path: string }[] };
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

export function PlanView({ spaceId }: { spaceId: string }) {
  const space = spaceId;
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const ctx = useCourseContext(space);
  const version = useSitesVersion();
  const today = localDay(Date.now());

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      planUpcoming(space),
      planExamsGet(space),
      planStateGet(space).catch(() => DEFAULT_STATE),
      studyOverview(space).catch(() => ({ decks: [] as { title: string; course?: string; path: string }[] })),
    ]).then(
      ([up, exams, state, overview]) => setData({ courses: up.courses, items: up.items, exams, state, decks: overview.decks }),
      (e) => setError(errorText(e)),
    );
  }, [space]);
  useEffect(() => setData(null), [space]);
  useEffect(load, [load, version]);

  const decksByCourse = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const d of data?.decks ?? []) if (d.course) (out[d.course] ??= []).push(d.title);
    return out;
  }, [data]);
  const input = useMemo(
    () => (data ? { today, exams: data.exams, due: data.items, studyDays: data.state.studyDays, sessionsPerDay: data.state.sessionsPerDay, decks: decksByCourse } : null),
    [data, today, decksByCourse],
  );
  const plan = useMemo(() => (input ? makePlan(input) : null), [input]);

  const sel = ctx.selected;
  const matches = (course: string | undefined) => !sel || courseMatches(course, sel.folder, sel.name);
  const done = new Set(data?.state.done ?? []);

  const setState = async (next: PlanState, undo: PlanState, failText: string) => {
    if (!data) return;
    setData({ ...data, state: next });
    try {
      const s = await planStateSet(space, next);
      setData((d) => (d ? { ...d, state: s } : d));
    } catch (e) {
      setData((d) => (d ? { ...d, state: undo } : d));
      announce(`${failText} ${errorText(e)}`);
    }
  };
  const toggleDone = (s: Session) => {
    if (!data) return;
    const was = data.state;
    const list = done.has(s.id) ? was.done.filter((x) => x !== s.id) : [...was.done, s.id];
    void setState({ ...was, done: list }, was, "That check-off couldn’t be saved.");
  };

  const exportPlan = async () => {
    if (!plan || !input || !data) return;
    try {
      const path = await planSave(space, planMarkdown(plan, input, done, data.state.sessionMinutes));
      setSaved(path);
      announce(`Plan saved to ${path}.`);
    } catch (e) {
      announce(`The plan couldn’t be saved. ${errorText(e)}`);
    }
  };

  const options = (data?.courses ?? []).map((c) => ({ folder: `courses/${folderKey(c.folder)}`, name: c.name }));
  const hidden = hiddenCourses(ctx.reach, ["overview", "assignments"]);

  return (
    <EduPage>
      <PageHeader
        title="Plan"
        meta={dayName(today)}
        actions={
          <>
            {data && <CourseFilter options={options} value={sel?.folder ?? null} onChange={(o) => ctx.select(o)} />}
            <FocusTimerButton />
            {plan && (
              <Button variant="outline" onClick={() => void exportPlan()} data-plan-export="">
                <DownloadIcon aria-hidden />
                Export plan
              </Button>
            )}
          </>
        }
      />
      {saved && <SavedNote space={space} path={saved} />}

      {error ? (
        <ErrorState title="The plan couldn’t be loaded." message={error} onRetry={load} />
      ) : !data || !plan ? (
        <LoadingRows rows={4} label="Loading the plan" />
      ) : (
        <>
          <ComingUp space={space} data={data} today={today} day={day} setDay={setDay} matches={matches} hidden={hidden} />
          <TodaySessions
            space={space}
            day={day ?? today}
            today={today}
            sessions={(plan.days.find((d) => d.day === (day ?? today))?.sessions ?? []).filter((s) => matches(s.course))}
            done={done}
            decks={data.decks}
            onToggle={toggleDone}
          />
          <Schedule
            space={space}
            plan={plan}
            today={today}
            state={data.state}
            done={done}
            decks={data.decks}
            matches={matches}
            onToggle={toggleDone}
            onState={(next) => void setState(next, data.state, "That setting couldn’t be saved.")}
          />
          <Exams space={space} data={data} today={today} matches={matches} onChange={(exams) => setData({ ...data, exams })} />
        </>
      )}
    </EduPage>
  );
}

function SavedNote({ space, path }: { space: string; path: string }) {
  const openFile = useNav((s) => s.openFile);
  return (
    <p className="-mt-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-plan-saved="">
      <FileTextIcon aria-hidden className="size-4" />
      Saved to {path}.
      <Button size="xs" variant="ghost" onClick={() => openFile(path, space)}>
        Open it
      </Button>
    </p>
  );
}

const dueTime = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const examMs = (date: string) => new Date(`${date}T12:00:00`).getTime();

function ComingUp({
  space,
  data,
  today,
  day,
  setDay,
  matches,
  hidden,
}: {
  space: string;
  data: Data;
  today: string;
  day: string | null;
  setDay: (d: string | null) => void;
  matches: (course: string | undefined) => boolean;
  hidden: "none" | "part" | null;
}) {
  const openFile = useNav((s) => s.openFile);
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const agenda = [
    ...data.items.map((u) => ({ kind: "due" as const, key: `${u.link}:${u.title}`, title: u.title, course: u.course, at: u.due, day: localDay(u.due), link: u.link })),
    ...data.exams.map((e) => ({ kind: "exam" as const, key: e.id, title: e.title, course: e.course, at: examMs(e.date), day: e.date, link: undefined as string | undefined })),
  ]
    .filter((x) => x.day >= today && matches(x.course))
    .sort((a, b) => a.at - b.at);
  const inView = agenda.filter((x) => (day ? x.day === day : x.day <= days[6]!));
  const shown = inView.slice(0, 12);
  const busy = new Set(agenda.map((x) => x.day));

  return (
    <Section title={day ? (day === today ? "Due today" : `Due ${dayName(day)}`) : "Coming up this week"}>
      <div role="group" aria-label="Days" className="grid grid-cols-7 gap-1.5">
        {days.map((d) => {
          const pressed = day === d;
          const date = new Date(`${d}T12:00:00`);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={pressed}
              aria-label={`${dayName(d)}${busy.has(d) ? ", something due" : ""}`}
              onClick={() => setDay(pressed ? null : d)}
              className={cn(
                "flex flex-col items-center gap-0.5 rounded-xl border py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                pressed ? "border-primary bg-primary text-primary-foreground" : d === today ? "border-foreground/40 bg-card" : "bg-card hover:bg-accent",
              )}
            >
              <span className={cn("text-xs", pressed ? "text-primary-foreground/85" : "text-muted-foreground")}>{d === today ? "Today" : WEEK[weekday(d)]}</span>
              <span className="text-base font-semibold tabular-nums">{date.getDate()}</span>
              <span aria-hidden className={cn("size-1.5 rounded-full", busy.has(d) ? (pressed ? "bg-primary-foreground" : "bg-primary") : "bg-transparent")} />
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? (
        hidden ? (
          <NoCourseAccess why={hidden} part="assignments" />
        ) : (
          <p className="rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">{day ? "Nothing due that day." : "Nothing due this week."}</p>
        )
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {shown.map((x) => (
            <li key={x.key} className="flex items-center gap-3 px-4 py-3" data-agenda={x.kind}>
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", x.kind === "exam" ? "bg-warning/12 text-warning-foreground" : "bg-muted text-muted-foreground")}>
                {x.kind === "exam" ? <GraduationCapIcon aria-hidden className="size-4" /> : <FileTextIcon aria-hidden className="size-4" />}
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-[0.9375rem] font-medium text-foreground">
                  {x.kind === "exam" && <span className="text-warning-foreground">Exam: </span>}
                  {x.title}
                </span>
                <span className="text-sm text-muted-foreground">
                  {[x.course, x.day === today ? "today" : dayName(x.day), x.kind === "due" ? dueTime(x.at) : ""].filter(Boolean).join(" · ")}
                </span>
              </div>
              {x.link && (
                <Button size="icon-sm" variant="ghost" aria-label={`Details of ${x.title}`} onClick={() => openFile(x.link!.replace(/#.*$/, ""), space)}>
                  <ExternalLinkIcon aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {inView.length > shown.length && <p className="text-sm text-muted-foreground">And {inView.length - shown.length} more later.</p>}
    </Section>
  );
}

function SessionRow({
  space,
  s,
  done,
  decks,
  onToggle,
  focusable,
}: {
  space: string;
  s: Session;
  done: boolean;
  decks: Data["decks"];
  onToggle: () => void;
  focusable: boolean;
}) {
  const openFile = useNav((st) => st.openFile);
  const go = useNav((st) => st.go);
  const timer = useFocusTimer();
  const id = useId();
  const deckPath = (title: string) => decks.find((d) => d.title === title && (!s.course || courseMatches(d.course, s.course, s.course)))?.path ?? decks.find((d) => d.title === title)?.path;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" data-session={s.id}>
      <Checkbox id={`${id}-c`} checked={done} onCheckedChange={onToggle} aria-describedby={`${id}-meta`} />
      <div className="flex min-w-0 flex-1 basis-56 flex-col">
        <label htmlFor={`${id}-c`} className={cn("text-[0.9375rem] font-medium", done ? "text-muted-foreground line-through" : "text-foreground")}>
          {s.title}
        </label>
        <span id={`${id}-meta`} className="text-sm text-muted-foreground">
          {[s.course, s.kind === "work" ? `due ${dayName(s.target)}` : `exam ${dayName(s.target)}`].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 ps-7 max-sm:basis-full sm:ps-0">
        {s.decks.slice(0, 2).map((d) => {
          const path = deckPath(d);
          return (
            <Button
              key={d}
              size="sm"
              variant="ghost"
              disabled={!path}
              onClick={() => {
                if (!path) return;
                useStudyStore.getState().show(space, { kind: "session", paths: [path], title: d, dueOnly: false });
                go({ kind: "study" }, space);
              }}
            >
              <LayersIcon aria-hidden />
              {d}
            </Button>
          );
        })}
        {s.link && (
          <Button size="icon-sm" variant="ghost" aria-label={`Details of ${s.title}`} onClick={() => openFile(s.link!.replace(/#.*$/, ""), space)}>
            <ExternalLinkIcon aria-hidden />
          </Button>
        )}
        {focusable && !done && (
          <Button size="sm" variant="outline" disabled={timer.running} onClick={() => timer.start(s.title)}>
            <TimerIcon aria-hidden />
            Focus
          </Button>
        )}
      </div>
    </li>
  );
}

function TodaySessions({
  space,
  day,
  today,
  sessions,
  done,
  decks,
  onToggle,
}: {
  space: string;
  day: string;
  today: string;
  sessions: Session[];
  done: Set<string>;
  decks: Data["decks"];
  onToggle: (s: Session) => void;
}) {
  const left = sessions.filter((s) => !done.has(s.id)).length;
  return (
    <Section
      title={day === today ? "Study today" : `Study on ${dayName(day)}`}
      description={sessions.length ? (left ? `${left} of ${sessions.length} left` : "All done") : undefined}
    >
      {sessions.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-3.5 text-sm text-muted-foreground">No study sessions planned {day === today ? "today" : "that day"}.</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border bg-card">
          {sessions.map((s) => (
            <SessionRow key={s.id} space={space} s={s} done={done.has(s.id)} decks={decks} onToggle={() => onToggle(s)} focusable={day === today} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function Schedule({
  space,
  plan,
  today,
  state,
  done,
  decks,
  matches,
  onToggle,
  onState,
}: {
  space: string;
  plan: ReturnType<typeof makePlan>;
  today: string;
  state: PlanState;
  done: Set<string>;
  decks: Data["decks"];
  matches: (c: string | undefined) => boolean;
  onToggle: (s: Session) => void;
  onState: (s: PlanState) => void;
}) {
  const [open, setOpen] = useState(false);
  const end = addDays(today, 13);
  const days = plan.days
    .filter((d) => d.day > today && d.day <= end)
    .map((d) => ({ ...d, sessions: d.sessions.filter((s) => matches(s.course)) }))
    .filter((d) => d.sessions.length);
  const unplaced = plan.unplaced.filter((u) => u.target <= addDays(today, 28));
  const id = useId();
  const minuteItems = [...new Set([15, 25, 30, 45, 60, 90, state.sessionMinutes])].sort((a, b) => a - b).map((m) => ({ value: String(m), label: `${m} minutes` }));
  const countItems = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }));
  return (
    <Section
      title="Schedule"
      description="Review spread before each exam, and a work session the day before each deadline."
      actions={
        <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={`${id}-settings`} onClick={() => setOpen(!open)}>
          <Settings2Icon aria-hidden />
          Study days and times
        </Button>
      }
    >
      {open && (
        <div id={`${id}-settings`} className="flex flex-col gap-4 rounded-xl border bg-card p-4" data-plan-settings="">
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Days you study</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {MONDAY_FIRST.map((d) => {
                const on = state.studyDays.includes(d);
                const last = on && state.studyDays.length === 1;
                return (
                  <Label key={d} className="flex items-center gap-2 text-sm font-normal">
                    <Checkbox
                      checked={on}
                      aria-disabled={last || undefined}
                      onCheckedChange={(v) => {
                        if (last) return announce("Keep at least one day to study on.");
                        onState({ ...state, studyDays: v ? [...state.studyDays, d] : state.studyDays.filter((x) => x !== d) });
                      }}
                    />
                    {WEEK[d]}
                  </Label>
                );
              })}
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-n`} className="text-sm font-normal text-muted-foreground">
                Sessions a day, at most
              </Label>
              <Select items={countItems} value={String(state.sessionsPerDay)} onValueChange={(v) => v && onState({ ...state, sessionsPerDay: Number(v) })}>
                <SelectTrigger id={`${id}-n`} size="sm" className="w-24 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {countItems.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-m`} className="text-sm font-normal text-muted-foreground">
                Each session
              </Label>
              <Select items={minuteItems} value={String(state.sessionMinutes)} onValueChange={(v) => v && onState({ ...state, sessionMinutes: Number(v) })}>
                <SelectTrigger id={`${id}-m`} size="sm" className="w-36 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {minuteItems.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                      {i.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        </div>
      )}
      {unplaced.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warning/32 bg-warning-surface px-4 py-3 text-sm text-warning-foreground" data-plan-unplaced="">
          <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          {unplaced.length === 1 ? "1 session didn’t fit" : `${unplaced.length} sessions didn’t fit`} before {unplaced.length === 1 ? "its date" : "their dates"}: {unplaced.slice(0, 3).map((u) => u.title).join("; ")}
          {unplaced.length > 3 ? "…" : "."} Add a study day or allow more sessions a day.
        </p>
      )}
      {days.length === 0 ? (
        <EmptyState icon={<CalendarDaysIcon />} title="Nothing planned in the next two weeks" description="Add an exam below, or wait for deadlines from your courses; the schedule fills in around them." />
      ) : (
        <ol className="flex flex-col gap-4">
          {days.map((d) => (
            <li key={d.day} className="flex flex-col gap-2">
              <h3 className="text-sm font-medium text-muted-foreground">{dayName(d.day)}</h3>
              <ul className="divide-y overflow-hidden rounded-xl border bg-card">
                {d.sessions.map((s) => (
                  <SessionRow key={s.id} space={space} s={s} done={done.has(s.id)} decks={decks} onToggle={() => onToggle(s)} focusable={false} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function Exams({ space, data, today, matches, onChange }: { space: string; data: Data; today: string; matches: (c: string | undefined) => boolean; onChange: (e: Exam[]) => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [course, setCourse] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const exams = data.exams.filter((e) => matches(e.course));
  const NONE = "\u0000none";
  const courseItems = [{ value: NONE, label: "Not tied to a course" }, ...data.courses.map((c) => ({ value: c.folder, label: c.name }))];

  const save = async (next: Exam[]) => {
    try {
      const cleaned = await planExamsSet(space, next);
      onChange(cleaned);
      return true;
    } catch (e) {
      setProblem(errorText(e));
      return false;
    }
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setProblem("Give the exam a name, like “Test 1”.");
      titleRef.current?.focus();
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setProblem("Choose the exam’s date.");
      return;
    }
    setProblem(null);
    const exam: Exam = { id: `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: title.trim().slice(0, 120), date, ...(course ? { course } : {}) };
    if (await save([...data.exams, exam])) {
      announce(`${exam.title} added for ${dayName(date)}.`);
      setTitle("");
      setDate("");
      titleRef.current?.focus();
    }
  };

  return (
    <Section title="Exams">
      {exams.length > 0 && (
        <ul ref={listRef} className="divide-y overflow-hidden rounded-xl border bg-card">
          {exams.map((e, i) => {
            const past = e.date < today;
            return (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5" data-exam={e.id}>
                <GraduationCapIcon aria-hidden className={cn("size-4 shrink-0", past ? "text-muted-foreground" : "text-warning-foreground")} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("text-[0.9375rem] font-medium", past ? "text-muted-foreground" : "text-foreground")}>{e.title}</span>
                  <span className="text-sm text-muted-foreground">{[dayName(e.date), e.course, past ? "past" : ""].filter(Boolean).join(" · ")}</span>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${e.title}`}
                  onClick={async () => {
                    if (await save(data.exams.filter((x) => x.id !== e.id))) {
                      announce(`${e.title} removed.`);
                      requestAnimationFrame(() => {
                        const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("button[aria-label^='Remove']");
                        (buttons?.[Math.min(i, (buttons?.length ?? 1) - 1)] ?? titleRef.current)?.focus();
                      });
                    }
                  }}
                >
                  <Trash2Icon aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="flex flex-col gap-3 rounded-xl border border-dashed p-4" aria-labelledby={`${id}-h`}>
        <h3 id={`${id}-h`} className="text-sm font-medium text-foreground">
          Add an exam
        </h3>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem_minmax(0,14rem)]">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-t`} className="text-sm font-normal text-muted-foreground">
              Name
            </Label>
            <Input ref={titleRef} id={`${id}-t`} maxLength={120} placeholder="Test 2" value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={problem?.startsWith("Give") || undefined} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-d`} className="text-sm font-normal text-muted-foreground">
              Date
            </Label>
            <Input id={`${id}-d`} type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} nativeInput />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-c`} className="text-sm font-normal text-muted-foreground">
              Course
            </Label>
            <Select items={courseItems} value={course || NONE} onValueChange={(v) => setCourse(v === NONE || v == null ? "" : String(v))}>
              <SelectTrigger id={`${id}-c`} className="min-w-0">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {courseItems.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-destructive-foreground">
            {problem}
          </p>
        )}
        <div>
          <Button type="submit" variant="outline">
            <PlusIcon aria-hidden />
            Add exam
          </Button>
        </div>
      </form>
    </Section>
  );
}
