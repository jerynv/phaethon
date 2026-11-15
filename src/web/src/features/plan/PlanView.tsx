import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { chartColor } from "@/components/ui/stacked-bar";
import { ArtEmpty } from "@/features/courses/components/ArtEmpty";
import { studyOverview } from "@/features/study/api";
import { useLoad } from "@/features/study/use-load";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { type CourseRef, DEFAULT_STATE, type Exam as PlanExam, type PlanState, planExamsGet, planExamsSet, planSave, planStateGet, planStateSet, planUpcoming, type Upcoming } from "./api";
import { DateField } from "./components/DateField";
import { agenda, counts, type Entry, type Filter, relDay, type Show, shortDay, timeline } from "./lib/days";
import { localDay, makePlan, planMarkdown, type PlanInput } from "./lib/schedule";

type Data = { courses: CourseRef[]; items: Upcoming[]; exams: PlanExam[]; state: PlanState; decks: Record<string, string[]> };
/** The exam being added (`id` empty) or edited. */
type Draft = { id: string; title: string; course: string; date: string };

const NO_COURSE = "\u0000none";
const DAYS_SHOWN = 7;

/**
 * Plan (docs/UI-REBUILD.md › Screens › Plan; refs 7274, dc42, e0fb): one
 * agenda of deadlines, exams and study sessions by day, filtered from a list
 * on the left (kinds, courses), with today on an art card at the top. Exams
 * are added and edited in a side panel; the schedule's days and sessions are
 * set from the left list. "Save as note" writes the plan to study/plan.md.
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
  const [filter, setFilter] = useState<Filter>({ show: "all", course: null });
  const [editing, setEditing] = useState<Draft | null>(null);
  const today = localDay(Date.now());
  const d = data.data;

  const input: PlanInput | null = useMemo(
    () => (d ? { today, exams: d.exams, due: d.items, studyDays: d.state.studyDays, sessionsPerDay: d.state.sessionsPerDay, decks: d.decks } : null),
    [d, today],
  );
  const plan = useMemo(() => (input ? makePlan(input) : null), [input]);
  const dueDays = useMemo(() => (d ? agenda(d.items, d.exams, today) : []), [d, today]);
  const everything = useMemo(() => (plan ? timeline(dueDays, plan.days) : []), [dueDays, plan]);
  const shown = useMemo(() => (plan ? timeline(dueDays, plan.days, filter) : []), [dueDays, plan, filter]);
  const colors = useMemo(() => {
    const names = [...new Set([...(d?.courses.map((c) => c.name) ?? []), ...(d?.exams.flatMap((e) => (e.course ? [e.course] : [])) ?? [])])];
    return new Map(names.map((n, i) => [n, chartColor(i)]));
  }, [d]);

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
    // Detected exams are the course's, not ours to save; the core lists them again with the saved ones.
    const saved = await planExamsSet(space.id, exams.filter((e) => !e.detected));
    const detected = (await planExamsGet(space.id)).filter((e) => e.detected);
    data.setData((x) => x && { ...x, exams: [...saved, ...detected] });
  };
  const removeExam = async (e: PlanExam) => {
    if (!d) return;
    const before = d.exams;
    try {
      await setExams(before.filter((x) => x.id !== e.id));
      toast.show({ type: "info", title: `Removed ${e.title}`, action: { label: "Undo", onClick: () => void setExams([...before]).catch(() => undefined) } });
    } catch (err) {
      toast.error("Couldn’t remove the exam", cleanMessage(err));
    }
  };
  const saveExam = async (x: PlanExam) => {
    if (!d) return;
    const own = x.id && !x.id.startsWith("found:");
    await setExams(own ? d.exams.map((y) => (y.id === x.id ? x : y)) : [...d.exams, { ...x, id: `e${Date.now().toString(36)}`, detected: undefined }]);
    toast.success(x.id ? `Saved ${x.title}` : `Added ${x.title}`);
    setEditing(null);
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

  const toggle = (id: string) => {
    if (!d) return;
    const done = d.state.done.includes(id);
    void setState({ ...d.state, done: done ? d.state.done.filter((x) => x !== id) : [...d.state.done, id] });
  };
  const todayAll = everything.find((g) => g.day === today)?.entries ?? [];
  const todaySessions = todayAll.flatMap((e) => (e.kind === "session" ? [e.session.id] : []));
  const addExam = () => setEditing({ id: "", title: "", course: filter.course ?? NO_COURSE, date: "" });
  const nothing = d && !d.items.length && !d.exams.length;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Header
        actions={
          d && !nothing ? (
            <Button size="sm" variant="outline" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner size="sm" /> : <Icon icon={icons.fileText} />}
              {saving ? "Saving…" : "Save as note"}
            </Button>
          ) : null
        }
      />
      <div className="page-scroll min-h-0 flex-1">
        <div className="@container/page mx-auto flex min-h-full w-full max-w-(--page-wide-max-width) flex-col px-8 pt-10 pb-16 @max-3xl/page:px-6">
          {data.error ? <SurfaceError title="Couldn’t load your plan" message={cleanMessage(data.error)} onRetry={data.reload} /> : null}
          {skeleton ? <PlanSkeleton /> : null}
          {nothing ? (
            <ArtEmpty
              palette="dawn"
              seed="plan-empty"
              title="Nothing coming up"
              description={d.courses.length ? "No deadlines from your courses yet. Add an exam to plan review sessions before it." : "Add an exam to plan review sessions before it. Imported courses add their deadlines here."}
            >
              <Button size="sm" onClick={addExam}>
                <Icon icon={icons.add} />
                Add exam
              </Button>
            </ArtEmpty>
          ) : d && plan ? (
            <div className="grid gap-8 @3xl/page:grid-cols-[16rem_minmax(0,1fr)]">
              <Filters
                filter={filter}
                onFilter={setFilter}
                all={everything}
                colors={colors}
                exams={d.exams}
                today={today}
                state={d.state}
                onState={(s) => void setState(s)}
                onAddExam={addExam}
                onEditExam={(e) => setEditing({ id: e.id, title: e.title, course: e.course ?? NO_COURSE, date: e.date })}
                onRemoveExam={(e) => void removeExam(e)}
              />
              <div className="flex min-w-0 flex-col gap-6 @max-3xl/page:order-first">
                <FilterBar filter={filter} onFilter={setFilter} colors={colors} />
                <Today
                  today={today}
                  entries={shown.find((g) => g.day === today)?.entries ?? []}
                  next={shown.find((g) => g.day > today)}
                  done={d.state.done}
                  colors={colors}
                  sessions={todaySessions.length}
                  checked={todaySessions.filter((id) => d.state.done.includes(id)).length}
                  onToggle={toggle}
                  space={space.id}
                  minutes={d.state.sessionMinutes}
                />
                {plan.unplaced.length ? (
                  <div role="status" className="flex items-start gap-2.5 rounded-xl border border-warning/24 bg-warning/8 px-4 py-3 text-sm text-warning-foreground">
                    <Icon icon={icons.warning} className="mt-0.5 size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      {plan.unplaced.length === 1 ? "1 session doesn’t" : `${plan.unplaced.length} sessions don’t`} fit before {plan.unplaced.length === 1 ? "its" : "their"} date. Add study days or sessions per day.
                    </span>
                  </div>
                ) : null}
                <Agenda days={shown.filter((g) => g.day > today)} today={today} done={d.state.done} colors={colors} onToggle={toggle} space={space.id} filtered={filter.show !== "all" || !!filter.course} minutes={d.state.sessionMinutes} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
      <ExamPanel
        draft={editing}
        courses={d?.courses ?? []}
        onClose={() => setEditing(null)}
        onSave={saveExam}
        onDelete={(id) => {
          const e = d?.exams.find((x) => x.id === id);
          setEditing(null);
          if (e) void removeExam(e);
        }}
      />
    </div>
  );
}

const timeText = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

// ---- The list on the left ----

const SHOW: { value: Show; label: string; icon: IconData }[] = [
  { value: "all", label: "Everything", icon: icons.plan },
  { value: "due", label: "Deadlines", icon: icons.fileText },
  { value: "exam", label: "Exams", icon: icons.flag },
  { value: "session", label: "Study sessions", icon: icons.read },
];
const WEEK = ["S", "M", "T", "W", "T", "F", "S"];
const WEEK_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEK_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sun–Fri", "Mon, Wed, Fri", "Every day". */
function daysText(days: number[]): string {
  const s = [...days].sort();
  if (s.length === 7) return "Every day";
  const run = s.every((x, i) => i === 0 || x === s[i - 1]! + 1);
  return run && s.length > 2 ? `${WEEK_SHORT[s[0]!]}–${WEEK_SHORT[s[s.length - 1]!]}` : s.map((x) => WEEK_SHORT[x]).join(", ");
}

function SideLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mt-6 flex h-7 items-center justify-between px-2 first:mt-0">
      <h3 className="text-subtle-foreground text-xs">{children}</h3>
      {action}
    </div>
  );
}

function SideRow({ selected, onClick, lead, label, trail }: { selected?: boolean; onClick: () => void; lead: ReactNode; label: ReactNode; trail?: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn("flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", selected && "bg-row-selected hover:bg-row-selected")}
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{lead}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trail !== undefined ? <span className="shrink-0 text-2xs text-subtle-foreground tabular-nums">{trail}</span> : null}
    </button>
  );
}

function Filters({
  filter,
  onFilter,
  all,
  colors,
  exams,
  today,
  state,
  onState,
  onAddExam,
  onEditExam,
  onRemoveExam,
}: {
  filter: Filter;
  onFilter: (f: Filter) => void;
  all: { day: string; entries: Entry[] }[];
  colors: Map<string, string>;
  exams: PlanExam[];
  today: string;
  state: PlanState;
  onState: (s: PlanState) => void;
  onAddExam: () => void;
  onEditExam: (e: PlanExam) => void;
  onRemoveExam: (e: PlanExam) => void;
}) {
  const c = counts(all);
  const sorted = [...exams].sort((a, b) => (a.date < b.date ? -1 : 1));
  return (
    <nav aria-label="Filter the plan" className="scroll-quiet flex min-w-0 flex-col @3xl/page:sticky @3xl/page:top-0 @3xl/page:max-h-[calc(100dvh-var(--titlebar-height)-2.5rem)] @3xl/page:self-start @3xl/page:overflow-y-auto">
      {/* Narrow pages filter from the bar above the agenda instead. */}
      <div className="flex flex-col @max-3xl/page:hidden">
        <SideLabel>Show</SideLabel>
        {SHOW.map((s) => (
          <SideRow key={s.value} selected={filter.show === s.value} onClick={() => onFilter({ ...filter, show: s.value })} lead={<Icon icon={s.icon} className="size-4" />} label={s.label} trail={c[s.value] || ""} />
        ))}
        {colors.size ? (
          <>
            <SideLabel>Courses</SideLabel>
            {[...colors].map(([name, color]) => (
              <SideRow
                key={name}
                selected={filter.course === name}
                onClick={() => onFilter({ ...filter, course: filter.course === name ? null : name })}
                lead={<span className="size-2 rounded-full" style={{ backgroundColor: color }} />}
                label={name}
                trail={c.courses.get(name) ?? ""}
              />
            ))}
          </>
        ) : null}
      </div>
      <SideLabel>Exams</SideLabel>
      <AnimatePresence initial={false}>
        {sorted.map((e) => (
          <motion.div
            key={e.id}
            layout="position"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className={cn("group relative flex min-h-12 items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-accent", e.date < today && "opacity-60")}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
              <Icon icon={icons.flag} className="size-4" />
            </span>
            <button type="button" onClick={() => onEditExam(e)} className="flex min-w-0 flex-1 flex-col text-left outline-none after:absolute after:inset-0 focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring" aria-label={`Edit ${e.title}`}>
              <Truncate className="text-sm">{e.title}</Truncate>
              <span className="truncate text-muted-foreground text-xs tabular-nums">
                {shortDay(e.date)} · {relDay(e.date, today).toLowerCase()}
                {e.detected ? " · from the course" : ""}
              </span>
            </button>
            <span className={cn("size-1.5 shrink-0 rounded-full", !e.detected && "group-focus-within:hidden group-hover:hidden")} style={{ backgroundColor: e.course ? colors.get(e.course) : "var(--primary)" }} />
            {e.detected ? null : (
              <Button size="icon-xs" variant="ghost-destructive" aria-label={`Remove ${e.title}`} className="relative z-10 hidden group-focus-within:inline-flex group-hover:inline-flex" onClick={() => onRemoveExam(e)}>
                <Icon icon={icons.delete} />
              </Button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
      {!exams.length ? <p className="px-2 pb-1 text-muted-foreground text-xs">Add exam dates to plan review sessions before each one.</p> : null}
      <button type="button" onClick={onAddExam} className="flex h-8 items-center gap-2.5 rounded-md px-2 text-primary text-sm outline-none hover:bg-primary/6 focus-visible:ring-2 focus-visible:ring-ring">
        <Icon icon={icons.add} className="size-4" />
        Add exam
      </button>
      <SideLabel>Schedule</SideLabel>
      <ScheduleSettings state={state} onState={onState} />
    </nav>
  );
}

/** The left list's Show and Courses as one row over the agenda, for pages too narrow for the list beside it. */
function FilterBar({ filter, onFilter, colors }: { filter: Filter; onFilter: (f: Filter) => void; colors: Map<string, string> }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 @3xl/page:hidden" data-testid="plan-filter-bar">
      <Tabs value={filter.show} onValueChange={(v: Show) => onFilter({ ...filter, show: v })}>
<TabsList aria-label="Show">
        {SHOW.map((s) => (
          <TabsTab key={s.value} value={s.value} className="px-2.5 text-xs">
            {s.value === "session" ? "Sessions" : s.label}
          </TabsTab>
        ))}
      </TabsList>
</Tabs>
      {[...colors].map(([name, color]) => {
        const on = filter.course === name;
        return (
          <button
            key={name}
            type="button"
            aria-pressed={on}
            onClick={() => onFilter({ ...filter, course: on ? null : name })}
            className={cn(
              "flex h-7 max-w-48 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              on ? "border-primary/40 bg-primary/8 text-primary hover:bg-primary/12" : "text-muted-foreground",
            )}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <span className="truncate">{name}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScheduleSettings({ state, onState }: { state: PlanState; onState: (s: PlanState) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button type="button" className="flex min-h-12 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent" />
        }
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
          <Icon icon={icons.mode} className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm">Days and sessions</span>
          <span className="truncate text-muted-foreground text-xs tabular-nums">
            {daysText(state.studyDays)} · {state.sessionsPerDay} a day · {state.sessionMinutes} min
          </span>
        </span>
        <Icon icon={icons.chevronRight} className="size-4 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverPopup align="start" side="right" className="w-76">
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex flex-col gap-2">
            <span className="font-medium text-sm">Study on</span>
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
                    className={cn("flex size-8 items-center justify-center rounded-full border font-medium text-xs transition-colors", on ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent")}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-sm">Sessions a day</span>
            <div className="flex items-center gap-1">
              <Button size="icon-xs" variant="outline" aria-label="Fewer sessions" disabled={state.sessionsPerDay <= 1} onClick={() => onState({ ...state, sessionsPerDay: state.sessionsPerDay - 1 })}>
                <Icon icon={icons.remove} />
              </Button>
              <span className="w-6 text-center text-sm tabular-nums">{state.sessionsPerDay}</span>
              <Button size="icon-xs" variant="outline" aria-label="More sessions" disabled={state.sessionsPerDay >= 8} onClick={() => onState({ ...state, sessionsPerDay: state.sessionsPerDay + 1 })}>
                <Icon icon={icons.add} />
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="font-medium text-sm">Minutes each</span>
            <Tabs value={String(state.sessionMinutes)} onValueChange={(v: string) => onState({ ...state, sessionMinutes: Number(v) })}>
<TabsList aria-label="Minutes each">
              {[15, 25, 45, 60].map((m) => (
                <TabsTab key={m} value={String(m)} className="min-w-0 px-2.5 text-xs tabular-nums">
                  {m}
                </TabsTab>
              ))}
            </TabsList>
</Tabs>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// ---- Today and the days after ----

function Today({
  today,
  entries,
  next,
  done,
  colors,
  sessions,
  checked,
  onToggle,
  space,
  minutes,
}: {
  minutes: number;
  today: string;
  entries: Entry[];
  next?: { day: string; entries: Entry[] };
  done: string[];
  colors: Map<string, string>;
  sessions: number;
  checked: number;
  onToggle: (id: string) => void;
  space: string;
}) {
  const due = entries.filter((e) => e.kind !== "session").length;
  const study = entries.length - due;
  return (
    <Card data-testid="plan-today">
      <div className="flex items-start gap-4 px-5 pt-5 pb-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="font-medium text-base tracking-title">
            Today <span className="font-normal text-muted-foreground">· {shortDay(today)}</span>
          </h2>
          <p className="text-muted-foreground text-sm">{entries.length ? [due ? `${due} due` : null, study ? `${study} to study` : null].filter(Boolean).join(" · ") : "A clear day"}</p>
        </div>
        {sessions ? (
          <div className="flex w-36 shrink-0 flex-col items-end gap-1.5 pt-1">
            <span className="text-muted-foreground text-xs tabular-nums">
              {checked} of {sessions} sessions done
            </span>
            <span className="h-1 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Sessions done" aria-valuemin={0} aria-valuemax={sessions} aria-valuenow={checked}>
              <motion.span className="block h-full rounded-full bg-ink" initial={false} animate={{ width: `${(checked / sessions) * 100}%` }} transition={{ type: "spring", stiffness: 420, damping: 40 }} />
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col px-2 pb-3">
        {entries.length ? (
          entries.map((e) => <AgendaRow key={e.key} entry={e} done={e.kind === "session" && done.includes(e.session.id)} color={e.course ? colors.get(e.course) : undefined} minutes={minutes} onToggle={onToggle} space={space} />)
        ) : (
          <p className="px-3 pb-2 text-muted-foreground text-sm">{next ? `Next up: ${next.entries[0]!.title}, ${relDay(next.day, today).toLowerCase()}.` : "Nothing planned after today either."}</p>
        )}
      </div>
    </Card>
  );
}

function Agenda({
  days,
  today,
  done,
  colors,
  onToggle,
  space,
  filtered,
  minutes,
}: {
  minutes: number;
  days: { day: string; entries: Entry[] }[];
  today: string;
  done: string[];
  colors: Map<string, string>;
  onToggle: (id: string) => void;
  space: string;
  filtered: boolean;
}) {
  const [all, setAll] = useState(false);
  const list = all ? days : days.slice(0, DAYS_SHOWN);
  if (!days.length) return <p className="px-1 text-muted-foreground text-sm">{filtered ? "Nothing like that coming up." : "Nothing else planned in the next four weeks."}</p>;
  return (
    <section aria-label="Coming up" className="flex flex-col gap-1" data-testid="plan-agenda">
      {list.map((g) => (
        <div key={g.day} className="flex flex-col border-t pt-4 pb-3 first:border-t-0 first:pt-0">
          <h3 className="flex h-7 items-baseline gap-2 px-3 text-sm">
            <span className="font-medium tabular-nums">{shortDay(g.day)}</span>
            <span className="text-muted-foreground">{relDay(g.day, today)}</span>
          </h3>
          <div className="flex flex-col">
            {g.entries.map((e) => (
              <AgendaRow key={e.key} entry={e} done={e.kind === "session" && done.includes(e.session.id)} color={e.course ? colors.get(e.course) : undefined} minutes={minutes} onToggle={onToggle} space={space} />
            ))}
          </div>
        </div>
      ))}
      {days.length > DAYS_SHOWN ? (
        <Button size="sm" variant="ghost-muted" className="self-start tabular-nums" onClick={() => setAll((a) => !a)}>
          <Icon icon={all ? icons.chevronUp : icons.chevronDown} />
          {all ? "Show fewer days" : `Show ${days.length - DAYS_SHOWN} more days`}
        </Button>
      ) : null}
    </section>
  );
}

/** One row: a time column (clock times only), a check box for a session or the course's dot, the title over its course, and its kind as a badge. */
function AgendaRow({ entry: e, done, color, minutes, onToggle, space }: { entry: Entry; done: boolean; color?: string; minutes: number; onToggle: (id: string) => void; space: string }) {
  const reduce = useReducedMotion();
  const time = e.kind === "due" ? timeText(e.at) : e.kind === "exam" ? "All day" : "";
  const sub = e.kind === "session" ? [e.course, `${minutes} min`, e.session.decks.length ? `Decks: ${e.session.decks.join(", ")}` : ""].filter(Boolean).join(" · ") : e.course;
  const kind = e.kind === "exam" ? { label: "Exam", info: true } : e.kind === "session" ? { label: e.session.kind === "final-review" ? "Final review" : e.session.kind === "work" ? "Work" : "Review", info: e.session.kind === "final-review" } : null;
  const body = (
    <>
      <span className="w-16 shrink-0 text-muted-foreground text-xs tabular-nums">{time}</span>
      <span className="flex size-4 shrink-0 items-center justify-center">
        {e.kind === "session" ? (
          <Checkbox checked={done} onCheckedChange={() => onToggle(e.session.id)} aria-label={`${e.title} done`} />
        ) : (
          <span className="size-2 rounded-full bg-subtle-foreground" style={color ? { backgroundColor: color } : undefined} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <motion.span animate={{ opacity: done ? 0.6 : 1 }} transition={{ duration: reduce ? 0 : 0.15 }} className="min-w-0">
          <Truncate className={cn("text-sm", done && "text-muted-foreground line-through decoration-subtle-foreground")}>{e.title}</Truncate>
        </motion.span>
        {sub ? (
          <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
            {e.kind === "session" && color ? <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} /> : null}
            <span className="truncate">{sub}</span>
          </span>
        ) : null}
      </span>
      {kind ? (
        <Badge variant={kind.info ? "info" : "secondary"} size="lg">
          {kind.label}
        </Badge>
      ) : (
        <Icon icon={icons.external} className="size-3.5 shrink-0 text-subtle-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      )}
    </>
  );
  const cls = "group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent";
  if (e.kind === "due")
    return (
      <button type="button" className={cn(cls, "outline-none focus-visible:ring-2 focus-visible:ring-ring")} onClick={() => useNav.getState().openFile(space, e.link.split("#")[0]!)}>
        {body}
      </button>
    );
  if (e.kind === "session") return <label className={cn(cls, "cursor-pointer")}>{body}</label>;
  return <div className={cls}>{body}</div>;
}

// ---- The exam panel ----

/** Adding or editing an exam, in a panel over the right of the page (7274's side panel). */
function ExamPanel({ draft, courses, onClose, onSave, onDelete }: { draft: Draft | null; courses: CourseRef[]; onClose: () => void; onSave: (e: PlanExam) => Promise<void>; onDelete: (id: string) => void }) {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!draft) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, onClose]);
  return (
    <AnimatePresence>
      {draft ? (
        <motion.aside
          key={draft.id || "new"}
          role="dialog"
          aria-label={draft.id ? "Edit exam" : "Add exam"}
          initial={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, x: 16 }}
          transition={{ type: "spring", stiffness: 480, damping: 40 }}
          className="absolute inset-y-3 right-3 z-(--z-sheet) flex w-80 flex-col rounded-panel border bg-popover shadow-popup"
        >
          <ExamForm draft={draft} courses={courses} onCancel={onClose} onSave={onSave} onDelete={draft.id ? () => onDelete(draft.id) : undefined} />
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function ExamForm({ draft, courses, onSave, onCancel, onDelete }: { draft: Draft; courses: CourseRef[]; onSave: (e: PlanExam) => Promise<void>; onCancel: () => void; onDelete?: () => void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ title?: string; date?: string; save?: string }>({});
  const first = useRef<HTMLInputElement>(null);
  // Focus without scrolling the page under the panel.
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
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
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-3 border-b px-5 pt-5 pb-4">
        <h2 className="min-w-0 flex-1 font-medium text-base tracking-title">{draft.id ? "Edit exam" : "Add exam"}</h2>
        <Button size="icon-xs" variant="ghost-muted" aria-label="Close" onClick={onCancel}>
          <Icon icon={icons.close} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="exam-title">Name</Label>
          <Input id="exam-title" ref={first} placeholder="Midterm 2" value={d.title} aria-invalid={error.title ? true : undefined} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <FieldError>{error.title}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="exam-date">Date</Label>
          <DateField id="exam-date" value={d.date} today={localDay(Date.now())} invalid={!!error.date} onChange={(date) => setD({ ...d, date })} />
          <FieldError>{error.date}</FieldError>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Course</Label>
          <Select value={d.course} onValueChange={(v) => setD({ ...d, course: (v as string) ?? NO_COURSE })}>
            <SelectTrigger aria-label="Course">
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
        </div>
        <FieldError>{error.save}</FieldError>
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
        {draft.id && onDelete ? (
          <Button size="sm" variant="ghost-destructive" className="mr-auto" disabled={busy} onClick={onDelete}>
            <Icon icon={icons.delete} />
            Delete exam
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" type="submit" pending={busy}>
          {draft.id ? "Save" : "Add exam"}
        </Button>
      </div>
    </form>
  );
}

function PlanSkeleton() {
  return (
    <div className="grid gap-8 motion-safe:animate-skeleton @3xl/page:grid-cols-[16rem_minmax(0,1fr)]" aria-hidden>
      <div className="flex flex-col gap-2 px-2">
        <Skeleton className="mb-2 h-2 w-12 animate-none" />
        {["70%", "55%", "48%", "64%"].map((w) => (
          <Skeleton key={w} className="h-3 animate-none" style={{ width: w }} />
        ))}
      </div>
      <div className="flex flex-col gap-6">
        <div className="overflow-hidden rounded-card border">
          <div className="h-20 bg-muted" />
          <div className="flex flex-col gap-2 p-5">
            <Skeleton className="h-3 w-32 animate-none" />
            <Skeleton className="h-2.5 w-24 animate-none" />
          </div>
        </div>
        {[2, 3, 1].map((n, i) => (
          <div key={i} className="flex flex-col gap-3 px-3">
            <Skeleton className="h-3 w-28 animate-none" />
            {Array.from({ length: n }, (_, k) => (
              <div key={k} className="flex items-center gap-3">
                <Skeleton className="h-2.5 w-12 animate-none" />
                <Skeleton className="h-3 animate-none" style={{ width: ["52%", "38%", "61%"][(i + k) % 3] }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
