import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { openCourseImport } from "@/components/lms/import-store";
import { announce } from "@/components/shell/announcer";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
 * Make flashcards or a quiz from the space's courses: choose the courses (or
 * parts of them: syllabus, assignments, files, readings), how many, what to
 * focus on, and for a quiz the kinds of question and how hard. The core reads
 * them and asks the model; progress streams in, then the result offers the
 * next step. Errors are said in plain words, with Settings one click away
 * when no model is set up.
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
  const heading =
    phase.at === "form"
      ? quiz
        ? "Make a quiz"
        : "Make flashcards"
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

  // Each phase's heading takes focus, so a screen reader hears where it is (the form's goes to its first field).
  useLayoutEffect(() => {
    if (phase.at === "form") return;
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

  function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (chosen.size === 0) next.sources = courses.length ? "Choose at least one course, or part of one, to make them from." : "There are no courses in this space yet. Import your courses first.";
    const n = Number(count);
    if (!Number.isInteger(n) || n < COUNT_MIN || n > COUNT_MAX) next.count = `Choose a number from ${COUNT_MIN} to ${COUNT_MAX}.`;
    if (quiz && kinds.size === 0) next.kinds = "Choose at least one kind of question.";
    setErrors(next);
    const first = next.sources ? `${id}-sources` : next.count ? `${id}-count` : next.kinds ? `${id}-kinds` : null;
    if (first) {
      const el = document.getElementById(first);
      (el?.matches("input") ? el : el?.querySelector<HTMLElement>("input"))?.focus();
      return;
    }
    void run([...chosen]);
  }

  const toggleCourse = (c: CourseFolder, on: boolean) =>
    setChosen((s) => {
      const n = new Set([...s].filter((p) => p !== c.folder && !p.startsWith(`${c.folder}/`)));
      if (on) n.add(c.folder);
      return n;
    });
  const togglePart = (c: CourseFolder, part: string, on: boolean) =>
    setChosen((s) => {
      const n = new Set(s);
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
      return n;
    });

  let body: ReactNode;
  if (phase.at === "form") {
    body = (
      <form noValidate onSubmit={submit} className="flex flex-col gap-5" data-make-form="">
        <fieldset id={`${id}-sources`} aria-describedby={errors.sources ? `${id}-sources-error` : undefined} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-1 text-md font-semibold text-ink">Make them from</legend>
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
          )}
          {errors.sources && <FieldError id={`${id}-sources-error`}>{errors.sources}</FieldError>}
        </fieldset>

        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-focus`} className="text-base font-medium text-ink">
            Focus on <span className="font-normal text-ink-secondary">(optional)</span>
          </label>
          <Input id={`${id}-focus`} value={focus} onChange={(e) => setFocus(e.target.value)} aria-describedby={`${id}-focus-hint`} data-make-focus="" />
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
              onChange={(e) => setCount(e.target.value)}
              aria-invalid={errors.count ? true : undefined}
              aria-describedby={errors.count ? `${id}-count-error` : undefined}
              className="w-[calc(var(--ph-control-height)*3)]"
              data-make-count=""
            />
            {errors.count && <FieldError id={`${id}-count-error`}>{errors.count}</FieldError>}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={`${id}-title`} className="text-base font-medium text-ink">
              Name <span className="font-normal text-ink-secondary">(optional)</span>
            </label>
            <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} aria-describedby={`${id}-title-hint`} />
            <p id={`${id}-title-hint`} className="text-sm text-ink-secondary">
              Phaethon names it from what it covers if you leave this empty.
            </p>
          </div>
        </div>

        {quiz && (
          <>
            <fieldset id={`${id}-kinds`} aria-describedby={errors.kinds ? `${id}-kinds-error` : undefined} className="flex min-w-0 flex-col gap-1">
              <legend className="mb-1 text-base font-medium text-ink">Kinds of question</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {KINDS.map((k) => (
                  <label key={k.id} className="flex min-h-(--ph-target-min) cursor-default items-center gap-2 text-base text-ink">
                    <input
                      type="checkbox"
                      checked={kinds.has(k.id)}
                      onChange={(e) =>
                        setKinds((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(k.id);
                          else n.delete(k.id);
                          return n;
                        })
                      }
                      aria-invalid={errors.kinds ? true : undefined}
                      data-quiz-kind={k.id}
                      className="size-(--ph-icon-size) shrink-0 accent-accent-fill"
                    />
                    {k.label}
                  </label>
                ))}
              </div>
              {errors.kinds && <FieldError id={`${id}-kinds-error`}>{errors.kinds}</FieldError>}
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
                      onChange={() => setDifficulty(d.id)}
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
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" data-make-submit="">
            {quiz ? "Make the quiz" : "Make flashcards"}
          </Button>
        </div>
      </form>
    );
  } else if (phase.at === "running") {
    const fraction = phase.total > 0 ? phase.done / phase.total : 0;
    const valueText = phase.total > 0 ? `${stepWords(phase.step)}, ${phase.done} of ${phase.total}` : stepWords(phase.step);
    body = (
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
    body = (
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
    body = (
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
            <Button type="button" onClick={() => setPhase({ at: "form" })} data-make-retry="">
              <Icon name="retry" />
              Change and try again
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <DialogContent
      data-make-dialog={request.kind}
      data-phase={phase.at}
      className="max-w-(--ph-dialog-width)"
      // While it is being made, a stray Escape or click outside doesn't hide the progress.
      onEscapeKeyDown={(e) => phase.at === "running" && e.preventDefault()}
      onInteractOutside={(e) => phase.at === "running" && e.preventDefault()}
    >
      <div className="flex flex-col gap-1 pe-[calc(var(--ph-control-height)+var(--ph-space)*2)]">
        <DialogTitle ref={titleRef} tabIndex={-1} data-make-title="">
          {heading}
        </DialogTitle>
        <DialogDescription className={cn(phase.at !== "form" && "sr-only")}>
          {request.fromAttempt
            ? `From the questions you missed in “${request.fromAttempt.quizTitle}”.`
            : quiz
              ? "Practice questions from your courses. Your answers are checked, with feedback and where to read more."
              : "Cards to study one at a time. The ones you find hard come back sooner."}
        </DialogDescription>
      </div>
      {body}
      <p role="status" className="sr-only">
        {said}
      </p>
    </DialogContent>
  );
}

function FieldError({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} data-field-error="" className="flex items-start gap-1.5 text-sm text-danger-ink">
      <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
      {children}
    </p>
  );
}
