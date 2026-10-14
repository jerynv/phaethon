import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { openCourseImport } from "@/components/lms/import-store";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  enterAdvances,
  ReviewList,
  StepError,
  WIZARD_FORM,
  WizardBody,
  WizardDialogContent,
  WizardFooter,
  WizardHeader,
  type WizardStep,
} from "@/components/ui/stepper";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { studyMakeDeck, studyMakeQuiz, type StudyEvent } from "@/lib/study";
import { cn } from "@/lib/utils";

import { COURSE_PARTS, doneField, needsModel, plainError, plural, type CourseFolder } from "./words";

export type MakeKind = "deck" | "quiz";

/** What the dialog is asked to make. `fromAttempt`: cards from a quiz's mistakes, started at once. */
export type MakeRequest = {
  kind: MakeKind;
  key: number;
  fromAttempt?: { path: string; sources: string[]; quizTitle: string };
};

/** What was made, and what the person chose to do next. */
export type Made = { kind: MakeKind; path: string; count: number; next: "study" | "open" | "take" | null };

const KINDS = [
  { id: "choice", label: "Multiple choice" },
  { id: "multi", label: "Choose all that apply" },
  { id: "truefalse", label: "True or false" },
  { id: "short", label: "Short answer" },
  { id: "cloze", label: "Fill in the blank" },
] as const;

const DIFFICULTY = [
  { id: "easier", label: "Easier", hint: "to warm up" },
  { id: "exam", label: "Like the exam", hint: "what a test would ask" },
  { id: "harder", label: "Harder", hint: "to stretch" },
] as const;

type Phase =
  | { at: "form" }
  | { at: "running"; step: string; done: number; total: number }
  | { at: "done"; path: string; count: number }
  | { at: "error"; message: string };

/** The steps of the form: one decision each, then a look at everything before it is made. */
type FormStep = "sources" | "questions" | "details" | "review";

const COUNT_MIN = 3;
const COUNT_MAX = 60;

/** The core's step codes (study/generate.rs) in words. */
const STEP_WORDS: Record<string, string> = {
  reading: "Reading your course material",
  making: "Writing them",
  saving: "Saving",
  grading: "Checking answers",
  reviewing: "Looking over your mistakes",
};
const stepWords = (s: string) => (s ? (STEP_WORDS[s] ?? s.charAt(0).toUpperCase() + s.slice(1)) : "Getting started");

/**
 * Make flashcards or a quiz from the space's courses, one step at a time
 * (the shared wizard in ui/stepper): which courses (or parts of them:
 * syllabus, assignments, files, readings); for a quiz the kinds of question
 * and how hard; how many, what to focus on and a name; then a look at all of
 * it before anything is made. The core reads them and asks the model;
 * progress streams in, then the result offers the next step. Errors are said
 * in plain words, with Settings one click away when no model is set up.
 */
export function MakeDialog({
  space,
  request,
  courses,
  onClose,
  onMade,
}: {
  space: string;
  request: MakeRequest | null;
  courses: CourseFolder[];
  onClose: () => void;
  onMade: (made: Made) => void;
}) {
  return (
    <Dialog open={!!request} onOpenChange={(o) => !o && onClose()}>
      {request && <MakeFlow key={request.key} space={space} request={request} courses={courses} onClose={onClose} onMade={onMade} />}
    </Dialog>
  );
}

function MakeFlow({
  space,
  request,
  courses,
  onClose,
  onMade,
}: {
  space: string;
  request: MakeRequest;
  courses: CourseFolder[];
  onClose: () => void;
  onMade: (made: Made) => void;
}) {
  const quiz = request.kind === "quiz";
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ at: "form" });
  const [step, setStep] = useState<FormStep>("sources");
  // Something was chosen or typed: closing asks before discarding it.
  const [touched, setTouched] = useState(false);
  // Sources: a course folder ("courses/X") means all of it; otherwise its chosen parts ("courses/X/syllabus.md").
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(courses.length === 1 ? [courses[0].folder] : []));
  const [count, setCount] = useState(quiz ? "10" : "20");
  const [focus, setFocus] = useState("");
  const [title, setTitle] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(() => new Set(["choice", "truefalse", "short"]));
  const [difficulty, setDifficulty] = useState<string>("exam");
  const [errors, setErrors] = useState<{ sources?: string; count?: string; kinds?: string }>({});
  const [said, setSaid] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const what = quiz ? "quiz" : "flashcards";
  const task = quiz ? "Make a quiz" : "Make flashcards";
  const steps: WizardStep[] = [
    { id: "sources", label: "Courses" },
    ...(quiz ? [{ id: "questions", label: "Kinds of question" }] : []),
    { id: "details", label: quiz ? "Focus and number of questions" : "Focus and number of cards" },
    { id: "review", label: quiz ? "Check and make the quiz" : "Check and make the cards" },
  ];
  const at = steps.findIndex((s) => s.id === step);
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setTouched(true);
  };

  const heading =
    phase.at === "form"
      ? {
          sources: `Which courses should the ${quiz ? "questions" : "cards"} come from?`,
          questions: "Which kinds of question, and how hard?",
          details: quiz ? "What should the quiz cover?" : "What should the cards cover?",
          review: quiz ? "Check the quiz, then make it" : "Check the flashcards, then make them",
        }[step]
      : phase.at === "running"
        ? quiz
          ? "Making your quiz…"
          : request.fromAttempt
            ? "Making cards from your mistakes…"
            : "Making your flashcards…"
        : phase.at === "done"
          ? quiz
            ? "Your quiz is ready"
            : "Your flashcards are ready"
          : quiz
            ? "The quiz couldn’t be made"
            : "The flashcards couldn’t be made";

  // Each phase's heading takes focus as it shows (the steps' headings do so themselves, in WizardHeader).
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [phase.at]);

  async function run(sources: string[], fromAttempt?: string) {
    setPhase({ at: "running", step: "", done: 0, total: 0 });
    setSaid(quiz ? "Making your quiz." : "Making your flashcards.");
    let ended = false;
    const onEvent = (e: StudyEvent) => {
      // Closed while it ran: Study still hears the result (and says it), the dialog doesn't.
      if (e.type === "done") {
        ended = true;
        const path = doneField<string>(e, "path") ?? "";
        const n = doneField<number>(e, quiz ? "questions" : "cards") ?? 0;
        const words = quiz ? `Made a quiz with ${plural(n, "question")}.` : `Made ${plural(n, "flashcard")}.`;
        onMade({ kind: request.kind, path, count: n, next: null });
        if (!live.current) return announce(`${words} It’s in Study.`);
        setPhase({ at: "done", path, count: n });
        setSaid(words);
        return;
      }
      if (e.type === "error") {
        ended = true;
        if (!live.current) return announce(`${quiz ? "The quiz" : "The flashcards"} couldn’t be made. ${plainError(e.message)}`);
        setPhase({ at: "error", message: plainError(e.message) });
        return;
      }
      if (live.current && e.type === "progress") setPhase({ at: "running", step: e.step, done: e.done, total: e.total });
    };
    try {
      const n = Number(count);
      if (quiz) {
        // `focus` rides along for the model when given (the core may ignore it).
        const options = { count: n, kinds: [...kinds] as never[], difficulty: difficulty as never, ...(title.trim() ? { title: title.trim() } : {}), ...(focus.trim() ? { focus: focus.trim() } : {}) };
        await studyMakeQuiz(space, sources, options, onEvent);
      } else {
        const options = { count: n, ...(focus.trim() ? { focus: focus.trim() } : {}), ...(title.trim() ? { title: title.trim() } : {}), ...(fromAttempt ? { fromAttempt } : {}) };
        await studyMakeDeck(space, sources, options, onEvent);
      }
      if (!ended && live.current) setPhase({ at: "error", message: "It stopped before it was done. Try again." });
    } catch (e) {
      if (live.current) setPhase({ at: "error", message: plainError(e) });
    }
  }

  // From a quiz's mistakes: no form, it starts at once.
  const started = useRef(false);
  useEffect(() => {
    if (!request.fromAttempt || started.current) return;
    started.current = true;
    void run(request.fromAttempt.sources, request.fromAttempt.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** What is missing on a step, in words (nothing when it is complete). */
  function problems(s: FormStep): typeof errors {
    if (s === "sources" && chosen.size === 0)
      return { sources: courses.length ? "Choose at least one course, or part of one, to make them from." : "There are no courses in this space yet. Import your courses first." };
    if (s === "questions" && kinds.size === 0) return { kinds: "Choose at least one kind of question." };
    const n = Number(count);
    if (s === "details" && (!Number.isInteger(n) || n < COUNT_MIN || n > COUNT_MAX)) return { count: `Choose a number from ${COUNT_MIN} to ${COUNT_MAX}.` };
    return {};
  }

  // Next: the step is checked first, and what is missing is said beside it with focus there.
  function next(e: FormEvent) {
    e.preventDefault();
    const found = problems(step);
    setErrors(found);
    const first = found.sources ? `${id}-sources` : found.count ? `${id}-count` : found.kinds ? `${id}-kinds` : null;
    if (first) {
      const el = document.getElementById(first);
      (el?.matches("input") ? el : el?.querySelector<HTMLElement>("input"))?.focus();
      return;
    }
    if (step === "review") {
      void run([...chosen]);
      return;
    }
    setTouched(true);
    setStep(steps[at + 1].id as FormStep);
  }
  const back = at > 0 ? () => (setErrors({}), setStep(steps[at - 1].id as FormStep)) : undefined;

  const toggleCourse = (c: CourseFolder, on: boolean) =>
    change(setChosen)(
      ((s: Set<string>) => {
        const n = new Set([...s].filter((p) => p !== c.folder && !p.startsWith(`${c.folder}/`)));
        if (on) n.add(c.folder);
        return n;
      })(chosen),
    );
  const togglePart = (c: CourseFolder, part: string, on: boolean) => {
    const n = new Set(chosen);
    const whole = n.has(c.folder);
    n.delete(c.folder);
    const parts = new Set(COURSE_PARTS.map((p) => `${c.folder}/${p.part}`).filter((p) => (whole ? true : n.has(p))));
    const path = `${c.folder}/${part}`;
    if (on) parts.add(path);
    else parts.delete(path);
    for (const p of COURSE_PARTS) n.delete(`${c.folder}/${p.part}`);
    // Every part chosen is the whole course.
    if (parts.size === COURSE_PARTS.length) n.add(c.folder);
    else parts.forEach((p) => n.add(p));
    change(setChosen)(n);
  };

  /** The chosen sources in words: "Discrete Structures (all of it)", "Calculus II: Syllabus, Readings". */
  const sourceWords = courses
    .map((c) => {
      if (chosen.has(c.folder)) return `${c.name} (all of it)`;
      const parts = COURSE_PARTS.filter((p) => chosen.has(`${c.folder}/${p.part}`)).map((p) => p.label);
      return parts.length ? `${c.name}: ${parts.join(", ")}` : null;
    })
    .filter(Boolean) as string[];

  let body: ReactNode;
  if (phase.at === "form") {
    let fields: ReactNode;
    if (step === "sources") {
      fields = (
        <fieldset id={`${id}-sources`} aria-describedby={errors.sources ? `${id}-sources-error` : undefined} className="flex min-w-0 flex-col gap-2">
          <legend className="sr-only">Courses to make them from</legend>
          {courses.length === 0 ? (
            <p className="text-base text-ink-secondary">
              There are no courses in this space yet. Phaethon makes {what} from your courses’ syllabus, assignments and files.{" "}
              <Button
                type="button"
                variant="link"
                className="inline-flex align-baseline"
                onClick={() => {
                  onClose();
                  openCourseImport({ space });
                }}
              >
                Import courses…
              </Button>
            </p>
          ) : (
            <>
              <p className="text-sm text-ink-secondary">Check a whole course, or only some of its parts.</p>
              <ul className="flex flex-col gap-2">
                {courses.map((c) => {
                  const whole = chosen.has(c.folder);
                  const some = !whole && COURSE_PARTS.some((p) => chosen.has(`${c.folder}/${p.part}`));
                  return (
                    <li key={c.folder} className="rounded-lg border border-line bg-raised px-3 py-2" data-source-course={c.folder}>
                      <label className="flex min-h-(--ph-target-min) cursor-default items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={whole}
                          ref={(el) => {
                            if (el) el.indeterminate = some;
                          }}
                          onChange={(e) => toggleCourse(c, e.target.checked)}
                          aria-invalid={errors.sources ? true : undefined}
                          className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
                        />
                        <span className="min-w-0 font-medium wrap-break-word text-ink">{c.name}</span>
                      </label>
                      <ul aria-label={`Parts of ${c.name}`} className="mt-1 flex flex-wrap gap-x-4 gap-y-1 ps-[calc(var(--ph-icon-size)+var(--ph-space)*2.5)]">
                        {COURSE_PARTS.map((p) => (
                          <li key={p.part}>
                            <label className="flex min-h-(--ph-target-min) cursor-default items-center gap-2 text-base text-ink-secondary">
                              <input
                                type="checkbox"
                                checked={whole || chosen.has(`${c.folder}/${p.part}`)}
                                onChange={(e) => togglePart(c, p.part, e.target.checked)}
                                data-source-part={p.part}
                                className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
                              />
                              {p.label}
                            </label>
                          </li>
                        ))}
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {errors.sources && <StepError id={`${id}-sources-error`}>{errors.sources}</StepError>}
        </fieldset>
      );
    } else if (step === "questions") {
      fields = (
        <>
          <fieldset id={`${id}-kinds`} aria-describedby={errors.kinds ? `${id}-kinds-error` : undefined} className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-base font-medium text-ink">Kinds of question</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {KINDS.map((k) => (
                <label key={k.id} className="flex min-h-(--ph-target-min) cursor-default items-center gap-2 text-base text-ink">
                  <input
                    type="checkbox"
                    checked={kinds.has(k.id)}
                    onChange={(e) => {
                      const n = new Set(kinds);
                      if (e.target.checked) n.add(k.id);
                      else n.delete(k.id);
                      change(setKinds)(n);
                    }}
                    aria-invalid={errors.kinds ? true : undefined}
                    data-quiz-kind={k.id}
                    className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
                  />
                  {k.label}
                </label>
              ))}
            </div>
            {errors.kinds && <StepError id={`${id}-kinds-error`}>{errors.kinds}</StepError>}
          </fieldset>
          <fieldset className="flex min-w-0 flex-col gap-1">
            <legend className="mb-1 text-base font-medium text-ink">How hard</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {DIFFICULTY.map((d) => (
                <label key={d.id} className="flex min-h-(--ph-target-min) cursor-default items-center gap-2 text-base text-ink">
                  <input
                    type="radio"
                    name={`${id}-difficulty`}
                    value={d.id}
                    checked={difficulty === d.id}
                    onChange={() => change(setDifficulty)(d.id)}
                    data-difficulty={d.id}
                    className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
                  />
                  <span>
                    {d.label} <span className="text-ink-secondary">({d.hint})</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </>
      );
    } else if (step === "details") {
      fields = (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-focus`} className="text-base font-medium text-ink">
              Focus on <span className="font-normal text-ink-secondary">(optional)</span>
            </label>
            <Input id={`${id}-focus`} value={focus} onChange={(e) => change(setFocus)(e.target.value)} aria-describedby={`${id}-focus-hint`} data-make-focus="" />
            <p id={`${id}-focus-hint`} className="text-sm text-ink-secondary">
              A topic, chapter or test, like “chapter 3” or “Test 1”.
            </p>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={`${id}-count`} className="text-base font-medium text-ink">
                {quiz ? "How many questions" : "How many cards"}
              </label>
              <Input
                id={`${id}-count`}
                type="number"
                inputMode="numeric"
                min={COUNT_MIN}
                max={COUNT_MAX}
                value={count}
                onChange={(e) => change(setCount)(e.target.value)}
                aria-invalid={errors.count ? true : undefined}
                aria-describedby={errors.count ? `${id}-count-error` : undefined}
                className="w-[calc(var(--ph-control-height)*3)]"
                data-make-count=""
              />
              {errors.count && <StepError id={`${id}-count-error`}>{errors.count}</StepError>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <label htmlFor={`${id}-title`} className="text-base font-medium text-ink">
                Name <span className="font-normal text-ink-secondary">(optional)</span>
              </label>
              <Input id={`${id}-title`} value={title} onChange={(e) => change(setTitle)(e.target.value)} aria-describedby={`${id}-title-hint`} data-make-name="" />
              <p id={`${id}-title-hint`} className="text-sm text-ink-secondary">
                Phaethon names it from what it covers if you leave this empty.
              </p>
            </div>
          </div>
        </>
      );
    } else {
      const goTo = (s: FormStep) => () => setStep(s);
      fields = (
        <>
          <ReviewList
            items={[
              { id: "sources", label: "From", value: sourceWords.join("; "), onChange: goTo("sources") },
              ...(quiz
                ? [
                    { id: "kinds", label: "Kinds of question", value: KINDS.filter((k) => kinds.has(k.id)).map((k) => k.label).join(", "), onChange: goTo("questions") },
                    { id: "difficulty", label: "How hard", value: DIFFICULTY.find((d) => d.id === difficulty)?.label ?? difficulty, onChange: goTo("questions") },
                  ]
                : []),
              { id: "count", label: quiz ? "Questions" : "Cards", value: count, onChange: goTo("details") },
              { id: "focus", label: "Focus", value: focus.trim() || "Everything in them", onChange: goTo("details") },
              { id: "name", label: "Name", value: title.trim() || "Named from what it covers", onChange: goTo("details") },
            ]}
          />
          <p className="text-sm text-ink-secondary">
            Phaethon sends what you chose to the model that makes them. It can take a minute, and you can close this window while it works.
          </p>
        </>
      );
    }
    body = (
      <form noValidate onSubmit={next} onKeyDown={enterAdvances} className={WIZARD_FORM} data-make-form="" data-make-at={step}>
        <WizardHeader steps={steps} current={step} title={heading} titleRef={titleRef} task={task} titleProps={{ "data-make-title": "" }}>
          <DialogDescription className={cn(step !== "sources" && "sr-only")}>
            {quiz
              ? "Practice questions from your courses. Your answers are checked, with feedback and where to read more."
              : "Cards to study one at a time. The ones you find hard come back sooner."}
          </DialogDescription>
        </WizardHeader>
        <WizardBody>{fields}</WizardBody>
        <WizardFooter
          onBack={back}
          next={
            step === "review" ? (
              <Button type="submit" data-step-next="" data-make-submit="">
                {quiz ? "Make the quiz" : "Make flashcards"}
              </Button>
            ) : (
              <Button type="submit" data-step-next="">
                Next
                <Icon name="chevron-right" />
              </Button>
            )
          }
        />
      </form>
    );
  } else {
    let result: ReactNode;
    if (phase.at === "running") {
      const fraction = phase.total > 0 ? phase.done / phase.total : 0;
      const valueText = phase.total > 0 ? `${stepWords(phase.step)}, ${phase.done} of ${phase.total}` : stepWords(phase.step);
      result = (
        <div className="flex flex-col gap-3" data-make-running="">
          <p className="flex items-center gap-2 text-base text-ink">
            <Icon name="spinner" className="animate-spin text-ink-secondary" />
            <span data-make-step="">{valueText}</span>
          </p>
          <div
            role="progressbar"
            aria-label={heading}
            aria-valuemin={0}
            aria-valuemax={phase.total || 1}
            aria-valuenow={phase.total ? phase.done : undefined}
            aria-valuetext={valueText}
            className="h-(--ph-space) w-full overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]"
          >
            <div className="h-full rounded-full bg-accent-fill transition-[width] duration-(--ph-duration) forced-colors:bg-[Highlight]" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
          <p className="text-sm text-ink-secondary">
            This can take a minute. You can close this window: the {quiz ? "quiz" : "cards"} will still be made and show up in Study.
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      );
    } else if (phase.at === "done") {
      const finish = (next: Made["next"]) => {
        onMade({ kind: request.kind, path: phase.path, count: phase.count, next });
        onClose();
      };
      result = (
        <div className="flex flex-col gap-4" data-make-done="">
          <p className="flex items-start gap-2 text-base text-ink">
            <Icon name="success" className="mt-0.5 text-success-ink" />
            <span>
              {quiz ? `A quiz with ${plural(phase.count, "question")} is ready.` : `${plural(phase.count, "flashcard")} ${phase.count === 1 ? "is" : "are"} ready.`}{" "}
              {quiz ? "It’s saved with your quizzes in Study." : "They’re saved as a deck in Study."}
            </span>
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Close
            </Button>
            {!quiz && (
              <Button type="button" variant="outline" onClick={() => finish("open")} data-make-open="">
                Look through them
              </Button>
            )}
            <Button type="button" onClick={() => finish(quiz ? "take" : "study")} data-make-next="">
              {quiz ? "Take the quiz now" : "Study them now"}
            </Button>
          </div>
        </div>
      );
    } else {
      const model = needsModel(phase.message);
      result = (
        <div className="flex flex-col gap-4" data-make-error="">
          <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink">
            <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
            <p className="min-w-0 wrap-break-word">{phase.message}</p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            {model && (
              <Button
                type="button"
                variant="outline"
                data-make-settings=""
                onClick={() => {
                  onClose();
                  openSettings("agent");
                }}
              >
                <Icon name="settings" />
                Open Settings
              </Button>
            )}
            {!request.fromAttempt && (
              // Back to the look at everything, where each choice can be changed.
              <Button type="button" onClick={() => (setStep("review"), setPhase({ at: "form" }))} data-make-retry="">
                <Icon name="retry" />
                Change and try again
              </Button>
            )}
          </div>
        </div>
      );
    }
    body = (
      <>
        <WizardHeader steps={[]} current={phase.at} title={heading} titleRef={titleRef} titleProps={{ "data-make-title": "" }}>
          <DialogDescription className="sr-only">
            {request.fromAttempt ? `From the questions you missed in “${request.fromAttempt.quizTitle}”.` : quiz ? "Practice questions from your courses." : "Cards to study one at a time."}
          </DialogDescription>
        </WizardHeader>
        <WizardBody>{result}</WizardBody>
      </>
    );
  }

  return (
    <WizardDialogContent
      data-make-dialog={request.kind}
      data-phase={phase.at}
      className="max-w-(--ph-dialog-width)"
      dirty={phase.at === "form" && (touched || at > 0)}
      // While it is being made, a stray Escape doesn't hide the progress (Close still does).
      locked={phase.at === "running"}
      onClose={onClose}
      discard={{
        title: quiz ? "Discard this quiz?" : "Discard these flashcards?",
        body: `What you chose for the ${quiz ? "quiz" : "flashcards"} isn’t kept. Nothing has been made yet.`,
      }}
    >
      {body}
      <p role="status" className="sr-only">
        {said}
      </p>
    </WizardDialogContent>
  );
}
