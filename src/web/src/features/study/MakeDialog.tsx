/**
 * Making practice, one decision per step: what (flashcards or a quiz) and
 * from which course or parts of it; which test it is for (with what is known
 * of its scope and where that comes from); for a quiz, the kinds of question
 * and how hard; how many and a focus; then a look at all of it. The core reads
 * the course, writes, and checks every item against the passages; progress
 * streams in, and the result shows what passed and which passages back it.
 */
import { CheckIcon, ClipboardListIcon, LayersIcon, SettingsIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { courseFolder, folderKey, GENERAL } from "../courses/lib/selection";
import { announce } from "../courses/shared/announce";
import { LiveText, Progress } from "../courses/shared/kit";
import { planExamsGet, type Exam } from "../plan/api";
import { studyMakeDeck, studyMakeQuiz, studyScope, studyScopeState } from "./api";
import { Disclosure, GroundingSummary, MaterialNote, Passage } from "./Grounding";
import { examDate, examOptions, OTHER_EXAM, scopeTopics, scopeWords, type ExamOption } from "./lib/exam-options";
import type { CourseSource, Grounding, QuestionKind, ScopeView, StudyEvent, UnknownScope } from "./lib/types";
import { COURSE_PARTS, needsModel, plainError, plural, progressWords, type CourseFolder, type MakeProgress } from "./lib/words";
import type { MakeKind, MakeRequest } from "./store";

const COUNT_MIN = 3;
const COUNT_MAX = 60;
const KINDS: { kind: QuestionKind; label: string }[] = [
  { kind: "choice", label: "Multiple choice" },
  { kind: "multi", label: "Choose all that apply" },
  { kind: "truefalse", label: "True or false" },
  { kind: "short", label: "Short answer" },
  { kind: "cloze", label: "Fill in the blank" },
];
const DIFFICULTY = [
  { value: "easier", label: "Easier", hint: "Recall of definitions and facts" },
  { value: "exam", label: "Exam level", hint: "Like the course’s own tests" },
  { value: "harder", label: "Harder", hint: "Several steps of reasoning" },
] as const;

type Step = "what" | "exam" | "questions" | "details" | "review";
const STEP_NAMES: Record<Step, string> = { what: "What", exam: "Test", questions: "Questions", details: "Details", review: "Check" };

export type Made = { kind: MakeKind; path: string; count: number; next: "study" | "open" | "take" | null };

type Phase =
  | { at: "form" }
  | ({ at: "running" } & MakeProgress)
  | { at: "done"; path: string; count: number; grounding?: Grounding }
  | { at: "error"; message: string; needs?: UnknownScope };

export function MakeDialog({ space, request, sources, onClose, onMade }: { space: string; request: MakeRequest | null; sources: CourseSource[]; onClose: () => void; onMade: (m: Made) => void }) {
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      {request && <MakeFlow key={request.key} space={space} request={request} sources={sources} onClose={onClose} onMade={onMade} />}
    </Dialog>
  );
}

function MakeFlow({ space, request, sources, onClose, onMade }: { space: string; request: MakeRequest; sources: CourseSource[]; onClose: () => void; onMade: (m: Made) => void }) {
  const id = useId();
  const openSettings = useNav((s) => s.openSettings);
  const go = useNav((s) => s.go);
  const fromAttempt = request.fromAttempt;
  const [kind, setKind] = useState<MakeKind>(request.kind ?? (fromAttempt ? "deck" : "deck"));
  const quiz = kind === "quiz";
  const courses: CourseFolder[] = useMemo(() => sources.map((s) => ({ name: s.name, folder: courseFolder(s.folder) })), [sources]);
  const initial = request.course && request.course !== GENERAL ? courseFolder(request.course) : courses.length === 1 ? courses[0]!.folder : null;
  const [chosen, setChosen] = useState<string[]>(initial && courses.some((c) => c.folder === initial) ? [initial] : []);
  const [exam, setExam] = useState("");
  const [otherName, setOtherName] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [kinds, setKinds] = useState<QuestionKind[]>(["choice", "truefalse", "short"]);
  const [difficulty, setDifficulty] = useState<"easier" | "exam" | "harder">("exam");
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState("");
  const [title, setTitle] = useState("");
  const [step, setStep] = useState<Step>("what");
  const [problem, setProblem] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "form" });
  const [examInfo, setExamInfo] = useState<{ course: string; view: ScopeView | null; planned: Exam[]; loading: boolean } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const started = useRef(false);

  const inCourses = [...new Set(chosen.map((c) => c.split("/").slice(0, 2).join("/")))];
  const oneCourse = inCourses.length === 1 ? courses.find((c) => c.folder === inCourses[0]) : undefined;
  const steps: Step[] = ["what", ...(oneCourse ? (["exam"] as Step[]) : []), ...(quiz ? (["questions"] as Step[]) : []), "details", "review"];
  const options: ExamOption[] = useMemo(
    () => (oneCourse && examInfo && examInfo.course === oneCourse.folder ? examOptions(oneCourse, examInfo.view, examInfo.planned) : []),
    [oneCourse, examInfo],
  );
  const picked = options.find((o) => o.title === exam);
  const examTitle = exam === OTHER_EXAM ? otherName.trim() : exam;
  const defaultCount = quiz ? 10 : 20;
  const noun = quiz ? "question" : "card";

  // The chosen course's tests: its scope map and the plan's calendar.
  useEffect(() => {
    if (!oneCourse || examInfo?.course === oneCourse.folder) return;
    setExamInfo({ course: oneCourse.folder, view: null, planned: [], loading: true });
    void Promise.all([studyScope(space, oneCourse.folder).catch(() => null), planExamsGet(space).catch(() => [] as Exam[])]).then(([view, planned]) =>
      setExamInfo({ course: oneCourse.folder, view, planned, loading: false }),
    );
  }, [oneCourse, examInfo?.course, space]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step, phase.at]);

  const run = async (srcs: string[], attemptPath?: string) => {
    setPhase({ at: "running", step: "", done: 0, total: 0 });
    announce(quiz ? "Making your quiz." : "Making your flashcards.");
    let needs: UnknownScope | undefined;
    let done: Phase | null = null;
    let failed: string | null = null;
    const n = Number(count) || defaultCount;
    const onEvent = (e: StudyEvent) => {
      if (e.type === "progress") setPhase({ at: "running", step: e.step, done: e.done, total: e.total, kept: e.kept, dropped: e.dropped });
      else if (e.type === "needsScope") needs = { course: e.course, courseName: e.courseName, exam: e.exam };
      else if (e.type === "error") failed = e.message;
      else if (e.type === "done" && e.path) done = { at: "done", path: e.path, count: (quiz ? e.questions : e.cards) ?? 0, grounding: e.grounding };
    };
    const exam = !attemptPath && examTitle ? { exam: examTitle } : {};
    const end = quiz
      ? await studyMakeQuiz(space, srcs, { count: n, kinds, difficulty, ...(title.trim() ? { title: title.trim() } : {}), ...(focus.trim() ? { focus: focus.trim() } : {}), ...exam }, onEvent)
      : await studyMakeDeck(space, srcs, { count: n, ...(focus.trim() ? { focus: focus.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(attemptPath ? { fromAttempt: attemptPath } : {}), ...exam }, onEvent);
    if (end.kind === "rejected") failed = plainError(end.error);
    const result = done as Phase | null;
    if (result && result.at === "done") {
      setPhase(result);
      onMade({ kind, path: result.path, count: result.count, next: null });
      announce(`${quiz ? "Quiz" : "Flashcards"} ready: ${plural(result.count, noun)}.`);
    } else {
      setPhase({ at: "error", message: failed ?? "It stopped before it was done. Try again.", needs });
    }
  };

  // From a quiz's mistakes: no form.
  useEffect(() => {
    if (fromAttempt && !started.current) {
      started.current = true;
      void run(fromAttempt.sources, fromAttempt.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const validate = (s: Step): string | null => {
    if (s === "what") {
      if (!courses.length) return "There are no courses in this space yet.";
      if (!chosen.length) return "Choose at least one course.";
    }
    if (s === "exam") {
      if (exam === OTHER_EXAM && !otherName.trim()) return "Name the test, like “Test 2”.";
      if (picked && (picked.state === "unknown" || picked.state === "stated") && !scopeText.trim()) return "Say what this test covers, in a few words. Or choose everything so far.";
      if (exam === OTHER_EXAM && !scopeText.trim() && examInfo?.view?.state === "fresh") return "Say what this test covers, in a few words. Or choose everything so far.";
    }
    if (s === "questions" && !kinds.length) return "Choose at least one kind of question.";
    if (s === "details") {
      const v = count.trim() ? Number(count) : defaultCount;
      if (!Number.isInteger(v) || v < COUNT_MIN || v > COUNT_MAX) return `Choose a number from ${COUNT_MIN} to ${COUNT_MAX}.`;
    }
    return null;
  };

  const next = async () => {
    const p = validate(step);
    setProblem(p);
    if (p) return;
    if (step === "exam" && oneCourse && examTitle && scopeText.trim() && scopeText.trim() !== (picked?.stated ?? "")) {
      try {
        await studyScopeState(space, oneCourse.folder, examTitle, scopeText.trim());
      } catch (e) {
        setProblem(errorText(e));
        return;
      }
    }
    if (step === "review") return void run([...chosen]);
    setStep(steps[steps.indexOf(step) + 1]!);
  };
  const back = () => {
    setProblem(null);
    setStep(steps[Math.max(0, steps.indexOf(step) - 1)]!);
  };

  const toggleCourse = (folder: string, on: boolean) => setChosen((c) => (on ? [...c.filter((x) => !x.startsWith(`${folder}/`)), folder] : c.filter((x) => x !== folder && !x.startsWith(`${folder}/`))));
  const togglePart = (folder: string, part: string, on: boolean) =>
    setChosen((c) => {
      const has = c.includes(folder);
      let parts = has ? COURSE_PARTS.map((p) => `${folder}/${p.part}`) : c.filter((x) => x.startsWith(`${folder}/`));
      parts = on ? [...parts, `${folder}/${part}`] : parts.filter((x) => x !== `${folder}/${part}`);
      const rest = c.filter((x) => x !== folder && !x.startsWith(`${folder}/`));
      if (parts.length === COURSE_PARTS.length) return [...rest, folder];
      return [...rest, ...new Set(parts)];
    });

  const running = phase.at === "running";
  const words = (p: MakeProgress) => progressWords(p, { quiz, course: oneCourse?.name, exam: examTitle || undefined });

  return (
    <DialogPopup className="max-w-xl" showCloseButton={!running} aria-labelledby={`${id}-title`}>
      <DialogHeader>
        <DialogTitle id={`${id}-title`} ref={headingRef} tabIndex={-1} className="outline-none">
          {phase.at === "done"
            ? quiz
              ? "Your quiz is ready"
              : "Your flashcards are ready"
            : phase.at === "error"
              ? quiz
                ? "The quiz couldn’t be made"
                : "The flashcards couldn’t be made"
              : running
                ? quiz
                  ? "Making your quiz"
                  : "Making your flashcards"
                : fromAttempt
                  ? "Cards from your mistakes"
                  : quiz
                    ? "Make a practice quiz"
                    : step === "what" && !request.kind
                      ? "Make practice"
                      : "Make flashcards"}
        </DialogTitle>
        {phase.at === "form" && !fromAttempt && (
          <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-1 gap-y-1 text-sm">
            {steps.map((s, i) => {
              const at = steps.indexOf(step);
              return (
                <li key={s} className="flex items-center gap-1" aria-current={s === step ? "step" : undefined}>
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center rounded-full border text-xs font-semibold tabular-nums",
                      i < at ? "border-primary bg-primary text-primary-foreground" : i === at ? "border-foreground text-foreground" : "text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {i < at ? <CheckIcon className="size-3" /> : i + 1}
                  </span>
                  <span className={cn(i === at ? "font-medium text-foreground" : "text-muted-foreground")}>
                    {STEP_NAMES[s]}
                    <span className="sr-only">{i < at ? ", done" : i === at ? ", current" : ""}</span>
                  </span>
                  {i < steps.length - 1 && <span aria-hidden className="mx-1 h-px w-4 bg-border" />}
                </li>
              );
            })}
          </ol>
        )}
      </DialogHeader>

      <DialogPanel className="flex flex-col gap-5">
        {phase.at === "form" && step === "what" && (
          <>
            {!request.kind && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 text-sm font-medium">What to make</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {(
                    [
                      ["deck", "Flashcards", "Cards to review over days, spaced by how well you know each", <LayersIcon key="d" aria-hidden />],
                      ["quiz", "Practice quiz", "Questions graded with explanations, like a test", <ClipboardListIcon key="q" aria-hidden />],
                    ] as const
                  ).map(([k, label, hint, icon]) => (
                    <label key={k} className={cn("flex cursor-pointer gap-3 rounded-xl border p-3 has-focus-visible:ring-2 has-focus-visible:ring-ring", kind === k ? "border-primary bg-primary/6" : "hover:bg-accent")}>
                      <input type="radio" name={`${id}-kind`} className="sr-only" checked={kind === k} onChange={() => setKind(k)} />
                      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4.5">{icon}</span>
                      <span className="flex flex-col gap-0.5">
                        <span className="text-sm font-medium text-foreground">{label}</span>
                        <span className="text-sm text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">From</legend>
              {courses.length === 0 ? (
                <div className="flex flex-col items-start gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                  There are no courses in this space yet.
                  <Button size="sm" variant="outline" onClick={() => (onClose(), go({ kind: "courses" }))}>
                    Import courses
                  </Button>
                </div>
              ) : (
                <ul className="flex flex-col divide-y rounded-xl border">
                  {courses.map((c) => {
                    const whole = chosen.includes(c.folder);
                    const parts = chosen.filter((x) => x.startsWith(`${c.folder}/`));
                    const src = sources.find((s) => courseFolder(s.folder) === c.folder);
                    const available = COURSE_PARTS.filter((p) => !src || (p.part === "syllabus.md" ? src.syllabus : p.part === "assignments.md" ? src.assignments : p.part === "files" ? src.files : src.readings));
                    return (
                      <li key={c.folder} className="flex flex-col gap-2 px-3 py-2.5">
                        <Label className="flex items-center gap-2.5 text-sm font-medium">
                          <Checkbox checked={whole} indeterminate={!whole && parts.length > 0} onCheckedChange={(on) => toggleCourse(c.folder, on)} />
                          {c.name}
                        </Label>
                        {(whole || parts.length > 0) && available.length > 1 && (
                          <div className="flex flex-wrap gap-x-4 gap-y-1.5 ps-7" role="group" aria-label={`Parts of ${c.name}`}>
                            {available.map((p) => (
                              <Label key={p.part} className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
                                <Checkbox checked={whole || parts.includes(`${c.folder}/${p.part}`)} onCheckedChange={(on) => togglePart(c.folder, p.part, on)} />
                                {p.label}
                              </Label>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </fieldset>
          </>
        )}

        {phase.at === "form" && step === "exam" && oneCourse && (
          <ExamStep
            course={oneCourse}
            loading={!examInfo || examInfo.loading}
            view={examInfo?.view ?? null}
            options={options}
            exam={exam}
            setExam={(v) => {
              setExam(v);
              const o = options.find((x) => x.title === v);
              setScopeText(o?.stated ?? "");
            }}
            otherName={otherName}
            setOtherName={setOtherName}
            scopeText={scopeText}
            setScopeText={setScopeText}
            space={space}
          />
        )}

        {phase.at === "form" && step === "questions" && (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">Kinds of question</legend>
              {KINDS.map((k) => (
                <Label key={k.kind} className="flex items-center gap-2.5 text-sm font-normal">
                  <Checkbox checked={kinds.includes(k.kind)} onCheckedChange={(on) => setKinds((x) => (on ? [...x, k.kind] : x.filter((y) => y !== k.kind)))} />
                  {k.label}
                </Label>
              ))}
            </fieldset>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">How hard</legend>
              <RadioGroup value={difficulty} onValueChange={(v) => setDifficulty(v as typeof difficulty)} className="gap-2">
                {DIFFICULTY.map((d) => (
                  <Label key={d.value} className="flex items-start gap-2.5 text-sm font-normal">
                    <Radio value={d.value} className="mt-0.5" />
                    <span>
                      <span className="font-medium text-foreground">{d.label}</span>
                      <span className="text-muted-foreground"> · {d.hint}</span>
                    </span>
                  </Label>
                ))}
              </RadioGroup>
            </fieldset>
          </>
        )}

        {phase.at === "form" && step === "details" && (
          <>
            <Field label={`Number of ${noun}s`} hint={`${COUNT_MIN} to ${COUNT_MAX}`} id={`${id}-count`}>
              <Input id={`${id}-count`} inputMode="numeric" className="max-w-32" placeholder={String(defaultCount)} value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
            <Field label="Focus" hint="Topics to narrow to, in a few words. Leave empty for everything." id={`${id}-focus`}>
              <Input id={`${id}-focus`} placeholder="injective and surjective functions" value={focus} onChange={(e) => setFocus(e.target.value)} />
            </Field>
            <Field label="Name" hint="Leave empty to name it after the course and test." id={`${id}-title`}>
              <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </>
        )}

        {phase.at === "form" && step === "review" && (
          <>
            <dl className="flex flex-col divide-y rounded-xl border text-sm">
              <ReviewRow label="What" onChange={() => setStep("what")}>
                {quiz ? "Practice quiz" : "Flashcards"} from {chosen.map((c) => {
                  const course = courses.find((x) => c === x.folder || c.startsWith(`${x.folder}/`));
                  const part = COURSE_PARTS.find((p) => c.endsWith(`/${p.part}`));
                  return part ? `${course?.name ?? folderKey(c)} (${part.label.toLowerCase()})` : (course?.name ?? folderKey(c));
                }).join(", ")}
              </ReviewRow>
              {oneCourse && (
                <ReviewRow label="Test" onChange={() => setStep("exam")}>
                  {examTitle ? `${examTitle}${picked?.scope ? `: ${scopeWords(picked.scope)}` : scopeText.trim() ? `: ${scopeText.trim()}` : ""}` : "Everything so far"}
                </ReviewRow>
              )}
              {quiz && (
                <ReviewRow label="Questions" onChange={() => setStep("questions")}>
                  {kinds.map((k) => KINDS.find((x) => x.kind === k)?.label).join(", ")} · {DIFFICULTY.find((d) => d.value === difficulty)?.label}
                </ReviewRow>
              )}
              <ReviewRow label="Details" onChange={() => setStep("details")}>
                {plural(Number(count) || defaultCount, noun)}
                {focus.trim() && ` on ${focus.trim()}`}
                {title.trim() && ` · “${title.trim()}”`}
              </ReviewRow>
            </dl>
            <MaterialNote alert={(examInfo?.view?.material?.exams.find((e) => e.title === examTitle)?.alert ?? examInfo?.view?.material?.alert) || undefined} />
            <p className="text-sm text-muted-foreground">These course files and your choices go to the assistant’s model. Each {noun} is then checked against the passage it cites; ones that fail are dropped or rewritten.</p>
          </>
        )}

        {running && (
          <div className="flex flex-col gap-3" data-make-running="">
            <Progress
              value={phase.total ? Math.min(1, phase.done / phase.total) : null}
              label={quiz ? "Making the quiz" : "Making the cards"}
              valueText={words(phase)}
            />
            <p className="text-sm text-foreground">{words(phase)}</p>
            <p className="text-sm text-muted-foreground">You can close this; Study tells you when it’s ready.</p>
          </div>
        )}

        {phase.at === "done" && (
          <div className="flex flex-col gap-4" data-make-done="">
            <p className="flex items-center gap-2 text-[0.9375rem] text-foreground">
              <CheckIcon aria-hidden className="size-4.5 text-success-foreground" />
              {plural(phase.count, noun)}, each tied to the course passage it came from.
            </p>
            {phase.grounding && (
              <div className="rounded-xl border p-4">
                <GroundingSummary g={phase.grounding} space={space} noun={quiz ? "question" : "card"} />
              </div>
            )}
          </div>
        )}

        {phase.at === "error" && (
          <div className="flex flex-col gap-4" data-make-error="">
            <p role="alert" className="flex items-start gap-2 rounded-xl border border-error/32 bg-error-surface px-3.5 py-3 text-sm text-error-foreground">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {phase.message}
            </p>
            {phase.needs && (
              <ScopeForm
                space={space}
                needs={phase.needs}
                onSaved={() => {
                  const srcs = fromAttempt ? fromAttempt.sources : [...chosen];
                  void run(srcs, fromAttempt?.path);
                }}
              />
            )}
          </div>
        )}

        <LiveText>{problem ?? ""}</LiveText>
        {problem && (
          <p className="text-sm text-destructive-foreground" data-make-problem="">
            {problem}
          </p>
        )}
      </DialogPanel>

      <DialogFooter>
        {phase.at === "form" && !fromAttempt && (
          <>
            {step !== "what" && (
              <Button variant="ghost" onClick={back} className="sm:me-auto">
                Back
              </Button>
            )}
            <Button onClick={() => void next()} disabled={step === "what" && !courses.length}>
              {step === "review" ? (quiz ? "Make the quiz" : "Make the cards") : "Next"}
            </Button>
          </>
        )}
        {running && (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
        {phase.at === "done" && (
          <>
            <Button variant="ghost" onClick={onClose} className="sm:me-auto">
              Close
            </Button>
            {!quiz && (
              <Button variant="outline" onClick={() => onMade({ kind, path: phase.path, count: phase.count, next: "open" })}>
                Look through them
              </Button>
            )}
            <Button onClick={() => onMade({ kind, path: phase.path, count: phase.count, next: quiz ? "take" : "study" })}>{quiz ? "Take the quiz now" : "Study them now"}</Button>
          </>
        )}
        {phase.at === "error" && (
          <>
            {needsModel(phase.message) && (
              <Button variant="outline" onClick={() => (onClose(), openSettings("assistant"))}>
                <SettingsIcon aria-hidden />
                Open Settings
              </Button>
            )}
            {!fromAttempt && (
              <Button
                variant="outline"
                onClick={() => {
                  setPhase({ at: "form" });
                  setStep("review");
                }}
              >
                Change and try again
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </>
        )}
      </DialogFooter>
    </DialogPopup>
  );
}

function Field({ label, hint, id, children }: { label: string; hint?: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ReviewRow({ label, children, onChange }: { label: string; children: ReactNode; onChange: () => void }) {
  return (
    <div className="flex items-start gap-3 px-3.5 py-2.5">
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-foreground">{children}</dd>
      <Button size="xs" variant="ghost" onClick={onChange} aria-label={`Change ${label.toLowerCase()}`}>
        Change
      </Button>
    </div>
  );
}

function ExamStep({
  course,
  loading,
  view,
  options,
  exam,
  setExam,
  otherName,
  setOtherName,
  scopeText,
  setScopeText,
  space,
}: {
  course: CourseFolder;
  loading: boolean;
  view: ScopeView | null;
  options: ExamOption[];
  exam: string;
  setExam: (v: string) => void;
  otherName: string;
  setOtherName: (v: string) => void;
  scopeText: string;
  setScopeText: (v: string) => void;
  space: string;
}) {
  const id = useId();
  const picked = options.find((o) => o.title === exam);
  if (loading) return <p role="status" className="text-sm text-muted-foreground">Looking up {course.name}’s tests…</p>;
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-sm font-medium">Which test is it for?</legend>
      <RadioGroup value={exam} onValueChange={(v) => setExam(String(v))} className="gap-2">
        <ExamRadio value="" label="Everything so far" detail="Any topic the course has taught" />
        {options.map((o) => (
          <ExamRadio
            key={o.title}
            value={o.title}
            label={o.title}
            detail={[examDate(o.date), o.state === "known" && o.scope ? scopeWords(o.scope) : o.state === "stated" ? `you said: ${o.stated}` : o.state === "unknown" ? "scope not found in the course" : "scope not checked yet"]
              .filter(Boolean)
              .join(" · ")}
          />
        ))}
        <ExamRadio value={OTHER_EXAM} label="Another test" />
      </RadioGroup>

      {exam === OTHER_EXAM && (
        <div className="flex flex-col gap-1.5 ps-7">
          <Label htmlFor={`${id}-other`}>Name of the test</Label>
          <Input id={`${id}-other`} autoFocus placeholder="Test 2" value={otherName} onChange={(e) => setOtherName(e.target.value)} />
        </div>
      )}

      {picked?.state === "known" && picked.scope && (
        <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4 text-sm" data-exam-scope="known">
          <p className="text-foreground">
            <span className="font-medium">{picked.title} covers:</span> {scopeWords(picked.scope)}
          </p>
          {(() => {
            const t = scopeTopics(view, picked.scope);
            return (
              <>
                {t.on.length > 0 && <p className="text-muted-foreground">On it: {t.on.join(", ")}</p>}
                {t.off.length > 0 && <p className="text-muted-foreground">Not on it: {t.off.join(", ")}</p>}
              </>
            );
          })()}
          {picked.scope.evidence.length > 0 && (
            <Disclosure summary="Where this comes from">
              <div className="flex flex-col gap-3">
                {picked.scope.evidence.map((e, i) => (
                  <Passage key={i} e={e} space={space} />
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      )}

      {(picked?.state === "unknown" || picked?.state === "stated" || picked?.state === "unchecked" || exam === OTHER_EXAM) && (
        <div className="flex flex-col gap-1.5" data-exam-scope={picked?.state ?? "other"}>
          {picked?.state === "unknown" && (
            <p className="flex items-start gap-2 text-sm text-warning-foreground">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              The course’s files don’t say what {picked.title} covers.
            </p>
          )}
          <Label htmlFor={`${id}-scope`}>
            What does {examTitleOf(exam, otherName) || "it"} cover?
            {picked?.state === "unchecked" && <span className="font-normal text-muted-foreground"> (optional)</span>}
          </Label>
          <Input id={`${id}-scope`} placeholder="through HW 6; not graphs" value={scopeText} onChange={(e) => setScopeText(e.target.value)} />
          <p className="text-sm text-muted-foreground">
            {picked?.state === "unchecked" ? "Phaethon reads the course first to find out; anything you say here is used as you wrote it." : "In a few words, as the teacher said it."}
          </p>
        </div>
      )}
      <MaterialNote alert={view?.material?.exams.find((e) => e.title === exam)?.alert} />
    </fieldset>
  );
}

const examTitleOf = (exam: string, other: string) => (exam === OTHER_EXAM ? other.trim() : exam);

function ExamRadio({ value, label, detail }: { value: string; label: string; detail?: string }) {
  return (
    <Label className="flex items-start gap-2.5 rounded-lg px-1 py-1 text-sm font-normal">
      <Radio value={value} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="font-medium text-foreground">{label}</span>
        {detail && <span className="text-muted-foreground">{detail}</span>}
      </span>
    </Label>
  );
}

/** Say what an exam covers when the course doesn't, then make it again. */
function ScopeForm({ space, needs, onSaved }: { space: string; needs: UnknownScope; onSaved: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return setProblem(`Say what ${needs.exam} covers, in a few words.`);
        try {
          await studyScopeState(space, needs.course, needs.exam, text.trim());
          announce(`Saved what ${needs.exam} covers.`);
          onSaved();
        } catch (err) {
          setProblem(errorText(err));
        }
      }}
    >
      <Label htmlFor={`${id}-s`}>What does {needs.exam} cover?</Label>
      <Input id={`${id}-s`} autoFocus placeholder="through HW 6; not graphs" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={!!problem || undefined} />
      {problem && <p className="text-sm text-destructive-foreground">{problem}</p>}
      <div>
        <Button type="submit" size="sm">
          Save and make it
        </Button>
      </div>
    </form>
  );
}
