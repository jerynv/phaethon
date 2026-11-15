import { ArrowLeft, BookOpenText, Cards, CheckCircle, Exam, MapTrifold, PencilSimpleLine, Sparkle, Target } from "@phosphor-icons/react";
import { motion, AnimatePresence } from "motion/react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { threadModelGet, type ModelPick } from "@/features/chat/api";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { ModelPicker } from "@/features/chat/components/ModelPicker";
import { useSpaceChat } from "@/features/chat/store";
import { planExamsGet } from "@/features/plan/api";
import { cn } from "@/lib/utils";
import { studyMakeCancel, studyMakeDeck, studyMakeQuiz, studyScope, studyScopeBuild, studyScopeState } from "../api";
import { useStudyFlow } from "../flow-store";
import { examDate, examOptions, OTHER_EXAM, scopeWords, type ExamOption } from "../lib/exam-options";
import { KINDS } from "../lib/kinds";
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
import { jobFraction } from "../lib/progress";
import type { CourseSource, Grounding, ScopeView, StudyEvent, UnknownScope } from "../lib/types";
import { plural, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { type Loaded, useLoad } from "../use-load";
import { AutoHeight, EASE, Slide } from "./motion";
import { JobBar } from "./parts";
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
 * filled in (`draft`).
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
}) {
  const [draft, setDraft] = useState<MakeDraft>(() => given ?? emptyDraft(kind));
  const [phase, setPhase] = useState<Phase>("what");
  const [dir, setDir] = useState<1 | -1>(1);
  const [errs, setErrs] = useState<{ exam?: string; covers?: string; count?: string; kinds?: string; course?: string }>({});
  const [editScope, setEditScope] = useState(false);
  const [progress, setProgress] = useState<MakeProgress | null>(null);
  const [fraction, setFraction] = useState(0);
  const [started, setStarted] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [failure, setFailure] = useState<{ message: string; advice: Advice } | null>(null);
  const [needs, setNeeds] = useState<UnknownScope | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const run = useRef<{ n: number; id: string | null }>({ n: 0, id: null });
  const pick = useStudyPick(space, open);
  const quiz = draft.kind === "quiz";
  const noun = quiz ? "question" : "card";
  const patch = (p: Partial<MakeDraft>) => setDraft((d) => ({ ...d, ...p }));

  // A fresh flow each time it opens; a draft from chat starts at its second step.
  useEffect(() => {
    if (!open) return;
    setDraft(given ?? emptyDraft(kind));
    setPhase(given ? "how" : "what");
    setDir(1);
    setErrs({});
    setEditScope(false);
    setFailure(null);
    setNeeds(null);
    setDone(null);
    setStopping(false);
  }, [open, kind, given]);
  // One course: chosen for you.
  useEffect(() => {
    if (open && !draft.course && sources.data?.length === 1) patch({ course: sources.data[0]!.folder });
  }, [open, draft.course, sources.data]);

  const course = sources.data?.find((s) => s.folder === draft.course);
  const scope = useLoad(() => (open && draft.course ? studyScope(space, draft.course, pick.pick) : Promise.resolve(null)), [open, space, draft.course]);
  const planned = useLoad(() => (open ? planExamsGet(space).catch(() => []) : Promise.resolve([])), [open, space]);
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

  const generate = async () => {
    if (!checkHow()) return;
    const id = crypto.randomUUID();
    const n = ++run.current.n;
    run.current.id = id;
    const live = () => run.current.n === n;
    go("run");
    setProgress(null);
    setFraction(0);
    setStarted(Date.now());
    setStopping(false);
    setFailure(null);
    setNeeds(null);
    const target = draft.course ?? "";
    const said = draft.covers.trim();
    if (examTitle && target && said && said !== knownWords) {
      try {
        await studyScopeState(space, target, examTitle, said);
      } catch (e) {
        if (!live()) return;
        const message = `Couldn’t keep what ${examTitle} covers: ${cleanMessage(e)}`;
        setFailure({ message, advice: advice(message, quiz) });
        return go("error");
      }
    }
    let asked: UnknownScope | null = null;
    let failed: string | null = null;
    let finished: Done | null = null;
    let cancelled = false;
    const base = {
      count: draft.count,
      ...(draft.target === "topics" && draft.focus.trim() ? { focus: draft.focus.trim() } : {}),
      ...(draft.title.trim() ? { title: draft.title.trim() } : {}),
      ...(examTitle ? { exam: examTitle } : {}),
      ...(draft.chat?.context ? { context: draft.chat.context } : {}),
    };
    const onEvent = (e: StudyEvent) => {
      if (!live()) {
        if (e.type === "done") onChanged?.();
        return;
      }
      if (e.type === "progress") {
        setProgress(e);
        setFraction((f) => jobFraction(e, "make", f));
      } else if (e.type === "needsScope") asked = e;
      else if (e.type === "error") failed = e.message;
      else if (e.type === "cancelled") cancelled = true;
      else if (e.type === "done") finished = e;
    };
    const inputs = draft.files.length ? draft.files : [target];
    const opts = { model: pick.pick, runId: id, origin: draft.chat?.origin };
    const end = quiz
      ? await studyMakeQuiz(space, inputs, { ...base, kinds: draft.kinds, difficulty: draft.difficulty }, onEvent, opts)
      : await studyMakeDeck(space, inputs, base, onEvent, opts);
    if (!live()) return;
    run.current.id = null;
    setStopping(false);
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (end.kind === "timedOut" && !finished && !failed && !cancelled) failed = "Phaethon’s core stopped answering before it finished.";
    if (cancelled) return go("how", -1);
    if (asked) {
      setNeeds(asked);
      scope.reload();
      return go("ask", -1);
    }
    if (failed) {
      setFailure({ message: failed, advice: advice(failed, quiz) });
      return go("error");
    }
    setDone(finished ?? {});
    go("done");
    onChanged?.();
  };

  const stop = async () => {
    const id = run.current.id;
    setStopping(true);
    const stopped = id ? await studyMakeCancel(space, id).catch(() => false) : false;
    // Nothing was running in the core (it had just finished or failed): let go of it here.
    if (!stopped) {
      run.current.n++;
      setStopping(false);
      go("how", -1);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (phase === "what" && checkWhat()) go("how");
    else if (phase === "how") void generate();
    else if (phase === "ask" && draft.covers.trim()) void generate();
  };

  const close = () => onOpenChange(false);
  const busy = phase === "run";
  const step = STEP_OF[phase];
  const scopeTag = draft.target === "topics" ? draft.focus.trim() || "Anything in the course" : examTitle ? `${examTitle}${draft.covers.trim() || knownWords ? `: ${draft.covers.trim() || knownWords}` : ""}` : "";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && busy) void stop();
        onOpenChange(o);
      }}
    >
      <DialogPopup className="max-w-xl" aria-label={quiz ? "Make a quiz" : "Make cards"}>
        <form onSubmit={onSubmit} className="contents">
          <DialogHeader className="gap-3">
            <div className="flex items-center gap-3">
              <DialogTitle className="flex-1 text-lg">{quiz ? "Make a quiz" : "Make cards"}</DialogTitle>
              {phase === "what" || phase === "how" ? (
                <ToggleGroup aria-label="Kind" value={[draft.kind]} onValueChange={(v: unknown[]) => v[0] && patch({ kind: v[0] as MakeKind, count: emptyDraft(v[0] as MakeKind).count })}>
                  <ToggleGroupItem value="quiz" className="gap-1.5 text-xs">
                    <Exam weight="light" className="size-3.5" />
                    Quiz
                  </ToggleGroupItem>
                  <ToggleGroupItem value="deck" className="gap-1.5 text-xs">
                    <Cards weight="light" className="size-3.5" />
                    Cards
                  </ToggleGroupItem>
                </ToggleGroup>
              ) : null}
            </div>
            <Steps step={step} onStep={(i) => (i === 0 && phase === "how" ? go("what", -1) : undefined)} labels={["What", quiz ? "Questions" : "Cards", "Make"]} />
            <DialogDescription className="sr-only">{quiz ? "Practice questions from your course materials, checked against them." : "Flashcards from your course materials, each tied to its passage."}</DialogDescription>
          </DialogHeader>

          <DialogPanel className="space-y-0">
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
                {phase === "how" ? <HowStep draft={draft} patch={(p) => (patch(p), setErrs({}))} errs={errs} summary={[course?.name ?? "Chosen files", scopeTag].filter(Boolean).join(" · ")} onBack={() => go("what", -1)} /> : null}
                {phase === "ask" && needs ? (
                  <div className="flex flex-col gap-3 pb-1">
                    <Note icon={<MapTrifold weight="light" />} title={`What does ${needs.exam} cover?`}>
                      {needs.courseName}’s materials don’t say, and questions are only written on what’s in scope. Tap topics or say it in a few words.
                    </Note>
                    <AskScope view={scope.data ?? null} value={draft.covers} onChange={(covers) => patch({ covers })} autoFocus />
                  </div>
                ) : null}
                {phase === "run" ? <RunView progress={progress} fraction={fraction} started={started} quiz={quiz} course={course?.name} exam={examTitle || undefined} stopping={stopping} /> : null}
                {phase === "error" && failure ? (
                  <SurfaceError className="mb-1" title={failure.advice.title} message={`${failure.message}\n\n${failure.advice.hint}`} />
                ) : null}
                {phase === "done" && done ? <DoneView done={done} quiz={quiz} /> : null}
              </Slide>
            </AutoHeight>
          </DialogPanel>

          <DialogFooter className="items-center">
            {phase === "what" || phase === "how" || phase === "error" || phase === "ask" ? (
              <div className="mr-auto flex min-w-0 items-center gap-1.5" data-testid="study-model">
                <span className="shrink-0 text-muted-foreground text-xs max-sm:hidden">Model</span>
                {pick.pick ? <ModelPicker pick={pick.pick} onPick={pick.set} /> : <Skeleton className="h-4 w-28" />}
              </div>
            ) : null}
            {phase === "what" ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!sources.data?.length}>
                  Next
                </Button>
              </>
            ) : null}
            {phase === "how" ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => go("what", -1)}>
                  <ArrowLeft />
                  Back
                </Button>
                <Button type="submit" size="sm">
                  <Sparkle weight="light" />
                  {`Make ${plural(draft.count || 0, noun)}`}
                </Button>
              </>
            ) : null}
            {phase === "ask" ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={() => go("what", -1)}>
                  Change test
                </Button>
                <Button type="submit" size="sm" disabled={!draft.covers.trim()}>
                  <Sparkle weight="light" />
                  Make it
                </Button>
              </>
            ) : null}
            {phase === "run" ? (
              <Button type="button" size="sm" variant="outline" disabled={stopping} onClick={() => void stop()}>
                {stopping ? <Spinner size="sm" /> : null}
                {stopping ? "Stopping…" : "Stop"}
              </Button>
            ) : null}
            {phase === "error" && failure ? (
              <>
                {failure.advice.action === "model" ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => (close(), useNav.getState().openSettings("providers"))}>
                    Open settings
                  </Button>
                ) : null}
                <Button type="button" size="sm" variant="ghost" onClick={() => go(failure.advice.action === "scope" || failure.advice.action === "focus" ? "what" : "how", -1)}>
                  {failure.advice.action === "scope" || failure.advice.action === "focus" ? "Change what" : "Back"}
                </Button>
                <Button type="button" size="sm" onClick={() => void generate()}>
                  Try again
                </Button>
              </>
            ) : null}
            {phase === "done" && done ? (
              <>
                <Button type="button" size="sm" variant="ghost" onClick={close}>
                  Close
                </Button>
                {done.path ? (
                  <Button type="button" size="sm" onClick={() => (close(), onOpen(quiz ? { kind: "quiz", path: done.path! } : { kind: "review", paths: [done.path!] }))}>
                    {quiz ? "Take the quiz" : "Start learning"}
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
function useStudyPick(space: string, open: boolean): { pick: ModelPick | null; set: (p: ModelPick) => void } {
  const saved = useStudyFlow((s) => s.pick);
  const setPick = useStudyFlow((s) => s.setPick);
  const chat = useSpaceChat(space).pick?.pick ?? null;
  const [fetched, setFetched] = useState<ModelPick | null>(null);
  useEffect(() => {
    if (!open || saved || chat) return;
    let live = true;
    threadModelGet(space).then(
      (v) => live && setFetched(v.pick),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, saved, chat, space]);
  return { pick: saved ?? chat ?? fetched, set: setPick };
}

function Steps({ step, labels, onStep }: { step: number; labels: string[]; onStep: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-1.5 text-xs" aria-label="Steps">
      {labels.map((l, i) => (
        <li key={l} className="flex items-center gap-1.5">
          {i > 0 ? <span className={cn("h-px w-5 bg-border transition-colors", i <= step && "bg-primary/50")} aria-hidden /> : null}
          <button
            type="button"
            disabled={i >= step}
            onClick={() => onStep(i)}
            aria-current={i === step ? "step" : undefined}
            className={cn("flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors enabled:hover:text-foreground", i === step && "font-medium text-foreground")}
          >
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full border text-3xs tabular-nums transition-colors",
                i < step && "border-primary bg-primary text-primary-foreground",
                i === step && "border-primary text-primary",
              )}
            >
              {i < step ? <CheckCircle weight="bold" className="size-3" /> : i + 1}
            </span>
            {l}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Field({ label, htmlFor, children, hint }: { label: string; htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint ? <span className="text-muted-foreground text-xs">{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Note({ icon, title, children, tone = "muted" }: { icon: ReactNode; title: ReactNode; children?: ReactNode; tone?: "muted" | "primary" }) {
  return (
    <div className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5", tone === "primary" ? "border-primary/20 bg-primary/5" : "bg-muted/40")}>
      <span className={cn("mt-0.5 shrink-0 text-muted-foreground [&_svg]:size-4", tone === "primary" && "text-primary")}>{icon}</span>
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium [overflow-wrap:anywhere]">{title}</p>
        {children ? <div className="mt-0.5 text-muted-foreground text-xs [overflow-wrap:anywhere]">{children}</div> : null}
      </div>
    </div>
  );
}

// ---- Step 1: what ----

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
      <div className="flex flex-col gap-3 motion-safe:animate-skeleton" aria-hidden>
        <Skeleton className="h-7 w-full animate-none" />
        <Skeleton className="h-7 w-2/3 animate-none" />
        <Skeleton className="h-16 w-full animate-none" />
      </div>
    );
  if (!sources.data.length)
    return (
      <Empty size="compact" className="min-h-0 rounded-lg border p-6 md:p-6">
        <EmptyHeader>
          <EmptyTitle className="text-sm">No courses in this space</EmptyTitle>
          <EmptyDescription className="text-xs">Import a course, or give this space access to one, to make questions from it.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button type="button" size="xs" variant="outline" onClick={() => (onClose(), useNav.getState().setView("courses"))}>
            Open courses
          </Button>
        </EmptyContent>
      </Empty>
    );

  return (
    <div className="flex flex-col gap-4 pb-1">
      <Field label="Course">
        <Select value={draft.course ?? ""} onValueChange={(v) => patch({ course: (v as string) || null, files: [], exam: "", covers: "" })}>
          <SelectTrigger size="sm" aria-label="Course" aria-invalid={errs.course ? true : undefined}>
            <SelectValue>{(v: string) => sources.data?.find((s) => s.folder === v)?.name ?? "Choose a course"}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {sources.data.map((s) => (
              <SelectItem key={s.folder} value={s.folder}>
                {s.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <FieldError>{errs.course}</FieldError>
      </Field>

      <Field label="For">
        <ToggleGroup aria-label="For" className="w-full" value={[draft.target]} onValueChange={(v: unknown[]) => v[0] && patch({ target: v[0] as MakeDraft["target"] })}>
          <ToggleGroupItem value="exam" className="flex-1 gap-1.5 text-xs">
            <Target weight="light" className="size-3.5" />A test
          </ToggleGroupItem>
          <ToggleGroupItem value="topics" className="flex-1 gap-1.5 text-xs">
            <BookOpenText weight="light" className="size-3.5" />
            Topics
          </ToggleGroupItem>
        </ToggleGroup>
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
              <SelectTrigger size="sm" aria-label="Test" aria-invalid={errs.exam ? true : undefined}>
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
            <div className="flex items-center gap-1.5">
              <Input size="sm" aria-label="Test name" placeholder="Test name, e.g. Midterm 2" value={draft.exam} aria-invalid={errs.exam ? true : undefined} onChange={(e) => patch({ exam: e.target.value })} />
              {options.length ? (
                <Button type="button" size="xs" variant="ghost-muted" onClick={() => (setOther(false), patch({ exam: "" }))}>
                  Pick from list
                </Button>
              ) : null}
            </div>
          )}
          <FieldError>{errs.exam}</FieldError>
          <AnimatePresence initial={false}>
            {scopeNow.kind !== "none" ? (
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
          <Input size="sm" aria-label="Topics" placeholder="e.g. induction proofs, power sets (empty for anything)" value={draft.focus} onChange={(e) => patch({ focus: e.target.value })} />
          {suggestions.topics.length ? <Chips items={suggestions.topics} value={draft.focus} onChange={(focus) => patch({ focus })} /> : null}
        </div>
      )}

      {course ? (
        <Collapsible defaultOpen={draft.files.length > 0}>
          <CollapsibleTrigger className="text-muted-foreground text-xs hover:text-foreground">
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
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2.5" data-testid="scope-known">
        <div className="flex items-start gap-2.5">
          <CheckCircle weight="light" className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="[overflow-wrap:anywhere]">
              <span className="text-muted-foreground">{state.kind === "stated" ? "You said it covers " : "Covers "}</span>
              {covers.trim() || state.words}
            </p>
            {evidence.length ? (
              <div className="-mx-0.5 mt-1 flex flex-wrap items-center gap-y-1 text-xs">
                <span className="px-0.5 text-muted-foreground">From</span>
                {evidence.slice(0, 3).map((e) => (
                  <CitationChip key={`${e.source}${e.quote}`} space={space} citation={{ path: e.source, quote: e.quote }} />
                ))}
              </div>
            ) : null}
          </div>
          {!edit ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={() => (onCovers(covers || state.words), setEdit(true))}>
              <PencilSimpleLine weight="light" />
              Edit
            </Button>
          ) : null}
        </div>
        {edit ? <Textarea size="sm" rows={2} aria-label={`What ${exam} covers`} value={covers} onChange={(e) => onCovers(e.target.value)} autoFocus /> : null}
      </div>
    );
  }

  if (state.kind === "unchecked") {
    return (
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 px-3 py-2.5">
        <div className="relative flex items-start gap-2.5 overflow-hidden">
          <MapTrifold weight="light" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">{mapping ? `Reading ${courseName}…` : `Phaethon finds what ${exam || "it"} covers in ${courseName}`}</p>
            <p className="mt-0.5 text-muted-foreground text-xs">
              {mapping ? "Finding what it teaches and what each test covers. The first time takes a few minutes." : "It reads the course once when you make it, or look it up now. You can also say it yourself."}
            </p>
            {mapping ? (
              <div className="relative mt-2 h-0.5 overflow-hidden rounded-full">
                <JobBar value={mapping.fraction} />
              </div>
            ) : null}
            {mapping?.error ? <FieldError className="mt-1.5">{mapping.error}</FieldError> : null}
          </div>
          {mapping && !mapping.error ? (
            <Button type="button" size="xs" variant="ghost-muted" onClick={() => void studyMakeCancel(space, mapping.id)}>
              Stop
            </Button>
          ) : (
            <Button type="button" size="xs" variant="outline" onClick={() => void lookUp()}>
              {mapping?.error ? "Try again" : "Look it up"}
            </Button>
          )}
        </div>
        <Textarea size="sm" rows={2} aria-label={`What ${exam} covers`} placeholder="Or say it: e.g. chapters 1–4, through Problem set 6, no proofs" value={covers} onChange={(e) => onCovers(e.target.value)} />
      </div>
    );
  }

  // Read, and the course doesn't say: ask, with its topics as suggestions.
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5" data-testid="scope-ask">
      <div className="flex items-start gap-2.5">
        <MapTrifold weight="light" className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
        <div className="min-w-0 flex-1 text-sm">
          <p className="font-medium">What does {exam || "this test"} cover?</p>
          <p className="mt-0.5 text-muted-foreground text-xs">{courseName}’s materials don’t say. Questions are only written on what you list here.</p>
        </div>
      </div>
      <AskScope view={view} value={covers} onChange={onCovers} />
      <FieldError>{error}</FieldError>
    </div>
  );
}

function AskScope({ view, value, onChange, autoFocus }: { view: ScopeView | null; value: string; onChange: (s: string) => void; autoFocus?: boolean }) {
  const s = scopeSuggestions(view);
  return (
    <div className="flex flex-col gap-2">
      <Textarea size="sm" rows={2} aria-label="What it covers" placeholder="e.g. chapters 1–4, through Problem set 6, no proofs" value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} />
      {s.topics.length || s.through.length ? <Chips items={[...s.through, ...s.topics]} value={value} onChange={onChange} /> : null}
    </div>
  );
}

function Chips({ items, value, onChange }: { items: string[]; value: string; onChange: (s: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Suggestions">
      {items.map((t) => {
        const on = hasSuggestion(value, t);
        return (
          <Toggle
            key={t}
            size="xs"
            variant="outline"
            pressed={on}
            onPressedChange={() => onChange(toggleSuggestion(value, t))}
            className="max-w-full rounded-full px-2 font-normal text-xs data-pressed:border-primary/40 data-pressed:bg-primary/8 data-pressed:text-foreground"
          >
            <Truncate className="min-w-0">{t}</Truncate>
          </Toggle>
        );
      })}
    </div>
  );
}

// ---- Step 2: how ----

function HowStep({ draft, patch, errs, summary, onBack }: { draft: MakeDraft; patch: (p: Partial<MakeDraft>) => void; errs: { count?: string; kinds?: string }; summary: string; onBack: () => void }) {
  const quiz = draft.kind === "quiz";
  const sizes = SIZES[draft.kind];
  const preset = sizes.includes(draft.count) ? String(draft.count) : "";
  return (
    <div className="flex flex-col gap-4 pb-1">
      <button type="button" onClick={onBack} className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60">
        <Target weight="light" className="size-4 shrink-0 text-muted-foreground" />
        <Truncate className="min-w-0 flex-1">{summary}</Truncate>
        <span className="shrink-0 text-muted-foreground text-xs">Change</span>
      </button>

      <Field label="How many" hint={errs.count ? undefined : `Up to ${MAX_COUNT[draft.kind]}`}>
        <div className="flex items-center gap-2">
          <ToggleGroup aria-label="How many" value={preset ? [preset] : []} onValueChange={(v: unknown[]) => v[0] && patch({ count: Number(v[0]) })}>
            {sizes.map((n) => (
              <ToggleGroupItem key={n} value={String(n)} className="min-w-10 text-xs tabular-nums">
                {n}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Input
            size="sm"
            aria-label="Exact number"
            inputMode="numeric"
            className="w-16 tabular-nums"
            value={draft.count ? String(draft.count) : ""}
            aria-invalid={errs.count ? true : undefined}
            onChange={(e) => patch({ count: Number(e.target.value.replace(/[^\d]/g, "")) || 0 })}
          />
        </div>
        <FieldError>{errs.count}</FieldError>
      </Field>

      {quiz ? (
        <>
          <Field label="Difficulty">
            <ToggleGroup aria-label="Difficulty" className="w-full" value={[draft.difficulty]} onValueChange={(v: unknown[]) => v[0] && patch({ difficulty: v[0] as MakeDraft["difficulty"] })}>
              <ToggleGroupItem value="easier" className="flex-1 text-xs">
                Easier
              </ToggleGroupItem>
              <ToggleGroupItem value="exam" className="flex-1 text-xs">
                Like the test
              </ToggleGroupItem>
              <ToggleGroupItem value="harder" className="flex-1 text-xs">
                Harder
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field label="Kinds of question">
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <Toggle
                  key={k.kind}
                  size="xs"
                  variant="outline"
                  className="px-2 font-normal text-xs data-pressed:border-primary/40 data-pressed:bg-primary/8 data-pressed:text-foreground"
                  pressed={draft.kinds.includes(k.kind)}
                  onPressedChange={(p) => patch({ kinds: p ? [...draft.kinds, k.kind] : draft.kinds.filter((x) => x !== k.kind) })}
                >
                  {k.label}
                </Toggle>
              ))}
            </div>
            <FieldError>{errs.kinds}</FieldError>
          </Field>
        </>
      ) : null}

      <Field label="Name" htmlFor="make-title">
        <Input id="make-title" size="sm" placeholder="Named for you if left empty" value={draft.title} maxLength={120} onChange={(e) => patch({ title: e.target.value })} />
      </Field>
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
    <div className="relative overflow-hidden rounded-lg border bg-muted/20 px-3 pt-4 pb-3" aria-live="polite" data-testid="make-progress">
      <JobBar value={fraction} />
      <ol className="flex flex-col gap-2.5">
        {list.map((s) => (
          <motion.li key={s.id} layout="position" className="flex items-start gap-2.5" data-state={s.state}>
            <span className="relative mt-0.5 flex size-4 shrink-0 items-center justify-center">
              <AnimatePresence mode="popLayout" initial={false}>
                {s.state === "done" ? (
                  <motion.span key="done" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 520, damping: 28 }}>
                    <CheckCircle weight="fill" className="size-4 text-success" />
                  </motion.span>
                ) : s.state === "active" ? (
                  <motion.span key="active" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                    <Spinner size="sm" className="text-primary" />
                  </motion.span>
                ) : (
                  <motion.span key="pending" className="size-1.5 rounded-full bg-border" />
                )}
              </AnimatePresence>
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm transition-colors", s.state === "pending" ? "text-muted-foreground" : "text-foreground", s.state === "active" && "font-medium")}>{s.label}</p>
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
      <p className="mt-3 border-t pt-2 text-muted-foreground text-xs tabular-nums">
        {stopping ? "Stopping…" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} · You can close this; it keeps going and shows up in Study.`}
      </p>
    </div>
  );
}

function DoneView({ done, quiz }: { done: Done; quiz: boolean }) {
  const g = done.grounding;
  const noun = quiz ? "question" : "card";
  const dropped = g ? g.asked - g.kept : 0;
  return (
    <div className="flex flex-col gap-3 pb-1">
      <motion.div initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.2, ease: EASE }} className="flex gap-3 rounded-lg border border-success/25 bg-success/5 px-3 py-3">
        <CheckCircle weight="fill" className="mt-0.5 size-5 shrink-0 text-success" />
        <div className="min-w-0 text-sm">
          <p className="font-medium tabular-nums">{quiz ? `Made a quiz of ${plural(done.questions ?? 0, "question")}` : `Made ${plural(done.cards ?? 0, "card")}`}</p>
          <p className="mt-0.5 text-muted-foreground text-xs [overflow-wrap:anywhere]">
            {[g?.exam ? `For ${g.exam}${g.scope ? `: ${g.scope}` : ""}.` : null, `Each ${noun} was checked against your materials${dropped ? `; ${plural(dropped, noun)} that didn’t match ${dropped === 1 ? "was" : "were"} left out` : ""}.`]
              .filter(Boolean)
              .join(" ")}
          </p>
        </div>
      </motion.div>
      {g?.coverage.some((c) => c.count > 0) ? (
        <div className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs">By topic</p>
          <ul className="flex flex-wrap gap-1">
            {g.coverage.filter((c) => c.count > 0).map((c) => (
              <li key={c.topic} className="flex items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                <span className="max-w-48 truncate">{c.topic}</span>
                <span className="text-muted-foreground tabular-nums">{c.count}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
