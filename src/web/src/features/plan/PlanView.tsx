import { Exam } from "@phosphor-icons/react";
import { CalendarDaysIcon, FileTextIcon, MinusIcon, PencilIcon, PlusIcon, Settings2Icon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { studyOverview } from "@/features/study/api";
import { useLoad } from "@/features/study/use-load";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { type CourseRef, DEFAULT_STATE, type Exam as PlanExam, type PlanState, planExamsGet, planExamsSet, planSave, planStateGet, planStateSet, planUpcoming, type Upcoming } from "./api";
import { agenda, relDay, shortDay } from "./lib/days";
import { localDay, makePlan, planMarkdown, type PlanInput } from "./lib/schedule";

type Data = { courses: CourseRef[]; items: Upcoming[]; exams: PlanExam[]; state: PlanState; decks: Record<string, string[]> };

const NO_COURSE = "\u0000none";
const DAYS_SHOWN = 7;

/**
 * Plan: deadlines and exams coming up, by day; the exam dates (edited here);
 * and a study schedule made from them on the days chosen, each session
 * checked off as it's done. "Save as note" writes it to study/plan.md.
 */
export function PlanView({ space }: { space: SpaceView }) {
  const data = useLoad<Data>(async () => {
    const [up, exams, state, overview] = await Promise.all([
      planUpcoming(space.id),
      planExamsGet(space.id),
      planStateGet(space.id).catch(() => DEFAULT_STATE),
      studyOverview(space.id).catch(() => null),
    ]);
    const decks: Record<string, string[]> = {};
    for (const d of overview?.decks ?? []) if (d.course) (decks[d.course] ??= []).push(d.title);
    return { courses: up.courses, items: up.items, exams, state, decks };
  }, [space.id]);
  const skeleton = useDelayed(data.loading && !data.data);
  const [saving, setSaving] = useState(false);
  const today = localDay(Date.now());
  const d = data.data;

  const input: PlanInput | null = useMemo(
    () =>
      d
        ? { today, exams: d.exams, due: d.items, studyDays: d.state.studyDays, sessionsPerDay: d.state.sessionsPerDay, decks: d.decks }
        : null,
    [d, today],
  );
  const plan = useMemo(() => (input ? makePlan(input) : null), [input]);
  const days = useMemo(() => (d ? agenda(d.items, d.exams, today) : []), [d, today]);

  const setState = async (next: PlanState) => {
    const prev = d?.state;
    data.setData((x) => x && { ...x, state: next });
    try {
      const saved = await planStateSet(space.id, next);
      data.setData((x) => x && { ...x, state: saved });
    } catch (e) {
      data.setData((x) => x && prev && { ...x, state: prev });
      toast.error("Couldn’t save the schedule", cleanMessage(e));
    }
  };
  const setExams = async (exams: PlanExam[]) => {
    const saved = await planExamsSet(space.id, exams);
    data.setData((x) => x && { ...x, exams: saved });
  };

  const save = async () => {
    if (!plan || !input || !d) return;
    setSaving(true);
    try {
      const path = await planSave(space.id, planMarkdown(plan, input, new Set(d.state.done), d.state.sessionMinutes));
      toast.show({ type: "success", title: "Plan saved", description: path, action: { label: "Open", onClick: () => useNav.getState().openFile(space.id, path) } });
    } catch (e) {
      toast.error("Couldn’t save the plan", cleanMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const nothing = d && !d.items.length && !d.exams.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title="Plan"
        actions={
          d && !nothing ? (
            <Button size="xs" variant="outline" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner size="xs" /> : <FileTextIcon />}
              {saving ? "Saving…" : "Save as note"}
            </Button>
          ) : null
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container mx-auto w-full max-w-5xl px-4 py-6">
          {data.error ? <SurfaceError title="Couldn’t load your plan" message={cleanMessage(data.error)} onRetry={data.reload} /> : null}
          {skeleton ? <PlanSkeleton /> : null}
          {nothing ? (
            <NothingYet courses={d.courses} onAdd={setExams} />
          ) : d && plan ? (
            <div className="grid gap-6 @[52rem]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
              <div className="flex min-w-0 flex-col gap-6">
                <Section title="Coming up" count={days.reduce((n, x) => n + x.items.length, 0)}>
                  {days.length ? (
                    <div className="flex flex-col">
                      {days.map((g) => (
                        <div key={g.day} className="flex gap-3 border-t py-2 first:border-t-0 first:pt-0">
                          <DayLabel day={g.day} today={today} />
                          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            {g.items.map((i) =>
                              i.kind === "exam" ? (
                                <ItemRow key={`e${i.id}`} icon={<Exam />} title={i.title} course={i.course} trailing={<span className="font-medium text-2xs text-primary">Exam</span>} />
                              ) : (
                                <ItemRow
                                  key={`d${i.link}${i.at}`}
                                  icon={<FileTextIcon strokeWidth={1.75} />}
                                  title={i.title}
                                  course={i.course}
                                  onClick={() => useNav.getState().openFile(space.id, i.link.split("#")[0]!)}
                                  trailing={<span className="text-2xs text-muted-foreground tabular-nums">{timeText(i.at)}</span>}
                                />
                              ),
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">Nothing due from your courses. Exams you add show here too.</p>
                  )}
                </Section>
                <ExamsSection exams={d.exams} courses={d.courses} today={today} onSave={setExams} />
              </div>
              <Schedule plan={plan} state={d.state} today={today} onState={(s) => void setState(s)} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const timeText = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function Section({ title, count, actions, children }: { title: string; count?: number; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex h-6 items-center gap-2">
        <h2 className="font-medium text-2xs text-muted-foreground">
          {title}
          {count != null ? <span className="ml-1.5 text-subtle-foreground tabular-nums">{count}</span> : null}
        </h2>
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      </div>
      <div className="rounded-xl border bg-card px-3 py-2.5">{children}</div>
    </section>
  );
}

function DayLabel({ day, today }: { day: string; today: string }) {
  const rel = relDay(day, today);
  return (
    <div className="w-[4.5rem] shrink-0 pt-1 leading-tight">
      <div className={cn("font-medium text-xs tabular-nums", day === today && "text-primary")}>{shortDay(day)}</div>
      <div className="text-2xs text-muted-foreground">{rel}</div>
    </div>
  );
}

function ItemRow({ icon, title, course, trailing, onClick }: { icon: ReactNode; title: string; course?: string; trailing?: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3.5">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col">
        <Truncate className="text-sm">{title}</Truncate>
        {course ? <Truncate className="-mt-0.5 text-2xs text-muted-foreground">{course}</Truncate> : null}
      </div>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </>
  );
  const cls = "flex min-h-7 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left";
  return onClick ? (
    <button type="button" className={cn(cls, "transition-colors hover:bg-accent")} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

// ---- Exams ----

type Draft = { id: string; title: string; course: string; date: string };

function ExamsSection({ exams, courses, today, onSave }: { exams: PlanExam[]; courses: CourseRef[]; today: string; onSave: (exams: PlanExam[]) => Promise<void> }) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const remove = async (e: PlanExam) => {
    try {
      await onSave(exams.filter((x) => x.id !== e.id));
      toast.show({ type: "info", title: `Removed ${e.title}`, action: { label: "Undo", onClick: () => void onSave([...exams]).catch(() => undefined) } });
    } catch (err) {
      toast.error("Couldn’t remove the exam", cleanMessage(err));
    }
  };
  return (
    <Section
      title="Exams"
      count={exams.length}
      actions={
        !editing ? (
          <Button size="xs" variant="ghost-muted" onClick={() => setEditing({ id: "", title: "", course: NO_COURSE, date: "" })}>
            <PlusIcon />
            Add exam
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-0.5">
        {exams.map((e) =>
          editing?.id === e.id ? (
            <ExamForm key={e.id} draft={editing} courses={courses} onCancel={() => setEditing(null)} onSave={(x) => onSave(exams.map((y) => (y.id === e.id ? x : y))).then(() => setEditing(null))} />
          ) : (
            <div key={e.id} className={cn("group flex min-h-8 items-center gap-2 rounded-md px-1.5", e.date < today && "opacity-60")}>
              <span className="w-[4.5rem] shrink-0 font-medium text-xs tabular-nums">{shortDay(e.date)}</span>
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <Truncate className="min-w-0 shrink text-sm">{e.title}</Truncate>
                {e.course ? <Truncate className="min-w-0 flex-1 text-2xs text-muted-foreground">{e.course}</Truncate> : null}
              </div>
              <span className="shrink-0 text-2xs text-muted-foreground tabular-nums group-hover:hidden">{relDay(e.date, today)}</span>
              <div className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
                <Button size="icon-xs" variant="ghost-muted" aria-label={`Edit ${e.title}`} onClick={() => setEditing({ id: e.id, title: e.title, course: e.course ?? NO_COURSE, date: e.date })}>
                  <PencilIcon />
                </Button>
                <Button size="icon-xs" variant="ghost-destructive" aria-label={`Remove ${e.title}`} onClick={() => void remove(e)}>
                  <XIcon />
                </Button>
              </div>
            </div>
          ),
        )}
        {editing && !editing.id ? (
          <ExamForm
            draft={editing}
            courses={courses}
            onCancel={() => setEditing(null)}
            onSave={(x) => onSave([...exams, { ...x, id: `e${Date.now().toString(36)}` }]).then(() => setEditing(null))}
          />
        ) : null}
        {!exams.length && !editing ? <p className="py-1 text-muted-foreground text-xs">Add your exam dates to plan review sessions before each one.</p> : null}
      </div>
    </Section>
  );
}

function ExamForm({ draft, courses, onSave, onCancel }: { draft: Draft; courses: CourseRef[]; onSave: (e: PlanExam) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title?: string; date?: string; save?: string }>({});
  const submit = async () => {
    const errs = { title: d.title.trim() ? undefined : "Name the exam.", date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? undefined : "Pick a date." };
    setError(errs);
    if (errs.title || errs.date) return;
    setBusy(true);
    try {
      await onSave({ id: d.id, title: d.title.trim(), date: d.date, ...(d.course !== NO_COURSE ? { course: d.course } : {}) });
    } catch (e) {
      setError({ save: cleanMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="my-1 flex flex-col gap-2 rounded-lg border bg-muted/30 p-2">
      <div className="grid grid-cols-[minmax(0,1fr)_9.5rem] gap-2">
        <Input
          size="compact"
          autoFocus
          placeholder="Exam name, e.g. Midterm 2"
          value={d.title}
          aria-invalid={error.title ? true : undefined}
          onChange={(e) => setD({ ...d, title: e.target.value })}
          onKeyDown={(e) => (e.key === "Enter" ? void submit() : e.key === "Escape" ? onCancel() : undefined)}
        />
        <Input size="compact" type="date" className="tabular-nums" value={d.date} aria-invalid={error.date ? true : undefined} onChange={(e) => setD({ ...d, date: e.target.value })} />
      </div>
      <Select value={d.course} onValueChange={(v) => setD({ ...d, course: (v as string) ?? NO_COURSE })}>
        <SelectTrigger size="sm">
          <SelectValue>{(v: string) => (v === NO_COURSE ? "No course" : v)}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={NO_COURSE}>No course</SelectItem>
          {courses.map((c) => (
            <SelectItem key={c.folder} value={c.name}>
              <span className="truncate">{c.name}</span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <FieldError>{error.title ?? error.date ?? error.save}</FieldError>
      <div className="flex justify-end gap-1.5">
        <Button size="xs" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="xs" disabled={busy} onClick={() => void submit()}>
          {busy ? <Spinner size="xs" /> : null}
          {busy ? "Saving…" : draft.id ? "Save" : "Add exam"}
        </Button>
      </div>
    </div>
  );
}

// ---- Schedule ----

const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const WEEK_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Schedule({ plan, state, today, onState }: { plan: ReturnType<typeof makePlan>; state: PlanState; today: string; onState: (s: PlanState) => void }) {
  const [all, setAll] = useState(false);
  const done = new Set(state.done);
  const shown = all ? plan.days : plan.days.slice(0, DAYS_SHOWN);
  const total = plan.days.reduce((n, x) => n + x.sessions.length, 0);
  const checked = plan.days.reduce((n, x) => n + x.sessions.filter((s) => done.has(s.id)).length, 0);
  const toggle = (id: string) => onState({ ...state, done: done.has(id) ? state.done.filter((x) => x !== id) : [...state.done, id] });
  return (
    <Section
      title="Study schedule"
      count={undefined}
      actions={
        <>
          {total ? (
            <span className="mr-1 text-2xs text-muted-foreground tabular-nums">
              {checked}/{total} done
            </span>
          ) : null}
          <ScheduleSettings state={state} onState={onState} />
        </>
      }
    >
      {plan.unplaced.length ? (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-surface px-2.5 py-2 text-warning-foreground text-xs">
          <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            {plan.unplaced.length === 1 ? "1 session doesn’t" : `${plan.unplaced.length} sessions don’t`} fit before {plan.unplaced.length === 1 ? "its" : "their"} date. Add study days or sessions per day.
          </span>
        </div>
      ) : null}
      {shown.length ? (
        <div className="flex flex-col">
          {shown.map((day) => (
            <div key={day.day} className="flex gap-3 border-t py-2 first:border-t-0 first:pt-0.5">
              <DayLabel day={day.day} today={today} />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                {day.sessions.map((s) => {
                  const isDone = done.has(s.id);
                  return (
                    <label key={s.id} className="flex min-h-7 cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 transition-colors hover:bg-accent">
                      <Checkbox checked={isDone} onCheckedChange={() => toggle(s.id)} />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <Truncate className={cn("text-sm", isDone && "text-muted-foreground line-through decoration-subtle-foreground")}>{s.title}</Truncate>
                        {s.course || s.decks.length ? (
                          <Truncate className="-mt-0.5 text-2xs text-muted-foreground">{[s.course, s.decks.length ? `Decks: ${s.decks.join(", ")}` : ""].filter(Boolean).join(" · ")}</Truncate>
                        ) : null}
                      </div>
                      <span className={cn("shrink-0 text-2xs tabular-nums", s.kind === "final-review" ? "font-medium text-primary" : "text-muted-foreground")}>
                        {s.kind === "work" ? "Work" : s.kind === "final-review" ? "Final review" : "Review"}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          {plan.days.length > DAYS_SHOWN ? (
            <button type="button" className="mt-1 self-start rounded-md px-1.5 py-1 font-medium text-muted-foreground text-xs tabular-nums hover:text-foreground" onClick={() => setAll((a) => !a)}>
              {all ? "Show fewer days" : `Show ${plan.days.length - DAYS_SHOWN} more days`}
            </button>
          ) : null}
        </div>
      ) : (
        <p className="py-1 text-muted-foreground text-xs">Nothing to schedule in the next four weeks.</p>
      )}
    </Section>
  );
}

function ScheduleSettings({ state, onState }: { state: PlanState; onState: (s: PlanState) => void }) {
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
        <Settings2Icon />
        Days and sessions
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-72">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <span className="font-medium text-xs">Study on</span>
            <div className="flex gap-1">
              {WEEK.map((w, i) => {
                const on = state.studyDays.includes(i);
                return (
                  <button
                    key={WEEK_NAMES[i]}
                    type="button"
                    aria-label={WEEK_NAMES[i]}
                    aria-pressed={on}
                    onClick={() => {
                      const next = on ? state.studyDays.filter((x) => x !== i) : [...state.studyDays, i].sort();
                      if (next.length) onState({ ...state, studyDays: next });
                    }}
                    className={cn("flex size-7 items-center justify-center rounded-md border font-medium text-xs transition-colors", on ? "border-primary/40 bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent")}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-xs">Sessions a day</span>
            <div className="flex items-center gap-1">
              <Button size="icon-xs" variant="outline" aria-label="Fewer sessions" disabled={state.sessionsPerDay <= 1} onClick={() => onState({ ...state, sessionsPerDay: state.sessionsPerDay - 1 })}>
                <MinusIcon />
              </Button>
              <span className="w-6 text-center text-sm tabular-nums">{state.sessionsPerDay}</span>
              <Button size="icon-xs" variant="outline" aria-label="More sessions" disabled={state.sessionsPerDay >= 8} onClick={() => onState({ ...state, sessionsPerDay: state.sessionsPerDay + 1 })}>
                <PlusIcon />
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-xs">Minutes each</span>
            <ToggleGroup value={[String(state.sessionMinutes)]} onValueChange={(v: unknown[]) => v[0] && onState({ ...state, sessionMinutes: Number(v[0]) })}>
              {[15, 25, 45, 60].map((m) => (
                <ToggleGroupItem key={m} value={String(m)} className="text-xs tabular-nums">
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function NothingYet({ courses, onAdd }: { courses: CourseRef[]; onAdd: (exams: PlanExam[]) => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  return (
    <Empty className="min-h-[60vh]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CalendarDaysIcon />
        </EmptyMedia>
        <EmptyTitle>Nothing coming up</EmptyTitle>
        <EmptyDescription>{courses.length ? "No deadlines from your courses yet. Add an exam to plan review sessions before it." : "Add an exam to plan review sessions before it. Imported courses add their deadlines here."}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-md">
        {adding ? (
          <div className="w-full text-left">
            <ExamForm draft={{ id: "", title: "", course: NO_COURSE, date: "" }} courses={courses} onCancel={() => setAdding(false)} onSave={(e) => onAdd([{ ...e, id: `e${Date.now().toString(36)}` }])} />
          </div>
        ) : (
          <Button size="sm" onClick={() => setAdding(true)}>
            <PlusIcon />
            Add exam
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}

function PlanSkeleton() {
  const block = (rows: number[], key: string) => (
    <div key={key} className="flex flex-col gap-2">
      <Skeleton className="my-2 h-2 w-16 animate-none" />
      <div className="flex flex-col gap-3 rounded-xl border px-3 py-3">
        {rows.map((n, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex w-[4.5rem] flex-col gap-1">
              <Skeleton className="h-2.5 w-14 animate-none" />
              <Skeleton className="h-2 w-10 animate-none" />
            </div>
            <div className="flex flex-1 flex-col gap-2">
              {Array.from({ length: n }, (_, k) => (
                <Skeleton key={k} className="h-2.5 animate-none" style={{ width: ["62%", "48%", "71%"][(i + k) % 3] }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="grid gap-6 motion-safe:animate-skeleton @[52rem]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]" aria-hidden>
      <div className="flex flex-col gap-6">
        {block([2, 1, 2], "a")}
        {block([1, 1], "b")}
      </div>
      {block([3, 2, 3, 1], "c")}
    </div>
  );
}
