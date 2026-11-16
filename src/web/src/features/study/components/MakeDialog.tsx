import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { AnimatePresence, motion } from "motion/react";
import { type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useNav, useOpenThread } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { Switch } from "@/components/ui/switch";
import { threadModelGet, type ModelPick } from "@/features/chat/api";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { ModelPicker } from "@/features/chat/components/ModelPicker";
import { useSpaceChat } from "@/features/chat/store";
import { planExamsGet } from "@/features/plan/api";
import { cn } from "@/lib/utils";
import { studyMakeCancel, studyScope, studyScopeBuild } from "../api";
import { useStudyFlow } from "../flow-store";
import { type MakeStatus, useMakeJobs } from "../jobs";
import { jobFraction } from "../lib/progress";
import { examDate, examOptions, OTHER_EXAM, scopeWords, type ExamOption } from "../lib/exam-options";
import { KINDS, kindLabel } from "../lib/kinds";
import {
  advice,
  emptyDraft,
  hasSuggestion,
  MAX_COUNT,
  scopeState,
  scopeSuggestions,
  SIZES,
  stages,
  toggleSuggestion,
  type Advice,
  type MakeDraft,
  type MakeKind,
  type ScopeState,
} from "../lib/make-flow";
import type { CourseSource, Grounding, ScopeView, UnknownScope } from "../lib/types";
import { plural, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { type Loaded, useLoad } from "../use-load";
import { AutoHeight, EASE, Slide } from "./motion";
import { Disc, JobBar } from "./parts";
import { SourcePicker } from "./SourcePicker";

type Phase = "what" | "how" | "run" | "ask" | "error" | "done";
type Done = { path?: string; cards?: number; questions?: number; grounding?: Grounding };

const STEP_OF: Record<Phase, number> = { what: 0, how: 1, ask: 0, run: 2, error: 2, done: 2 };

/**
 * Making a quiz or cards, as one forgiving flow:
 * 1. What: the course, a test (or topics), and what the test covers, filled
 *    in from the course with its source shown and editable in plain words.
 *    When the course doesn't say, it asks inline with the course's topics as
 *    suggestions; it never stops at a refusal.
 * 2. How: size, difficulty and kinds of question, and the model to use.
 * 3. The run, stage by stage (reading, mapping topics, writing, checking each
 *    against the source), stoppable; failures say what to do.
 * Opened from Study's overview, or from a chat card with the card's plan
 * filled in (`draft`), at the second step when its course is known. The run
 * itself lives in `jobs.ts`: closing the dialog leaves it going, Study and
 * the chat card show it, and `job` reopens the dialog on a run under way.
 */
export function MakeDialog({
  space,
  kind,
  open,
  onOpenChange,
  sources,
  onChanged,
  onOpen,
  draft: given,
  job: givenJob,
}: {
  space: string;
  kind: MakeKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Loaded<CourseSource[]>;
  onChanged?: () => void;
  onOpen: (s: StudyScreen) => void;
  /** Filled in from a chat card; the dialog opens at its second step. */
  draft?: MakeDraft;
  /** A run already started (by a chat card): the dialog shows where it stands. */
  job?: string;
}) {
  const [draft, setDraft] = useState<MakeDraft>(() => given ?? emptyDraft(kind));
  const [phase, setPhase] = useState<Phase>("what");
  const [dir, setDir] = useState<1 | -1>(1);
  const [errs, setErrs] = useState<{ exam?: string; covers?: string; count?: string; kinds?: string; course?: string }>({});
  const [editScope, setEditScope] = useState(false);
  const [failure, setFailure] = useState<{ message: string; advice: Advice } | null>(null);
  const [needs, setNeeds] = useState<UnknownScope | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useMakeJobs((s) => (jobId ? s.jobs[jobId] : undefined));
  const seen = useRef<MakeStatus | null>(null);
  const pick = useStudyPick(space, open);
  const quiz = draft.kind === "quiz";
  const noun = quiz ? "question" : "card";
  const patch = (p: Partial<MakeDraft>) => setDraft((d) => ({ ...d, ...p }));

  // A fresh flow each time it opens; a draft from chat starts at its second step; a run under way shows where it is.
  useEffect(() => {
    if (!open) return;
    setDraft(given ?? emptyDraft(kind));
    setPhase(givenJob ? "run" : given?.course ? "how" : "what");
    setDir(1);
    setErrs({});
    setEditScope(false);
    setFailure(null);
    setNeeds(null);
    setDone(null);
    seen.current = null;
    setJobId(givenJob ?? null);
  }, [open, kind, given, givenJob]);
  // While it is open on a run, the run's end shows here instead of as a toast.
  useEffect(() => {
    if (!open || !jobId) return;
    const jobs = useMakeJobs.getState();
    jobs.watch(jobId, true);
    return () => jobs.watch(jobId, false);
  }, [open, jobId]);
  // The run's end moves the dialog on: done, a question about the scope, a failure, or back to the options when stopped.
  useEffect(() => {
    if (!job || seen.current === job.status) return;
    seen.current = job.status;
    if (job.status === "running" || job.status === "stopping") return;
    if (job.status === "cancelled") return go("how", -1);
    if (job.status === "needsScope" && job.needs) {
      setNeeds(job.needs);
      scope.reload();
      return go("ask", -1);
    }
    if (job.status === "error") {
      const message = job.failure ?? "Something went wrong.";
      setFailure({ message, advice: advice(message, quiz) });
      return go("error");
    }
    setDone(job.done ?? {});
    go("done");
    onChanged?.();
  });
  // One course: chosen for you.
  useEffect(() => {
    if (open && !draft.course && sources.data?.length === 1) patch({ course: sources.data[0]!.folder });
  }, [open, draft.course, sources.data]);

  const course = sources.data?.find((s) => s.folder === draft.course);
  const scope = useLoad(() => (open && draft.course ? studyScope(space, draft.course, pick.pick) : Promise.resolve(null)), [open, space, draft.course, pick.pick], "study:scope");
  const planned = useLoad(() => (open ? planExamsGet(space).catch(() => []) : Promise.resolve([])), [open, space], "plan:exams");
  const options: ExamOption[] = useMemo(
    () => (course ? examOptions({ name: course.name, folder: course.folder }, scope.data ?? null, planned.data ?? []) : []),
    [course, scope.data, planned.data],
  );
  const scopeNow: ScopeState = scopeState(draft, options, scope.data ?? null, (o) => (o.scope ? scopeWords(o.scope) : ""));
  const examTitle = draft.target === "exam" ? (scopeNow.kind !== "none" && scopeNow.option ? scopeNow.option.title : draft.exam.trim()) : "";
  const knownWords = scopeNow.kind === "known" || scopeNow.kind === "stated" ? scopeNow.words : "";

  // ---- Steps ----

  const go = (next: Phase, d: 1 | -1 = 1) => {
    setDir(d);
    setPhase(next);
  };

  const checkWhat = (): boolean => {
    const e: typeof errs = {};
    if (!draft.course && !draft.files.length) e.course = "Choose a course.";
    if (draft.target === "exam" && !draft.exam.trim()) e.exam = "Choose a test, or make it on topics instead.";
    if (draft.target === "exam" && scopeNow.kind === "unknown" && !draft.covers.trim()) e.covers = `Say what ${examTitle || "it"} covers: tap a suggestion or write a few words.`;
    setErrs(e);
    return !Object.keys(e).length;
  };

  const checkHow = (): boolean => {
    const e: typeof errs = {};
    if (!Number.isInteger(draft.count) || draft.count < 1 || draft.count > MAX_COUNT[draft.kind]) e.count = `From 1 to ${MAX_COUNT[draft.kind]}.`;
    if (quiz && !draft.kinds.length) e.kinds = "Pick at least one kind.";
    setErrs(e);
    return !Object.keys(e).length;
  };

  // ---- The run ----

  const generate = () => {
    if (!checkHow()) return;
    setFailure(null);
    setNeeds(null);
    seen.current = null;
    const id = useMakeJobs.getState().start({ space, draft, examTitle, knownWords, pick: pick.pick, courseName: course?.name });
    setJobId(id);
    go("run");
  };

  const stop = async () => {
    if (!jobId) return go("how", -1);
    const stopped = await useMakeJobs.getState().stop(jobId);
    // Nothing was running in the core (it had just finished or failed): its own end moves the dialog on.
    if (!stopped && useMakeJobs.getState().jobs[jobId]?.status === "running") go("how", -1);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (phase === "what" && checkWhat()) go("how");
    else if (phase === "how") generate();
    else if (phase === "ask" && draft.covers.trim()) generate();
  };

  const close = () => onOpenChange(false);
  const stopping = job?.status === "stopping";
  const step = STEP_OF[phase];
  const scopeTag = draft.target === "topics" ? draft.focus.trim() || "Anything in the course" : examTitle ? `${examTitle}${draft.covers.trim() || knownWords ? `: ${draft.covers.trim() || knownWords}` : ""}` : "";

  const label = quiz ? "Make a quiz" : "Make cards";
  const makeLabel = `Make ${plural(draft.count || 0, noun)}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Anchored near the top (not centred) so its top edge stays put as the steps change height. */}
      <DialogPopup className="row-span-3 row-start-1 mt-(--dialog-top) max-h-(--dialog-anchored-max-height) max-w-xl self-start rounded-panel" showCloseButton={false} aria-label={label}>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader className="@container/makehead gap-4 p-6 pr-6 pb-4">
            <div className="flex items-start gap-3">
              <DialogTitle className="min-w-0 flex-1">{label}</DialogTitle>
              <DialogClose render={<Button size="icon-sm" variant="ghost-muted" aria-label="Close" className="-mt-1 -mr-2" />}>
                <Icon icon={icons.close} />
              </DialogClose>
            </div>
            {/*
              Steps, with the kind beside them while it can still change: one row, so the header keeps its height.
              In a narrow dialog only the current step keeps its name and the kinds show their icons.
            */}
            <div className="flex h-8 items-center justify-between gap-3">
              <Steps step={step} done={phase === "done"} onStep={(i) => (i === 0 && phase === "how" ? go("what", -1) : undefined)} labels={["What", quiz ? "Questions" : "Cards", "Make"]} />
              {phase === "what" || phase === "how" ? (
                <Tabs value={draft.kind} onValueChange={(k: MakeKind) => patch({ kind: k, count: emptyDraft(k).count })}>
<TabsList aria-label="Kind">
                  <TabsTab value="quiz">
                    <Icon icon={icons.quiz} />
                    <span className="@max-md/makehead:sr-only">Quiz</span>
                  </TabsTab>
                  <TabsTab value="deck">
                    <Icon icon={icons.deck} />
                    <span className="@max-md/makehead:sr-only">Cards</span>
                  </TabsTab>
                </TabsList>
</Tabs>
              ) : null}
            </div>
          </DialogHeader>

          <DialogPanel className="space-y-0 px-6 pt-1 pb-2">
            <AutoHeight>
              <Slide id={phase} dir={dir}>
                {phase === "what" ? (
                  <WhatStep
                    space={space}
                    draft={draft}
                    patch={(p) => (patch(p), setErrs({}))}
                    sources={sources}
                    course={course}
                    scope={scope}
                    options={options}
                    scopeNow={scopeNow}
                    examTitle={examTitle}
                    editScope={editScope}
                    setEditScope={setEditScope}
                    errs={errs}
                    pick={pick.pick}
                    onClose={close}
                  />
                ) : null}
                {phase === "how" ? (
                  <HowStep
                    draft={draft}
                    patch={(p) => (patch(p), setErrs({}))}
                    errs={errs}
                    course={course?.name ?? "Chosen files"}
                    scope={scopeTag}
                    model={pick.pick ? <ModelPicker pick={pick.pick} onPick={pick.set} /> : <Skeleton className="h-4 w-28" />}
                    onChange={() => go("what", -1)}
                  />
                ) : null}
                {phase === "ask" && needs ? (
                  <div className="flex flex-col gap-3 pb-2">
                    <Note icon={icons.map} title={`What does ${needs.exam} cover?`}>
                      {needs.courseName}’s materials don’t say, and questions are only written on what’s in scope. Tap topics or say it in a few words.
                    </Note>
                    <AskScope view={scope.data ?? null} value={draft.covers} onChange={(covers) => patch({ covers })} autoFocus />
                  </div>
                ) : null}
                {phase === "run" ? <RunView progress={job?.progress ?? null} fraction={job?.fraction ?? 0} started={job?.started ?? Date.now()} quiz={quiz} course={course?.name} exam={examTitle || undefined} stopping={stopping} /> : null}
                {phase === "error" && failure ? (
                  <div className="flex flex-col gap-3 pb-2">
                    <SurfaceError title={failure.advice.title} message={`${failure.message}\n\n${failure.advice.hint}`} />
                    {failure.advice.action === "model" && pick.pick ? (
                      <div className="flex items-center gap-2 text-sm" data-testid="study-model">
                        <span className="text-muted-foreground">Model</span>
                        <ModelPicker pick={pick.pick} onPick={pick.set} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {phase === "done" && done ? <DoneView done={done} quiz={quiz} /> : null}
              </Slide>
            </AutoHeight>
          </DialogPanel>

          <DialogFooter variant="bare" className="flex-row gap-2 px-6 pt-4 pb-6">
            {phase === "what" ? (
              <>
                <Button type="button" variant="outline" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={!sources.data?.length}>
                  Next
                  <Icon icon={icons.arrowRight} />
                </Button>
              </>
            ) : null}
            {phase === "how" ? (
              <>
                <Button type="button" variant="outline" onClick={() => go("what", -1)}>
                  <Icon icon={icons.arrowLeft} />
                  Back
                </Button>
                <Button type="submit" className="flex-1">
                  <Icon icon={icons.ai} />
                  {makeLabel}
                </Button>
              </>
            ) : null}
            {phase === "ask" ? (
              <>
                <Button type="button" variant="outline" onClick={() => go("what", -1)}>
                  Change test
                </Button>
                <Button type="submit" className="flex-1" disabled={!draft.covers.trim()}>
                  <Icon icon={icons.ai} />
                  Make it
                </Button>
              </>
            ) : null}
            {/* While it runs, the stage list shows the one spinner; the only action is Stop. */}
            {phase === "run" ? (
              <>
                <Button type="button" variant="outline" disabled={stopping} pending={stopping} onClick={() => void stop()}>
                  {stopping ? "Stopping…" : "Stop"}
                </Button>
                <Button type="button" variant="ghost" className="flex-1" onClick={close}>
                  Close, keep making it
                </Button>
              </>
            ) : null}
            {phase === "error" && failure ? (
              <>
                {failure.advice.action === "model" ? (
                  <Button type="button" variant="outline" onClick={() => (close(), useNav.getState().openSettings("providers"))}>
                    Open settings
                  </Button>
                ) : null}
                <Button type="button" variant="outline" onClick={() => go(failure.advice.action === "scope" || failure.advice.action === "focus" ? "what" : "how", -1)}>
                  {failure.advice.action === "scope" || failure.advice.action === "focus" ? "Change what" : "Back"}
                </Button>
                <Button type="button" className="flex-1" onClick={generate}>
                  Try again
                </Button>
              </>
            ) : null}
            {phase === "done" && done ? (
              <>
                <Button type="button" variant="outline" onClick={close}>
                  Close
                </Button>
                {done.path ? (
                  <Button type="button" className="flex-1" onClick={() => (close(), onOpen(quiz ? { kind: "quiz", path: done.path! } : { kind: "review", paths: [done.path!] }))}>
                    {quiz ? "Take the quiz" : "Start learning"}
                    <Icon icon={icons.arrowRight} />
                  </Button>
                ) : null}
              </>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** The model the dialog asks with: the last one picked for study, else the conversation's. */
export function useStudyPick(space: string, open: boolean): { pick: ModelPick | null; set: (p: ModelPick) => void } {
  const saved = useStudyFlow((s) => s.pick);
  const setPick = useStudyFlow((s) => s.setPick);
  const chat = useSpaceChat(space).pick?.pick ?? null;
  const thread = useOpenThread(space);
  const [fetched, setFetched] = useState<ModelPick | null>(null);
  useEffect(() => {
    if (!open || saved || chat) return;
    let live = true;
    threadModelGet(space, thread).then(
      (v) => live && setFetched(v.pick),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, saved, chat, space, thread]);
  return { pick: saved ?? chat ?? fetched, set: setPick };
}

/** What · Questions · Make: a blue disc for each step behind you, the current one in ink. */
function Steps({ step, done, labels, onStep }: { step: number; done: boolean; labels: string[]; onStep: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-2 text-sm" aria-label="Steps">
      {labels.map((l, i) => {
        const past = i < step || (done && i === step);
        return (
          <li key={l} className="flex items-center gap-2">
            {i > 0 ? <span className={cn("h-px w-6 bg-border transition-colors duration-200 @max-md/makehead:w-3", i <= step && "bg-primary/50")} aria-hidden /> : null}
            <button
              type="button"
              disabled={i >= step}
              onClick={() => onStep(i)}
              aria-current={i === step ? "step" : undefined}
              className={cn("flex items-center gap-2 rounded-md text-muted-foreground transition-colors enabled:hover:text-foreground", i === step && !done && "font-medium text-foreground")}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {past ? (
                  <motion.span key="done" initial={{ scale: 0.5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 32 }}>
                    <Disc />
                  </motion.span>
                ) : (
                  <span
                    key="n"
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border text-3xs tabular-nums transition-colors",
                      i === step ? "border-foreground text-foreground" : "border-input text-subtle-foreground",
                    )}
                  >
                    {i + 1}
                  </span>
                )}
              </AnimatePresence>
              <span className={cn(i !== step && "@max-md/makehead:sr-only")}>{l}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={htmlFor} className="font-normal text-foreground text-sm">
          {label}
        </Label>
        {hint ? <span className="text-subtle-foreground text-xs">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A grey box with a glyph, a line and a muted explanation; `warning` when it wants an answer. */
function Note({ icon, glyph, title, children, tone = "muted", action }: { icon?: IconData; glyph?: ReactNode; title: ReactNode; children?: ReactNode; tone?: "muted" | "warning"; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      {glyph ? (
        <span className="flex h-5 w-4.5 shrink-0 items-center justify-center">{glyph}</span>
      ) : icon ? (
        <Icon icon={icon} className={cn("mt-0.5 size-4.5 shrink-0", tone === "warning" ? "text-warning-foreground" : "text-muted-foreground")} />
      ) : null}
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-foreground [overflow-wrap:anywhere]">{title}</p>
        {children ? <div className="mt-0.5 text-muted-foreground text-sm [overflow-wrap:anywhere]">{children}</div> : null}
      </div>
      {action}
    </div>
  );
}

// ---- Step 1: what ----

const PART_NAME = { syllabus: "Syllabus", assignments: "Assignments", files: "Files", readings: "Readings" } as const;

/** Courses as cards, three across (after 9091's plan cards): a glyph and the name on the white sheet, one short fact in the footer strip. */
function CoursePicker({ sources, value, onChange, invalid }: { sources: CourseSource[]; value: string | null; onChange: (folder: string) => void; invalid?: boolean }) {
  return (
    <RadioGroupPrimitive
      value={value}
      onValueChange={(v) => onChange(v as string)}
      aria-label="Course"
      aria-invalid={invalid || undefined}
      className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto p-0.5 @sm/dialog:grid-cols-3"
    >
      {sources.map((s) => {
        const parts = (["syllabus", "assignments", "files", "readings"] as const).filter((p) => s[p]);
        const first = parts[0] ? PART_NAME[parts[0]] : null;
        const fact = first ? (parts.length > 1 ? `${first} +${parts.length - 1}` : first) : "Nothing to read yet";
        return (
          <RadioPrimitive.Root
            key={s.folder}
            value={s.folder}
            aria-label={s.name}
            nativeButton
            render={<button type="button" />}
            className="group flex min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-well text-left outline-none transition-[border-color,box-shadow] duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring data-checked:border-primary data-checked:ring-1 data-checked:ring-primary"
          >
            <span className="flex h-20 flex-col gap-2 rounded-b-xl border-b border-border/70 bg-card px-3 py-2.5">
              <span className="flex items-center justify-between gap-2">
                <Icon icon={icons.courses} className="size-4 text-muted-foreground" />
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-input transition-colors group-data-checked:border-primary group-data-checked:bg-primary">
                  <span className="size-1.5 rounded-full bg-white opacity-0 transition-opacity group-data-checked:opacity-100" />
                </span>
              </span>
              <span className="line-clamp-2 min-w-0 text-foreground text-sm">{s.name}</span>
            </span>
            <Truncate className="px-3 py-1.5 text-muted-foreground text-xs tabular-nums">{fact}</Truncate>
          </RadioPrimitive.Root>
        );
      })}
    </RadioGroupPrimitive>
  );
}

function WhatStep({
  space,
  draft,
  patch,
  sources,
  course,
  scope,
  options,
  scopeNow,
  examTitle,
  editScope,
  setEditScope,
  errs,
  pick,
  onClose,
}: {
  space: string;
  draft: MakeDraft;
  patch: (p: Partial<MakeDraft>) => void;
  sources: Loaded<CourseSource[]>;
  course: CourseSource | undefined;
  scope: Loaded<ScopeView | null>;
  options: ExamOption[];
  scopeNow: ScopeState;
  examTitle: string;
  editScope: boolean;
  setEditScope: (v: boolean) => void;
  errs: { exam?: string; covers?: string; course?: string };
  pick: ModelPick | null;
  onClose: () => void;
}) {
  const listed = options.some((o) => o.title === draft.exam);
  const examValue = !draft.exam ? "" : listed ? draft.exam : OTHER_EXAM;
  const [other, setOther] = useState(examValue === OTHER_EXAM);
  const suggestions = scopeSuggestions(scope.data ?? null);

  if (sources.error) return <SurfaceError title="Couldn’t list your courses" message={cleanMessage(sources.error)} onRetry={sources.reload} />;
  if (!sources.data)
    return (
      <div className="flex flex-col gap-3 pb-2 motion-safe:animate-skeleton" aria-hidden>
        <Skeleton className="h-3 w-16 animate-none" />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 animate-none rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-8 w-full animate-none rounded-lg" />
      </div>
    );
  if (!sources.data.length)
    return (
      <Card variant="well" className="mb-2 items-start gap-3 p-5">
        <Icon icon={icons.courses} className="size-5 text-muted-foreground" />
        <div>
          <p className="font-medium text-base">No courses in this space</p>
          <p className="mt-0.5 text-muted-foreground text-sm">Import a course, or give this space access to one, to make questions from it.</p>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => (onClose(), useNav.getState().setView("courses"))}>
          Open courses
        </Button>
      </Card>
    );

  return (
    <div className="@container/dialog flex flex-col gap-5 pb-2">
      <Field label="Course">
        <CoursePicker sources={sources.data} value={draft.course} invalid={!!errs.course} onChange={(folder) => patch({ course: folder || null, files: [], exam: "", covers: "" })} />
        <FieldError>{errs.course}</FieldError>
      </Field>

      <Field label="For">
        <Tabs value={draft.target} onValueChange={(t: MakeDraft["target"]) => patch({ target: t })} className="w-full">
<TabsList aria-label="For" className="w-full">
          <TabsTab value="exam" className="flex-1">
            <Icon icon={icons.goal} />A test
          </TabsTab>
          <TabsTab value="topics" className="flex-1">
            <Icon icon={icons.read} />
            Topics
          </TabsTab>
        </TabsList>
</Tabs>
      </Field>

      {draft.target === "exam" ? (
        <div className="flex flex-col gap-2">
          {options.length && !other ? (
            <Select
              value={examValue}
              onValueChange={(v) => {
                if (v === OTHER_EXAM) {
                  setOther(true);
                  patch({ exam: "", covers: "" });
                } else patch({ exam: (v as string) ?? "", covers: "" });
                setEditScope(false);
              }}
            >
              <SelectTrigger aria-label="Test" aria-invalid={errs.exam ? true : undefined}>
                <SelectValue>{(v: string) => (v ? v : scope.loading ? "Looking for tests…" : "Choose a test")}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {options.map((o) => (
                  <SelectItem key={o.title} value={o.title}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">{o.title}</span>
                      {o.date ? <span className="shrink-0 text-muted-foreground text-xs tabular-nums">{examDate(o.date)}</span> : null}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_EXAM}>Another test…</SelectItem>
              </SelectPopup>
            </Select>
          ) : (
            <div className="flex items-center gap-2">
              <Input aria-label="Test name" placeholder="Test name, e.g. Midterm 2" value={draft.exam} aria-invalid={errs.exam ? true : undefined} onChange={(e) => patch({ exam: e.target.value })} />
              {options.length ? (
                <Button type="button" size="sm" variant="ghost-muted" onClick={() => (setOther(false), patch({ exam: "" }))}>
                  Pick from list
                </Button>
              ) : null}
            </div>
          )}
          <FieldError>{errs.exam}</FieldError>
          <AnimatePresence initial={false}>
            {scopeNow.kind !== "none" && course ? (
              <motion.div key="scope" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.18, ease: EASE }}>
                <ScopePanel
                  space={space}
                  course={course}
                  exam={examTitle}
                  state={scopeNow}
                  covers={draft.covers}
                  onCovers={(covers) => patch({ covers })}
                  edit={editScope}
                  setEdit={setEditScope}
                  view={scope.data ?? null}
                  onMapped={scope.reload}
                  pick={pick}
                  error={errs.covers}
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Input aria-label="Topics" placeholder="e.g. induction proofs, power sets" value={draft.focus} onChange={(e) => patch({ focus: e.target.value })} />
          {suggestions.topics.length ? <Chips items={suggestions.topics} value={draft.focus} onChange={(focus) => patch({ focus })} /> : null}
        </div>
      )}

      {course ? (
        <Collapsible defaultOpen={draft.files.length > 0}>
          <CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground">
            <Icon icon={icons.chevronRight} className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
            {draft.files.length ? `From ${plural(draft.files.length, "chosen part")} of the course` : "From the whole course · choose parts"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="pt-2">
              <SourcePicker space={space} sources={[course]} chosen={new Set(draft.files)} onChange={(s) => patch({ files: [...s] })} />
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** What the chosen test covers: from the course (with its source), from you, or asked for here. */
function ScopePanel({
  space,
  course,
  exam,
  state,
  covers,
  onCovers,
  edit,
  setEdit,
  view,
  onMapped,
  pick,
  error,
}: {
  space: string;
  course: CourseSource | undefined;
  exam: string;
  state: ScopeState;
  covers: string;
  onCovers: (s: string) => void;
  edit: boolean;
  setEdit: (v: boolean) => void;
  view: ScopeView | null;
  onMapped: () => void;
  pick: ModelPick | null;
  error?: string;
}) {
  const [mapping, setMapping] = useState<{ fraction: number; error?: string; id: string } | null>(null);
  const courseName = course?.name ?? "the course";

  const lookUp = async () => {
    if (!course) return;
    const id = crypto.randomUUID();
    setMapping({ fraction: 0, id });
    let failed: string | undefined;
    let cancelled = false;
    const end = await studyScopeBuild(
      space,
      course.folder,
      (e) => {
        if (e.type === "progress") setMapping((m) => m && { ...m, fraction: jobFraction(e, "single", m.fraction) });
        else if (e.type === "error") failed = e.message;
        else if (e.type === "cancelled") cancelled = true;
      },
      { model: pick, runId: id },
    );
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (cancelled) return setMapping(null);
    if (failed) return setMapping({ fraction: 0, id, error: failed });
    setMapping(null);
    onMapped();
  };

  if (state.kind === "known" || state.kind === "stated") {
    const evidence = state.kind === "known" ? (state.option.scope?.evidence ?? []) : [];
    return (
      <Card variant="well" className="mt-1 gap-2.5 p-4" data-testid="scope-known">
        <Note
          glyph={<Disc />}
          title={
            <>
              <span className="text-muted-foreground">{state.kind === "stated" ? "You said it covers " : "Covers "}</span>
              {covers.trim() || state.words}
            </>
          }
          action={
            !edit ? (
              <Button type="button" size="xs" variant="ghost-muted" onClick={() => (onCovers(covers || state.words), setEdit(true))}>
                <Icon icon={icons.edit} />
                Edit
              </Button>
            ) : null
          }
        >
          {evidence.length ? (
            <div className="-mx-0.5 mt-1 flex flex-wrap items-center gap-y-1 text-xs">
              <span className="px-0.5 text-muted-foreground">From</span>
              {evidence.slice(0, 3).map((e) => (
                <CitationChip key={`${e.source}${e.quote}`} space={space} citation={{ path: e.source, quote: e.quote }} />
              ))}
            </div>
          ) : null}
        </Note>
        {edit ? <Textarea rows={2} aria-label={`What ${exam} covers`} value={covers} onChange={(e) => onCovers(e.target.value)} autoFocus /> : null}
      </Card>
    );
  }

  if (state.kind === "unchecked") {
    return (
      <Card variant="well" className="mt-1 gap-3 p-4">
        <Note
          icon={icons.map}
          title={mapping ? `Reading ${courseName}…` : `Phaethon finds what ${exam || "it"} covers in ${courseName}`}
          action={
            mapping && !mapping.error ? (
              <Button type="button" size="xs" variant="ghost-muted" onClick={() => void studyMakeCancel(space, mapping.id)}>
                Stop
              </Button>
            ) : (
              <Button type="button" size="xs" variant="outline" onClick={() => void lookUp()}>
                {mapping?.error ? null : <Icon icon={icons.find} />}
                {mapping?.error ? "Try again" : "Look it up"}
              </Button>
            )
          }
        >
          {mapping ? "Finding what it teaches and what each test covers. The first time takes a few minutes." : "It reads the course once when you make it, or look it up now. You can also say it yourself."}
          {mapping && !mapping.error ? (
            <div className="relative mt-2.5 h-0.5 overflow-hidden rounded-full">
              <JobBar value={mapping.fraction} />
            </div>
          ) : null}
          {mapping?.error ? <FieldError className="mt-1.5">{mapping.error}</FieldError> : null}
        </Note>
        <Textarea rows={2} aria-label={`What ${exam} covers`} placeholder="Or say it: e.g. chapters 1–4, through Problem set 6, no proofs" value={covers} onChange={(e) => onCovers(e.target.value)} />
      </Card>
    );
  }

  // Read, and the course doesn't say: ask, with its topics as suggestions.
  return (
    <Card variant="well" className="mt-1 gap-3 border-warning/30 bg-warning/5 p-4" data-testid="scope-ask">
      <Note icon={icons.map} tone="warning" title={`What does ${exam || "this test"} cover?`}>
        {courseName}’s materials don’t say. Questions are only written on what you list here.
      </Note>
      <AskScope view={view} value={covers} onChange={onCovers} />
      <FieldError>{error}</FieldError>
    </Card>
  );
}

function AskScope({ view, value, onChange, autoFocus }: { view: ScopeView | null; value: string; onChange: (s: string) => void; autoFocus?: boolean }) {
  const s = scopeSuggestions(view);
  return (
    <div className="flex flex-col gap-2.5">
      <Textarea rows={2} aria-label="What it covers" placeholder="e.g. chapters 1–4, through Problem set 6, no proofs" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />
      {s.topics.length || s.through.length ? <Chips items={[...s.through, ...s.topics]} value={value} onChange={onChange} /> : null}
    </div>
  );
}

function Chips({ items, value, onChange }: { items: string[]; value: string; onChange: (s: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggestions">
      {items.map((t) => {
        const on = hasSuggestion(value, t);
        return (
          <Toggle
            key={t}
            size="sm"
            variant="outline"
            pressed={on}
            onPressedChange={() => onChange(toggleSuggestion(value, t))}
            className="h-7 max-w-full gap-1 rounded-full bg-card px-2.5 font-normal text-sm data-pressed:border-primary/50 data-pressed:bg-primary/8 data-pressed:text-foreground"
          >
            {on ? <Icon icon={icons.check} className="size-3.5 text-primary" /> : null}
            <Truncate className="min-w-0">{t}</Truncate>
          </Toggle>
        );
      })}
    </div>
  );
}

// ---- Step 2: how ----

const KIND_HINT: Record<string, string> = {
  choice: "One right answer among four.",
  multi: "Every right answer, from several.",
  truefalse: "A statement to judge.",
  short: "A sentence or two, graded against the source.",
  cloze: "The missing word or phrase.",
};

function HowStep({
  draft,
  patch,
  errs,
  course,
  scope,
  model,
  onChange,
}: {
  draft: MakeDraft;
  patch: (p: Partial<MakeDraft>) => void;
  errs: { count?: string; kinds?: string };
  course: string;
  scope: string;
  model: ReactNode;
  onChange: () => void;
}) {
  const quiz = draft.kind === "quiz";
  const sizes = SIZES[draft.kind];
  const preset = sizes.includes(draft.count) ? String(draft.count) : "";
  const difficulty = { easier: "Easier", exam: "Like the test", harder: "Harder" }[draft.difficulty];
  return (
    <div className="flex flex-col gap-5 pb-2">
      <div className={cn("grid gap-4", quiz && "grid-cols-2")}>
        <Field label="How many" hint={errs.count ? undefined : `Up to ${MAX_COUNT[draft.kind]}`}>
          <div className="flex items-center gap-2">
            <Tabs value={preset} onValueChange={(v: string) => patch({ count: Number(v) })} className="min-w-0 flex-1">
<TabsList aria-label="How many" className="w-full">
              {sizes.map((n) => (
                <TabsTab key={n} value={String(n)} className="min-w-0 flex-1 px-1 tabular-nums">
                  {n}
                </TabsTab>
              ))}
            </TabsList>
</Tabs>
            <Input
              aria-label="Exact number"
              inputMode="numeric"
              className="w-14 shrink-0 tabular-nums"
              value={draft.count ? String(draft.count) : ""}
              aria-invalid={errs.count ? true : undefined}
              onChange={(e) => patch({ count: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
            />
          </div>
          <FieldError>{errs.count}</FieldError>
        </Field>
        {quiz ? (
          <Field label="Difficulty">
            <Tabs value={draft.difficulty} onValueChange={(d: MakeDraft["difficulty"]) => patch({ difficulty: d })} className="w-full">
<TabsList aria-label="Difficulty" className="w-full">
              <TabsTab value="easier" className="min-w-0 flex-1 px-1">
                Easier
              </TabsTab>
              <TabsTab value="exam" className="min-w-0 flex-1 px-1">
                Like the test
              </TabsTab>
              <TabsTab value="harder" className="min-w-0 flex-1 px-1">
                Harder
              </TabsTab>
            </TabsList>
</Tabs>
          </Field>
        ) : null}
      </div>

      {quiz ? (
        <Field label="Kinds of question">
          {/* Two across, titles only; what each kind is shows on hover. */}
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="Kinds of question">
            {KINDS.map((k) => (
              <KindToggle
                key={k.kind}
                label={k.label}
                hint={KIND_HINT[k.kind]}
                checked={draft.kinds.includes(k.kind)}
                onCheckedChange={(p) => patch({ kinds: p ? [...draft.kinds, k.kind] : draft.kinds.filter((x) => x !== k.kind) })}
              />
            ))}
          </div>
          <FieldError>{errs.kinds}</FieldError>
        </Field>
      ) : null}

      <Card variant="well" className="gap-0 p-4" data-testid="make-summary">
        <div className="mb-1 flex h-6 items-center justify-between">
          <span className="font-medium text-sm">Summary</span>
          <Button type="button" size="xs" variant="ghost-muted" onClick={onChange}>
            Change
          </Button>
        </div>
        <SummaryRow icon={icons.courses} label="Course" value={course} />
        {scope ? <SummaryRow icon={icons.goal} label="For" value={scope} /> : null}
        <SummaryRow icon={quiz ? icons.quiz : icons.deck} label={quiz ? "Questions" : "Cards"} value={[plural(draft.count || 0, quiz ? "question" : "card"), quiz ? difficulty : null].filter(Boolean).join(" · ")} />
        {quiz ? <SummaryRow icon={icons.list} label="Kinds" value={draft.kinds.length ? draft.kinds.map(kindLabel).join(", ") : "None chosen"} /> : null}
        <div className="flex h-8 items-center gap-3 text-sm">
          <Icon icon={icons.rename} className="size-4 text-muted-foreground" />
          <label htmlFor="make-title" className="shrink-0 text-muted-foreground">
            Name
          </label>
          <input
            id="make-title"
            placeholder="Named for you"
            value={draft.title}
            maxLength={120}
            onChange={(e) => patch({ title: e.target.value })}
            className="-mr-1.5 h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-right text-foreground outline-none transition-colors placeholder:text-subtle-foreground hover:bg-accent focus-visible:bg-card focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <div className="flex h-8 items-center gap-3 text-sm" data-testid="study-model">
          <Icon icon={icons.model} className="size-4 text-muted-foreground" />
          <span className="text-muted-foreground">Model</span>
          <span className="ml-auto flex min-w-0 justify-end">{model}</span>
        </div>
      </Card>
    </div>
  );
}

/** A compact on/off row for one kind of question: its name and a switch; the whole row is the label. */
function KindToggle({ label, hint, checked, onCheckedChange }: { label: string; hint?: string; checked: boolean; onCheckedChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div title={hint} className={cn("flex h-10 items-center gap-2 rounded-lg border px-3 transition-colors", checked ? "border-border bg-card" : "border-border/70 bg-well")}>
      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer truncate text-foreground text-sm">
        {label}
      </label>
      <Switch id={id} size="sm" checked={checked} onCheckedChange={(v) => onCheckedChange(v)} />
    </div>
  );
}

function SummaryRow({ icon, label, value }: { icon: IconData; label: string; value: string }) {
  return (
    <div className="flex h-8 items-center gap-3 text-sm">
      <Icon icon={icon} className="size-4 text-muted-foreground" />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <Truncate className="ml-auto min-w-0 text-right text-foreground">{value}</Truncate>
    </div>
  );
}

// ---- Step 3: the run ----

function RunView({ progress, fraction, started, quiz, course, exam, stopping }: { progress: MakeProgress | null; fraction: number; started: number; quiz: boolean; course?: string; exam?: string; stopping: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const list = stages(progress, { quiz, course, exam });
  const secs = Math.max(0, Math.round((now - started) / 1000));
  return (
    <div className="flex flex-col gap-4 pb-2" aria-live="polite" data-testid="make-progress">
      <div className="flex items-center gap-3">
        <span className={cn("min-w-0 flex-1 truncate text-base", !stopping && "text-shimmer")}>{stopping ? "Stopping…" : quiz ? "Making your quiz…" : "Making your cards…"}</span>
        <span className="shrink-0 text-muted-foreground text-sm type-live">{`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}</span>
      </div>
      <div className="relative h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
        <div className="h-full rounded-full bg-ink transition-[width] duration-500 ease-(--ease-out-soft)" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
      </div>
      <ol className="flex flex-col">
        {list.map((s) => (
          <motion.li key={s.id} layout="position" className="group/stage relative flex gap-3" data-state={s.state}>
            <span aria-hidden className="absolute top-0 bottom-0 left-2 w-px -translate-x-1/2 bg-border group-first/stage:top-4 group-last/stage:bottom-auto group-last/stage:h-4" />
            <span className="relative z-10 flex h-8 w-4 shrink-0 items-center justify-center">
              <span className="flex bg-popover py-1">
                <AnimatePresence mode="popLayout" initial={false}>
                  {s.state === "done" ? (
                    <motion.span key="done" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 28 }}>
                      <Disc />
                    </motion.span>
                  ) : s.state === "active" ? (
                    <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <Spinner size="sm" className="text-foreground" />
                    </motion.span>
                  ) : (
                    <motion.span key="pending" className="m-1 size-2 rounded-full border border-subtle-foreground" />
                  )}
                </AnimatePresence>
              </span>
            </span>
            <div className="min-w-0 flex-1 py-1.5">
              <p className={cn("text-sm transition-colors", s.state === "pending" ? "text-subtle-foreground" : s.state === "active" ? "text-foreground" : "text-muted-foreground")}>{s.label}</p>
              <AnimatePresence initial={false}>
                {s.state === "active" && s.detail ? (
                  <motion.p
                    key={s.detail}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.16, ease: EASE }}
                    className="text-muted-foreground text-xs tabular-nums"
                  >
                    {s.detail}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

/** "You're all set" (c06d): what was made, then a grey list of what it covers with blue ticks. */
function DoneView({ done, quiz }: { done: Done; quiz: boolean }) {
  const g = done.grounding;
  const noun = quiz ? "question" : "card";
  const dropped = g ? g.asked - g.kept : 0;
  const made = quiz ? done.questions ?? 0 : done.cards ?? 0;
  const topics = g?.coverage.filter((c) => c.count > 0) ?? [];
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }} className="flex flex-col gap-4 pb-2">
      <div>
        <p className="type-heading tabular-nums">{quiz ? `Made a quiz of ${plural(made, "question")}` : `Made ${plural(made, "card")}`}</p>
        {g?.exam ? <p className="mt-0.5 text-muted-foreground text-sm [overflow-wrap:anywhere]">{`For ${g.exam}${g.scope ? `: ${g.scope}` : ""}.`}</p> : null}
      </div>
      <Card variant="well" className="gap-0 px-4 py-2">
        <DoneRow tone="done">{`Each ${noun} checked against your materials`}</DoneRow>
        {dropped ? <DoneRow tone="info">{`${plural(dropped, noun)} that didn’t match ${dropped === 1 ? "was" : "were"} left out`}</DoneRow> : null}
        {topics.map((c) => (
          <DoneRow key={c.topic} tone="done" meta={String(c.count)}>
            {c.topic}
          </DoneRow>
        ))}
      </Card>
    </motion.div>
  );
}

function DoneRow({ tone, meta, children }: { tone: "done" | "info"; meta?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 text-sm">
      <Disc tone={tone} />
      <span className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">{children}</span>
      {meta ? <span className="shrink-0 text-muted-foreground tabular-nums">{meta}</span> : null}
    </div>
  );
}
