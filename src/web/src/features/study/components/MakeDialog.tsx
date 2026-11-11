import { Cards, Exam } from "@phosphor-icons/react";
import { CircleCheckIcon, MapIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, SurfaceError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { planExamsGet } from "@/features/plan/api";
import { cn } from "@/lib/utils";
import { studyMakeDeck, studyMakeQuiz, studyScope, studyScopeBuild, studyScopeState } from "../api";
import { examDate, examOptions, OTHER_EXAM, scopeWords, type ExamOption } from "../lib/exam-options";
import { coursesOf, KINDS } from "../lib/kinds";
import { countText, jobFraction } from "../lib/progress";
import type { CourseSource, Grounding, QuestionKind, StudyEvent, UnknownScope } from "../lib/types";
import { needsModel, plural, progressWords, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { type Loaded, useLoad } from "../use-load";
import { JobBar, JobLine } from "./parts";
import { SourcePicker } from "./SourcePicker";

type Phase = "setup" | "running" | "scope" | "mapping" | "done" | "error";
type Done = { path?: string; cards?: number; questions?: number; grounding?: Grounding };
const ANY = "\u0000any";

/**
 * Make a deck or a quiz from chosen course materials. The run streams its
 * steps (a 2 px bar, the step in words, done/total); a quiz for a test whose
 * scope isn't known stops with `needsScope`, and the dialog offers to map the
 * course first, then runs again.
 */
export function MakeDialog({
  space,
  kind,
  open,
  onOpenChange,
  sources,
  onChanged,
  onOpen,
}: {
  space: string;
  kind: "deck" | "quiz";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: Loaded<CourseSource[]>;
  onChanged: () => void;
  onOpen: (s: StudyScreen) => void;
}) {
  const quiz = kind === "quiz";
  const [phase, setPhase] = useState<Phase>("setup");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [count, setCount] = useState(quiz ? "8" : "12");
  const [kinds, setKinds] = useState<QuestionKind[]>(["choice", "multi", "truefalse", "short"]);
  const [difficulty, setDifficulty] = useState<"easier" | "exam" | "harder">("exam");
  const [focus, setFocus] = useState("");
  const [title, setTitle] = useState("");
  const [exam, setExam] = useState<string>(ANY);
  const [otherExam, setOtherExam] = useState("");
  const [covers, setCovers] = useState("");
  const [fieldError, setFieldError] = useState<{ sources?: string; count?: string; kinds?: string; exam?: string }>({});
  const [progress, setProgress] = useState<MakeProgress | null>(null);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<UnknownScope | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const run = useRef(0);

  // A fresh dialog each time it opens; one course is chosen whole by default.
  useEffect(() => {
    if (!open) return;
    setPhase("setup");
    setError(null);
    setNeeds(null);
    setDone(null);
    setFieldError({});
    setCount(kind === "quiz" ? "8" : "12");
    setExam(ANY);
    setCovers("");
    setOtherExam("");
  }, [open, kind]);
  useEffect(() => {
    if (open && sources.data?.length === 1 && chosen.size === 0) {
      const c = sources.data[0]!;
      setChosen(new Set((["syllabus", "assignments", "files", "readings"] as const).filter((p) => c[p]).map((p) => (p === "syllabus" || p === "assignments" ? `${c.folder}/${p}.md` : `${c.folder}/${p}`))));
    }
  }, [open, sources.data, chosen.size]);

  const folders = useMemo(() => (sources.data ?? []).map((s) => s.folder), [sources.data]);
  const courseFolders = coursesOf(chosen, folders);
  const course = courseFolders.length === 1 ? sources.data?.find((s) => s.folder === courseFolders[0]) : undefined;
  const scope = useLoad(() => (open && course ? studyScope(space, course.folder) : Promise.resolve(null)), [open, space, course?.folder]);
  const planned = useLoad(() => (open ? planExamsGet(space).catch(() => []) : Promise.resolve([])), [open, space]);
  const options: ExamOption[] = useMemo(
    () => (course ? examOptions({ name: course.name, folder: course.folder }, scope.data ?? null, planned.data ?? []) : []),
    [course, scope.data, planned.data],
  );
  const picked = options.find((o) => o.title === exam);
  const examTitle = exam === OTHER_EXAM ? otherExam.trim() : exam === ANY ? "" : exam;
  const scopeUnknown = exam === OTHER_EXAM || (picked && (picked.state === "unknown" || picked.state === "unchecked"));

  const noun = quiz ? "question" : "card";
  const n = Number(count);

  const start = async () => {
    const errs: typeof fieldError = {};
    if (!chosen.size) errs.sources = "Choose at least one thing to read.";
    if (!Number.isInteger(n) || n < 1 || n > 60) errs.count = "From 1 to 60.";
    if (quiz && !kinds.length) errs.kinds = "Pick at least one kind.";
    if (exam === OTHER_EXAM && !otherExam.trim()) errs.exam = "Name the test.";
    setFieldError(errs);
    if (Object.keys(errs).length) return;
    const id = ++run.current;
    setPhase("running");
    setProgress(null);
    setFraction(0);
    setError(null);
    setNeeds(null);
    try {
      if (course && examTitle && scopeUnknown && covers.trim()) await studyScopeState(space, course.folder, examTitle, covers.trim());
    } catch (e) {
      if (run.current !== id) return;
      setError(`Couldn’t save what ${examTitle} covers: ${cleanMessage(e)}`);
      setPhase("error");
      return;
    }
    let asked: UnknownScope | null = null;
    let failed: string | null = null;
    let finished: Done | null = null;
    const base = { count: n, ...(focus.trim() ? { focus: focus.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(examTitle ? { exam: examTitle } : {}) };
    const onEvent = (e: StudyEvent) => {
      if (run.current !== id) {
        // Cancelled here, still finishing in the core: show what it made once it lands.
        if (e.type === "done") onChanged();
        return;
      }
      if (e.type === "progress") {
        setProgress(e);
        setFraction((f) => jobFraction(e, "make", f));
      } else if (e.type === "needsScope") asked = e;
      else if (e.type === "error") failed = e.message;
      else if (e.type === "done") finished = e;
    };
    const end = quiz ? await studyMakeQuiz(space, [...chosen], { ...base, kinds, difficulty }, onEvent) : await studyMakeDeck(space, [...chosen], base, onEvent);
    if (run.current !== id) return;
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (end.kind === "timedOut" && !finished && !failed) failed = "Phaethon’s core stopped answering before it finished.";
    if (asked) {
      setNeeds(asked);
      setPhase("scope");
    } else if (failed) {
      setError(failed);
      setPhase("error");
    } else {
      setDone(finished ?? {});
      setPhase("done");
      onChanged();
    }
  };

  const mapCourse = async () => {
    if (!needs) return;
    const id = ++run.current;
    setPhase("mapping");
    setProgress(null);
    setFraction(0);
    setError(null);
    let failed: string | null = null;
    const end = await studyScopeBuild(space, needs.course, (e) => {
      if (run.current !== id) return;
      if (e.type === "progress") {
        setProgress(e);
        setFraction((f) => jobFraction(e, "single", f));
      } else if (e.type === "error") failed = e.message;
    });
    if (run.current !== id) return;
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (failed) {
      setError(failed);
      setPhase("scope");
      return;
    }
    scope.reload();
    void start();
  };

  const cancel = () => {
    run.current++;
    setPhase("setup");
  };

  const close = () => onOpenChange(false);
  const busy = phase === "running" || phase === "mapping";

  return (
    <Dialog open={open} onOpenChange={(o) => {
        if (!o && busy) cancel();
        onOpenChange(o);
      }}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg">{quiz ? "Make a quiz" : "Make cards"}</DialogTitle>
          <DialogDescription>{quiz ? "Practice questions from your course materials, checked against them." : "Flashcards from your course materials, each tied to the passage it comes from."}</DialogDescription>
        </DialogHeader>

        {phase === "setup" ? (
          <>
            <DialogPanel className="flex flex-col gap-4 space-y-0">
              {sources.error ? (
                <SurfaceError title="Couldn’t list your courses" message={cleanMessage(sources.error)} onRetry={sources.reload} />
              ) : !sources.data ? (
                <div className="flex flex-col gap-1.5 rounded-lg border p-2 motion-safe:animate-skeleton" aria-hidden>
                  {["58%", "44%"].map((w) => (
                    <div key={w} className="flex h-7 items-center gap-2 px-1">
                      <Skeleton className="size-4 animate-none rounded-[4px]" />
                      <Skeleton className="h-2.5 animate-none" style={{ width: w }} />
                    </div>
                  ))}
                </div>
              ) : !sources.data.length ? (
                <Empty size="compact" className="min-h-0 rounded-lg border p-6 md:p-6">
                  <EmptyHeader>
                    <EmptyTitle className="text-sm">No courses in this space</EmptyTitle>
                    <EmptyDescription className="text-xs">Import a course, or give this space access to one, to make {noun}s from it.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        close();
                        useNav.getState().setView("courses");
                      }}
                    >
                      Open courses
                    </Button>
                  </EmptyContent>
                </Empty>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <Label>From</Label>
                  <SourcePicker space={space} sources={sources.data} chosen={chosen} onChange={(s) => (setChosen(s), setFieldError((f) => ({ ...f, sources: undefined })))} />
                  <FieldError>{fieldError.sources}</FieldError>
                </div>
              )}

              {course && options.length ? (
                <div className="flex flex-col gap-1.5">
                  <Label>For a test</Label>
                  <Select value={exam} onValueChange={(v) => setExam((v as string) ?? ANY)}>
                    <SelectTrigger size="sm">
                      <SelectValue>{(v: string) => (v === ANY ? "Anything in the material" : v === OTHER_EXAM ? "Another test" : v)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={ANY}>Anything in the material</SelectItem>
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
                  {exam === OTHER_EXAM ? (
                    <>
                      <Input size="sm" placeholder="Test name, e.g. Final exam" value={otherExam} aria-invalid={fieldError.exam ? true : undefined} onChange={(e) => setOtherExam(e.target.value)} />
                      <FieldError>{fieldError.exam}</FieldError>
                    </>
                  ) : null}
                  {picked ? <ExamNote option={picked} /> : null}
                  {scopeUnknown ? <Input size="sm" placeholder="What it covers, if you know (e.g. chapters 1–4, no proofs)" value={covers} onChange={(e) => setCovers(e.target.value)} /> : null}
                </div>
              ) : null}

              <div className="grid grid-cols-[6rem_1fr] gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="make-count">How many</Label>
                  <Input id="make-count" size="sm" inputMode="numeric" className="tabular-nums" value={count} aria-invalid={fieldError.count ? true : undefined} onChange={(e) => setCount(e.target.value.replace(/[^\d]/g, ""))} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="make-focus">Focus</Label>
                  <Input id="make-focus" size="sm" placeholder="Optional, e.g. induction proofs" value={focus} onChange={(e) => setFocus(e.target.value)} />
                </div>
              </div>
              <FieldError className="-mt-2">{fieldError.count}</FieldError>

              {quiz ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label>Kinds of question</Label>
                    <div className="flex flex-wrap gap-1">
                      {KINDS.map((k) => (
                        <Toggle
                          key={k.kind}
                          size="xs"
                          variant="outline"
                          className="px-2 font-normal text-xs data-pressed:border-primary/40 data-pressed:bg-primary/8 data-pressed:text-foreground"
                          pressed={kinds.includes(k.kind)}
                          onPressedChange={(p) => setKinds((ks) => (p ? [...ks, k.kind] : ks.filter((x) => x !== k.kind)))}
                        >
                          {k.label}
                        </Toggle>
                      ))}
                    </div>
                    <FieldError>{fieldError.kinds}</FieldError>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <Label>Difficulty</Label>
                    <ToggleGroup value={[difficulty]} onValueChange={(v: unknown[]) => v[0] && setDifficulty(v[0] as typeof difficulty)}>
                      <ToggleGroupItem value="easier" className="text-xs">
                        Easier
                      </ToggleGroupItem>
                      <ToggleGroupItem value="exam" className="text-xs">
                        Like the exam
                      </ToggleGroupItem>
                      <ToggleGroupItem value="harder" className="text-xs">
                        Harder
                      </ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                </>
              ) : null}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="make-title">Name</Label>
                <Input id="make-title" size="sm" placeholder={quiz ? "Named for you if left empty" : "Named for you if left empty"} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" disabled={!sources.data?.length} onClick={() => void start()}>
                {quiz ? <Exam /> : <Cards />}
                {Number.isInteger(n) && n > 0 ? `Make ${plural(n, noun)}` : `Make ${noun}s`}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase === "running" || phase === "mapping" ? (
          <>
            <DialogPanel>
              <div className="relative overflow-hidden rounded-lg border bg-muted/30 px-3 pt-3.5 pb-3">
                <JobBar value={fraction} />
                <JobLine
                  label={
                    phase === "mapping"
                      ? progressWords(progress ?? { step: "mapping", done: 0, total: 1 }, { quiz, course: needs?.courseName, exam: needs?.exam })
                      : progress
                        ? progressWords(progress, { quiz, course: course?.name, exam: examTitle || undefined })
                        : "Getting started…"
                  }
                  count={countText(progress)}
                />
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase === "scope" && needs ? (
          <>
            <DialogPanel className="flex flex-col gap-3 space-y-0">
              <div className="flex gap-3 rounded-lg border bg-muted/30 p-3">
                <MapIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                <div className="min-w-0 text-sm">
                  <p className="font-medium [overflow-wrap:anywhere]">I don’t know what {needs.exam} covers yet</p>
                  <p className="mt-0.5 text-muted-foreground text-xs [overflow-wrap:anywhere]">
                    To keep the questions on what’s tested, I can read {needs.courseName} once to see what it teaches and what each test covers. The first time takes a few minutes.
                  </p>
                </div>
              </div>
              {error ? <SurfaceError title="Couldn’t map the course" message={error} /> : null}
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setPhase("setup")}>
                Back
              </Button>
              <Button size="sm" onClick={() => void mapCourse()}>
                {error ? "Try again" : "Map the course"}
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase === "error" && error ? (
          <>
            <DialogPanel>
              <SurfaceError
                title={quiz ? "Couldn’t make the quiz" : "Couldn’t make the cards"}
                message={error}
                actions={
                  needsModel(error)
                    ? [
                        {
                          label: "Open settings",
                          onClick: () => {
                            close();
                            useNav.getState().openSettings("providers");
                          },
                        },
                      ]
                    : []
                }
              />
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={() => setPhase("setup")}>
                Back
              </Button>
              <Button size="sm" onClick={() => void start()}>
                Try again
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {phase === "done" && done ? (
          <>
            <DialogPanel>
              <div className="flex gap-3 rounded-lg border bg-muted/30 p-3">
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" strokeWidth={2} />
                <div className="min-w-0 text-sm">
                  <p className="font-medium tabular-nums">
                    {quiz ? `Made a quiz of ${plural(done.questions ?? 0, "question")}` : `Made ${plural(done.cards ?? 0, "card")}`}
                  </p>
                  {done.grounding ? <GroundingNote g={done.grounding} noun={noun} /> : null}
                </div>
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={close}>
                Close
              </Button>
              {done.path ? (
                <Button size="sm" onClick={() => onOpen(quiz ? { kind: "quiz", path: done.path! } : { kind: "review", paths: [done.path!] })}>
                  {quiz ? "Take the quiz" : "Start learning"}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function ExamNote({ option }: { option: ExamOption }) {
  const text =
    option.state === "known" && option.scope
      ? `Covers ${scopeWords(option.scope)}.`
      : option.state === "stated"
        ? `You said it covers: ${option.stated}`
        : option.state === "unknown"
          ? "The course materials don’t say what it covers."
          : "Not looked up yet: the course is read first to find what it covers.";
  return <p className={cn("text-muted-foreground text-xs [overflow-wrap:anywhere]", option.state === "known" && "text-foreground/80")}>{text}</p>;
}

function GroundingNote({ g, noun }: { g: Grounding; noun: string }) {
  const parts = [
    g.exam ? `For ${g.exam}${g.scope ? ` (${g.scope})` : ""}.` : null,
    g.asked > g.kept ? `${g.asked - g.kept} ${g.asked - g.kept === 1 ? `${noun} was` : `${noun}s were`} dropped for not matching your materials.` : null,
  ].filter(Boolean);
  return parts.length ? <p className="mt-0.5 text-muted-foreground text-xs [overflow-wrap:anywhere]">{parts.join(" ")}</p> : null;
}
