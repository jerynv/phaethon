import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon, type IconName } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { studyQuiz, studyQuizSubmit, studyReviewMistakes, type Attempt, type Question, type Quiz, type StudyEvent } from "@/lib/study";
import { cn } from "@/lib/utils";
import { openSpaceFile } from "@/runtime/records";

import { announce } from "@/components/shell/announcer";
import { choiceLetter, clearDraft, isAnswered, listWords, loadDraft, saveDraft, type Answers } from "@/lib/quiz-answers";
import { mathAsText, mathPieces } from "@/lib/study-math";

import { SourceLine } from "@/components/rich/citation";

import { CardText, MathText } from "./card-text";
import { GroundingSummary } from "./grounding";
import { attemptOf, baseName, doneField, needsModel, percent, plainError, plural } from "./words";

const KIND_HINT: Record<string, string> = {
  choice: "Choose one answer.",
  multi: "Choose all that apply.",
  truefalse: "True or false?",
  short: "Answer in a sentence or two.",
  cloze: "Fill in the blank.",
};

/** A choice that is a formula and nothing else. */
const mathOnly = (s: string) => mathPieces(s).every((p) => p.math || !p.text.trim());

const asText = (a: string | string[] | undefined) => (Array.isArray(a) ? a.join(", ") : a ?? "");

/**
 * A quiz, all on one page: each question is its own group with its number
 * and kind, so it can be read and answered in any order, and every answer
 * stays in view to check before handing it in. Choices are lettered radio
 * buttons (arrow keys move between them) or checkboxes; where each question
 * comes from stays hidden until the results, since its passage can give the
 * answer away. Answers are kept on this computer until they are checked, so
 * leaving the quiz loses nothing; the bar at the bottom counts them and goes
 * to the next question without one. Then the results: a strip of every
 * question's verdict to jump from, all of them or only the ones to look at
 * again, each marked Correct, Partly right or Not right in words and an
 * icon, a choice question with all its choices and which were yours and
 * right, feedback and where to read more; and from there a review of the
 * mistakes and cards made from them.
 */
export function QuizView({
  space,
  path,
  arrived = false,
  onBack,
  onMakeFromMistakes,
  onStudyDeck,
}: {
  space: string;
  path: string;
  /** Just made from the chat: focus goes to the first question, and it is announced. */
  arrived?: boolean;
  onBack: () => void;
  onMakeFromMistakes: (attempt: Attempt, quiz: Quiz) => void;
  onStudyDeck: (path: string) => void;
}) {
  const id = useId();
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answers, setAnswers] = useState<Answers>({});
  const [askUnanswered, setAskUnanswered] = useState(false);
  const [grading, setGrading] = useState<{ step: string; done: number; total: number } | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [round, setRound] = useState(0);
  /** Answers brought back from an earlier visit; asking before clearing them. */
  const [restored, setRestored] = useState(0);
  const [askClear, setAskClear] = useState(false);
  /** The question on screen. */
  const [at, setAt] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const questionRef = useRef<HTMLHeadingElement>(null);
  /** Set when the person moved to another question: its heading takes focus once it shows. */
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    questionRef.current?.focus({ preventScroll: true });
    questionRef.current?.closest("[data-question]")?.scrollIntoView({ block: "nearest" });
  });

  // Every change is kept until the answers are checked.
  useEffect(() => {
    if (quiz && !attempt) saveDraft(space, path, quiz.created, answers);
  }, [space, path, quiz, attempt, answers]);

  useEffect(() => {
    let live = true;
    studyQuiz(space, path).then(
      (q) => {
        if (!live) return;
        const kept = loadDraft(space, path, q.created, q.questions.map((x) => x.id));
        setAnswers(kept);
        setRestored(Object.values(kept).filter(isAnswered).length);
        // Back where it was left: the first question still without an answer.
        setAt(Math.max(0, q.questions.findIndex((x) => !isAnswered(kept[x.id]))));
        setQuiz(q);
      },
      (e: unknown) => live && setLoadError(plainError(e)),
    );
    return () => {
      live = false;
    };
  }, [space, path]);
  const formRef = useRef<HTMLFormElement>(null);
  const greeted = useRef(false);
  useLayoutEffect(() => {
    if (!quiz && !loadError) return;
    if (arrived && quiz && !attempt && !greeted.current) {
      greeted.current = true;
      // The first question's first control: a radio button or the answer box.
      const first = formRef.current?.querySelector<HTMLElement>("[data-question] input, [data-question] textarea");
      if (first) {
        first.focus();
        announce(`Your quiz is ready: ${mathAsText(quiz.title)}, ${plural(quiz.questions.length, "question")}. Question 1.`);
        return;
      }
    }
    headingRef.current?.focus();
  }, [quiz, loadError, attempt, round, arrived]);

  const title = quiz?.title ?? baseName(path);
  if (loadError || !quiz) {
    return (
      <Shell onBack={onBack}>
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold text-ink" data-view-focus="">
          {title}
        </h2>
        {loadError ? (
          <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink">
            <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
            <p>This quiz couldn’t be opened. {loadError}</p>
          </div>
        ) : (
          <p role="status" className="flex items-center gap-2 text-md text-ink-secondary">
            <Icon name="spinner" className="animate-spin" />
            Opening the quiz…
          </p>
        )}
      </Shell>
    );
  }

  if (attempt) {
    return (
      <Results
        space={space}
        quiz={quiz}
        attempt={attempt}
        headingRef={headingRef}
        onBack={onBack}
        onAgain={() => {
          setAttempt(null);
          setAnswers({});
          setRestored(0);
          setAt(0);
          setRound((n) => n + 1);
        }}
        onMakeFromMistakes={() => onMakeFromMistakes(attempt, quiz)}
        onStudyDeck={onStudyDeck}
      />
    );
  }

  const ids = quiz.questions.map((q) => q.id);
  const total = ids.length;
  const answered = ids.filter((q) => isAnswered(answers[q])).length;
  const missing = total - answered;
  const missingNumbers = ids.flatMap((q, i) => (isAnswered(answers[q]) ? [] : [i + 1]));
  const index = Math.min(at, total - 1);
  const q = quiz.questions[index];
  const last = index === total - 1;

  /** To another question: its heading takes focus, so it is read from its number. */
  function goTo(i: number) {
    setAskUnanswered(false);
    setAt(Math.max(0, Math.min(total - 1, i)));
    moved.current = true;
  }

  function clearAll() {
    setAnswers({});
    setRestored(0);
    setAskClear(false);
    clearDraft(space, path);
    announce("Your answers are cleared.");
    headingRef.current?.focus();
  }

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!quiz || grading) return;
    if (missing > 0 && !askUnanswered) {
      setAskUnanswered(true);
      requestAnimationFrame(() => document.getElementById(`${id}-unanswered`)?.focus());
      return;
    }
    setAskUnanswered(false);
    setSubmitError("");
    setGrading({ step: "", done: 0, total: 0 });
    let got: Attempt | undefined;
    let failed = "";
    const onEvent = (ev: StudyEvent) => {
      if (ev.type === "progress") setGrading({ step: ev.step, done: ev.done, total: ev.total });
      else if (ev.type === "error") failed = plainError(ev.message);
      else if (ev.type === "done") got = attemptOf(ev);
    };
    try {
      await studyQuizSubmit(space, path, answers, onEvent);
    } catch (err) {
      failed = plainError(err);
    }
    setGrading(null);
    if (got) {
      clearDraft(space, path);
      setAttempt(got);
    } else setSubmitError(failed || "Your answers couldn’t be checked. Try again.");
  }

  const set = (qid: string, v: string | string[]) => setAnswers((a) => ({ ...a, [qid]: v }));

  return (
    <Shell onBack={onBack}>
      <div className="flex flex-col gap-0.5">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold wrap-break-word text-ink" data-view-focus="" data-quiz-title="">
          <MathText text={quiz.title} />
        </h2>
        <p className="text-sm text-ink-secondary">
          {plural(total, "question")}
          {quiz.course ? ` · ${quiz.course}` : ""} · One at a time, in any order; your answers are checked at the end.
        </p>
      </div>
      {quiz.grounding && <GroundingSummary space={space} g={quiz.grounding} />}
      {restored > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface-sunken px-3 py-2 text-base text-ink" data-quiz-restored="">
          <Icon name="info" className="shrink-0 text-ink-secondary" />
          {askClear ? (
            <>
              <span className="min-w-0 flex-1">Clear all {plural(answered, "answer")} and start over?</span>
              <Button key="keep" type="button" variant="outline" size="sm" onClick={() => setAskClear(false)} data-keep-answers="">
                Keep them
              </Button>
              <Button key="clear" type="button" size="sm" onClick={clearAll} data-clear-answers="">
                Clear them
              </Button>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1">Your answers from before are here: {answered} of {total}. They stay until you check them.</span>
              <Button
                key="start-over"
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setAskClear(true);
                  requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-keep-answers]")?.focus());
                }}
                data-start-over=""
              >
                Start over
              </Button>
            </>
          )}
        </div>
      )}

      <nav aria-label="Questions" className="flex flex-col gap-1.5" data-question-map="">
        <p className="flex items-center gap-3 text-sm text-ink-secondary">
          <span data-answered="">
            {answered} of {total} answered
          </span>
          <span aria-hidden="true" className="h-1 w-32 overflow-hidden rounded-full bg-surface-sunken forced-colors:border forced-colors:border-[CanvasText]">
            <span className="block h-full rounded-full bg-accent-fill forced-colors:bg-[CanvasText]" style={{ width: `${(answered / Math.max(1, total)) * 100}%` }} />
          </span>
        </p>
        <ol className="flex flex-wrap gap-1.5">
          {ids.map((qid, i) => {
            const done = isAnswered(answers[qid]);
            const here = i === index;
            return (
              <li key={qid}>
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={here ? "step" : undefined}
                  aria-label={`Question ${i + 1}${done ? ", answered" : ", no answer yet"}`}
                  data-go-question={qid}
                  data-done={done ? "" : undefined}
                  className={cn(
                    "inline-flex min-h-(--ph-target-min) min-w-(--ph-target-min) cursor-default items-center justify-center gap-0.5 rounded-md border px-1.5 text-sm font-medium tabular-nums select-none",
                    "transition-[color,background-color,border-color] duration-(--ph-duration-fast) ease-out",
                    here
                      ? "border-accent-fill bg-accent-fill text-ink-inverse forced-colors:border-[Highlight] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
                      : done
                        ? "border-transparent bg-accent-soft text-ink hover:bg-hover forced-colors:border-[CanvasText]"
                        : "border-line text-ink-secondary hover:bg-hover hover:text-ink forced-colors:border-[CanvasText]",
                  )}
                >
                  {done && <Icon name="check" className="size-(--ph-icon-size-sm)" />}
                  {i + 1}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <form
        ref={formRef}
        key={round}
        onSubmit={submit}
        // Enter on a choice or in the blank is Next (on the last question, Check my answers), never an early hand-in.
        onKeyDown={(e) => {
          const t = e.target as HTMLElement;
          if (e.key !== "Enter" || e.nativeEvent.isComposing || !(t instanceof HTMLInputElement)) return;
          if (last) return;
          e.preventDefault();
          goTo(index + 1);
        }}
        noValidate
        className="flex flex-col gap-4"
        data-quiz-form=""
      >
        <QuestionField key={q.id} index={index} total={total} q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} headingRef={questionRef} />
        {submitError && (
          <div role="alert" className="flex flex-col gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink" data-quiz-error="">
            <p className="flex items-start gap-2.5">
              <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
              <span className="min-w-0 wrap-break-word">{submitError}</span>
            </p>
            {needsModel(submitError) && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => openSettings("agent")}>
                  <Icon name="settings" />
                  Open Settings
                </Button>
              </div>
            )}
          </div>
        )}
        {/* Each state of the bar has its own key: a button never turns into another kind under the pointer mid-click (a plain button reused as Submit would hand the answers in). */}
        {grading ? (
          <p key="grading" role="status" className="flex items-center gap-2 text-base text-ink-secondary" data-grading="">
            <Icon name="spinner" className="animate-spin" />
            Checking your answers{grading.total ? ` (${grading.done} of ${grading.total})` : ""}…
          </p>
        ) : askUnanswered ? (
          <div key="ask" id={`${id}-unanswered`} tabIndex={-1} role="group" aria-labelledby={`${id}-unanswered-text`} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-soft px-3 py-2.5" data-unanswered="">
            <span id={`${id}-unanswered-text`} className="min-w-0 flex-1 text-base text-ink">
              {missing === 1
                ? `Question ${missingNumbers[0]} has no answer.`
                : `${plural(missing, "question")} have no answer${missing <= 6 ? `: ${listWords(missingNumbers)}` : ""}.`}{" "}
              Check anyway?
            </span>
            <Button key="go" type="button" variant="outline" size="sm" onClick={() => goTo(missingNumbers[0] - 1)} data-go-unanswered="">
              Go to question {missingNumbers[0]}
            </Button>
            <Button key="anyway" type="submit" size="sm" data-submit-anyway="">
              Check my answers
            </Button>
          </div>
        ) : (
          <div key="steps" className="flex flex-wrap items-center gap-2" data-quiz-steps="">
            <Button key="prev" type="button" variant="outline" disabled={index === 0} onClick={() => goTo(index - 1)} data-quiz-prev="">
              <Icon name="chevron-left" />
              Previous
            </Button>
            <span className="min-w-0 flex-1" />
            {!last && (
              <Button key="check-early" type="submit" variant="ghost" data-quiz-submit="">
                Check my answers
              </Button>
            )}
            {last ? (
              <Button key="check" type="submit" data-quiz-submit="">
                Check my answers
              </Button>
            ) : (
              <Button key="next" type="button" onClick={() => goTo(index + 1)} data-quiz-next="">
                Next
                <Icon name="chevron-right" />
              </Button>
            )}
          </div>
        )}
      </form>
    </Shell>
  );
}

function QuestionField({
  index,
  total,
  q,
  value,
  onChange,
  headingRef,
}: {
  index: number;
  total: number;
  q: Question;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  const id = useId();
  const choices = q.kind === "truefalse" ? (q.choices?.length ? q.choices : ["True", "False"]) : (q.choices ?? []);
  const hasBlank = /\{\{.+?\}\}|_{3,}/.test(q.prompt);
  return (
    <fieldset className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-raised px-4 py-3.5 forced-colors:border-[CanvasText]" data-question={q.id} data-kind={q.kind}>
      <legend className="sr-only">
        Question {index + 1} of {total}. {KIND_HINT[q.kind]}
      </legend>
      <div className="flex flex-col gap-1">
        {/* Focused on moving to this question, so it is read from its number; the legend names the choices' group. */}
        <h3 ref={headingRef} tabIndex={-1} className="text-sm font-medium text-ink-secondary outline-offset-2" data-question-heading="">
          Question {index + 1} of {total} <span className="font-normal">· {KIND_HINT[q.kind]}</span>
        </h3>
        <p id={`${id}-prompt`} className="text-lg leading-normal wrap-break-word text-ink">
          {hasBlank ? <CardText text={q.prompt.replace(/_{3,}/g, "{{ }}")} /> : <MathText text={q.prompt} />}
        </p>
      </div>
      {q.kind === "choice" || q.kind === "truefalse" ? (
        <div role="radiogroup" aria-labelledby={`${id}-prompt`} className="flex flex-col gap-1">
          {choices.map((c, i) => (
            <label key={i} className="flex min-h-(--ph-control-height) cursor-default items-start gap-2.5 rounded-md px-2 py-1 text-base text-ink hover:bg-hover has-checked:bg-selected">
              <input
                type="radio"
                // A choice that is only math has its words as its name (the drawn formula alone may give none).
                aria-label={mathOnly(c) ? `${q.kind === "truefalse" ? "" : `${choiceLetter(i)}. `}${mathAsText(c)}` : undefined}
                name={`${id}-q`}
                value={c}
                checked={value === c}
                onChange={() => onChange(c)}
                className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
              />
              {q.kind !== "truefalse" && <Letter i={i} />}
              <span className="min-w-0 wrap-break-word">
                <MathText text={c} />
              </span>
            </label>
          ))}
        </div>
      ) : q.kind === "multi" ? (
        <div role="group" aria-labelledby={`${id}-prompt`} className="flex flex-col gap-1">
          {choices.map((c, i) => {
            const list = Array.isArray(value) ? value : [];
            return (
              <label key={i} className="flex min-h-(--ph-control-height) cursor-default items-start gap-2.5 rounded-md px-2 py-1 text-base text-ink hover:bg-hover has-checked:bg-selected">
                <input
                  type="checkbox"
                  aria-label={mathOnly(c) ? `${choiceLetter(i)}. ${mathAsText(c)}` : undefined}
                  checked={list.includes(c)}
                  onChange={(e) => onChange(e.target.checked ? [...list, c] : list.filter((x) => x !== c))}
                  className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
                />
                <Letter i={i} />
                <span className="min-w-0 wrap-break-word">
                  <MathText text={c} />
                </span>
              </label>
            );
          })}
        </div>
      ) : q.kind === "cloze" ? (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-a`} className="text-sm font-medium text-ink">
            What goes in the blank
          </label>
          <Input id={`${id}-a`} value={asText(value)} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-prompt`} className="max-w-md" />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-a`} className="text-sm font-medium text-ink">
            Your answer
          </label>
          <Textarea id={`${id}-a`} value={asText(value)} onChange={(e) => onChange(e.target.value)} aria-describedby={`${id}-prompt`} />
        </div>
      )}
    </fieldset>
  );
}

/** "A." before a choice, in a column of its own so the choices line up. */
function Letter({ i }: { i: number }) {
  return <span className="min-w-5 shrink-0 font-medium text-ink-secondary tabular-nums">{choiceLetter(i)}.</span>;
}

type Result = Attempt["results"][number];

function verdict(r: Result): { word: string; icon: IconName; tone: string } {
  if (r.correct) return { word: "Correct", icon: "success", tone: "text-success-ink" };
  if ((r.partial ?? 0) > 0) return { word: `Partly right (${percent(r.partial ?? 0)})`, icon: "warning", tone: "text-warning-ink" };
  return { word: "Not right", icon: "error", tone: "text-danger-ink" };
}

function Results({
  space,
  quiz,
  attempt,
  headingRef,
  onBack,
  onAgain,
  onMakeFromMistakes,
  onStudyDeck,
}: {
  space: string;
  quiz: Quiz;
  attempt: Attempt;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onBack: () => void;
  onAgain: () => void;
  onMakeFromMistakes: () => void;
  onStudyDeck: (path: string) => void;
}) {
  const [review, setReview] = useState<{ status: "running" } | { status: "done"; summary: string; deckPath?: string } | { status: "error"; message: string } | null>(null);
  const [problem, setProblem] = useState("");
  const reviewRef = useRef<HTMLHeadingElement>(null);
  const total = attempt.results.length || quiz.questions.length;
  const points = attempt.results.reduce((n, r) => n + (r.correct ? 1 : (r.partial ?? 0)), 0);
  const mistakes = attempt.results.filter((r) => !r.correct).length;
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const [show, setShow] = useState<"all" | "mistakes">("all");
  const resultId = (qid: string) => `quiz-result-${qid}`;
  /** To a question's result: shown even when only mistakes are, then its heading focused. */
  function jump(r: Result) {
    if (show === "mistakes" && r.correct) setShow("all");
    requestAnimationFrame(() => {
      const h = document.getElementById(resultId(r.id));
      h?.focus({ preventScroll: true });
      h?.closest("li")?.scrollIntoView({ block: "start" });
    });
  }

  useLayoutEffect(() => {
    if (review?.status === "done" || review?.status === "error") reviewRef.current?.focus();
  }, [review?.status]);

  async function runReview() {
    setReview({ status: "running" });
    let done: { summary: string; deckPath?: string } | null = null;
    let failed = "";
    try {
      await studyReviewMistakes(space, attempt.path, (e) => {
        if (e.type === "done") done = { summary: doneField<string>(e, "summary") ?? "", deckPath: doneField<string>(e, "deckPath") };
        else if (e.type === "error") failed = plainError(e.message);
      });
    } catch (e) {
      failed = plainError(e);
    }
    setReview(done ? { status: "done", ...(done as { summary: string; deckPath?: string }) } : { status: "error", message: failed || "The review couldn’t be made. Try again." });
  }

  const scoreWords = `${Number.isInteger(points) ? points : points.toFixed(1)} of ${total}`;
  return (
    <Shell onBack={onBack}>
      <div className="flex flex-col gap-1" data-quiz-results="">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold wrap-break-word text-ink" data-view-focus="">
          <MathText text={quiz.title} />: {scoreWords} ({percent(attempt.score)})
        </h2>
        <p className="text-base text-ink-secondary">
          {mistakes === 0 ? "Every answer was right." : `${plural(mistakes, "question")} to look at again.`}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {mistakes > 0 && (
          <>
            <Button type="button" onClick={() => void runReview()} disabled={review?.status === "running"} data-review-mistakes="">
              {review?.status === "running" ? <Icon name="spinner" className="animate-spin" /> : <Icon name="thinking" />}
              Review my mistakes
            </Button>
            <Button type="button" variant="outline" onClick={onMakeFromMistakes} data-cards-from-mistakes="">
              <Icon name="plus" />
              Make cards from my mistakes
            </Button>
          </>
        )}
        <Button type="button" variant="outline" onClick={onAgain} data-quiz-again="">
          <Icon name="retry" />
          Take it again
        </Button>
      </div>

      {review && (
        <section aria-labelledby="mistakes-review-title" className="flex flex-col gap-2 rounded-xl border border-line bg-surface-sunken px-4 py-3.5" data-mistakes-review={review.status}>
          <h3 id="mistakes-review-title" ref={reviewRef} tabIndex={-1} className="text-md font-semibold text-ink">
            {review.status === "running" ? "Looking over your mistakes…" : review.status === "error" ? "The review couldn’t be made" : "What to study next"}
          </h3>
          {review.status === "running" && (
            <p role="status" className="flex items-center gap-2 text-base text-ink-secondary">
              <Icon name="spinner" className="animate-spin" />
              Phaethon is reading what you missed and where it comes from.
            </p>
          )}
          {review.status === "error" && (
            <div role="alert" className="flex flex-col gap-2 text-base text-ink">
              <p className="flex items-start gap-2">
                <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
                <span className="min-w-0 wrap-break-word">{review.message}</span>
              </p>
              {needsModel(review.message) && (
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => openSettings("agent")}>
                    <Icon name="settings" />
                    Open Settings
                  </Button>
                </div>
              )}
            </div>
          )}
          {review.status === "done" && (
            <>
              <div className="study-markdown flex flex-col gap-2 text-base leading-normal text-ink" data-review-summary="">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD}>
                  {review.summary}
                </ReactMarkdown>
              </div>
              {review.deckPath && (
                <div>
                  <Button type="button" onClick={() => onStudyDeck(review.deckPath!)} data-review-study-deck="">
                    <Icon name="play" />
                    Study the cards made from them
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {problem && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2 text-base text-ink">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <p className="min-w-0 wrap-break-word">{problem}</p>
        </div>
      )}

      {mistakes > 0 && (
        <nav aria-label="Jump to a question" className="flex flex-col gap-2" data-result-map="">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-base font-semibold text-ink">Your answers</h3>
            {mistakes < total && (
              <div role="group" aria-label="Show" className="flex items-center gap-0.5 rounded-lg bg-surface-sunken p-0.5 forced-colors:border forced-colors:border-[CanvasText]">
                {(
                  [
                    ["all", `All ${total}`],
                    ["mistakes", `The ${mistakes} to look at again`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={show === k}
                    onClick={() => setShow(k)}
                    data-result-filter={k}
                    className={cn(
                      "min-h-(--ph-control-height-sm) cursor-default rounded-md px-2.5 py-0.5 text-sm leading-tight font-medium select-none",
                      show === k ? "bg-raised text-ink shadow-sm forced-colors:border-2 forced-colors:border-[Highlight]" : "text-ink-secondary hover:bg-hover hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <ol className="flex flex-wrap gap-1.5">
            {attempt.results.map((r, i) => {
              const v = verdict(r);
              return (
                <li key={r.id}>
                  <a
                    href={`#${resultId(r.id)}`}
                    onClick={(e) => {
                      e.preventDefault();
                      jump(r);
                    }}
                    aria-label={`Question ${i + 1}: ${v.word}`}
                    data-result-jump={r.id}
                    className={cn(
                      "inline-flex min-h-(--ph-target-min) min-w-(--ph-target-min) items-center justify-center gap-1 rounded-md border px-1.5 text-sm font-medium tabular-nums no-underline forced-colors:border-[CanvasText]",
                      r.correct ? "border-line text-ink-secondary hover:bg-hover" : "border-transparent bg-danger-soft text-ink hover:bg-danger-soft/70",
                    )}
                  >
                    <Icon name={v.icon} className={cn("size-(--ph-icon-size-sm)", v.tone)} />
                    {i + 1}
                  </a>
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <ol className="flex flex-col gap-3" aria-label="Your answers">
        {attempt.results.map((r, i) => {
          if (show === "mistakes" && r.correct) return null;
          const q = byId.get(r.id);
          const v = verdict(r);
          const choices = q && (q.kind === "choice" || q.kind === "truefalse" || q.kind === "multi") ? (q.kind === "truefalse" && !q.choices?.length ? ["True", "False"] : (q.choices ?? [])) : [];
          return (
            <li key={r.id} className="flex scroll-mt-4 flex-col gap-2 rounded-xl border border-line bg-raised px-4 py-3.5 forced-colors:border-[CanvasText]" data-result={r.id} data-verdict={r.correct ? "correct" : (r.partial ?? 0) > 0 ? "partial" : "wrong"}>
              <h3 id={resultId(r.id)} tabIndex={-1} className="flex flex-wrap items-center gap-x-2 text-base font-semibold text-ink">
                <span className="text-ink-secondary">Question {i + 1}:</span>
                <span className={cn("inline-flex items-center gap-1", v.tone)}>
                  <Icon name={v.icon} />
                  {v.word}
                </span>
              </h3>
              {q && (
                <p className="text-md wrap-break-word text-ink">
                  <MathText text={q.prompt.replace(/\{\{.+?\}\}/g, "___")} />
                </p>
              )}
              {choices.length > 0 ? (
                <ChoiceMarks kind={q!.kind} choices={choices} given={r.given} expected={r.expected} />
              ) : (
                <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-base">
                  <dt className="text-ink-secondary">Your answer</dt>
                  <dd className="wrap-break-word text-ink">{asText(r.given) ? <MathText text={asText(r.given)} /> : <span className="text-ink-secondary">No answer</span>}</dd>
                  {!r.correct && (
                    <>
                      <dt className="text-ink-secondary">Right answer</dt>
                      <dd className="wrap-break-word text-ink">
                        <MathText text={asText(r.expected)} />
                      </dd>
                    </>
                  )}
                </dl>
              )}
              {choices.length > 0 && !isAnswered(r.given) && <p className="text-base text-ink-secondary">You left this one without an answer.</p>}
              {r.feedback && (
                <p className="text-base wrap-break-word text-ink-secondary">
                  <MathText text={r.feedback} />
                </p>
              )}
              {q?.citations?.length ? (
                <SourceLine space={space} cites={q.citations} />
              ) : q?.source && (
                <div>
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    title={q.source}
                    onClick={() => openSpaceFile(space, q.source!).catch((e: unknown) => setProblem(plainError(e)))}
                    data-result-source={q.source}
                  >
                    <Icon name="file-text" />
                    Read more in {baseName(q.source)}
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </Shell>
  );
}

/**
 * A choice question's result: every choice with its letter, and beside the
 * ones that matter, in words and an icon (never colour alone), which was
 * yours and which is right.
 */
function ChoiceMarks({ kind, choices, given, expected }: { kind: Question["kind"]; choices: string[]; given: string | string[]; expected: string | string[] }) {
  const mine = new Set(Array.isArray(given) ? given : given ? [given] : []);
  const right = new Set(Array.isArray(expected) ? expected : [expected]);
  return (
    <ul className="flex flex-col gap-1" data-choice-marks="">
      {choices.map((c, i) => {
        const yours = mine.has(c);
        const ok = right.has(c);
        const words = yours && ok ? "Your answer, right" : yours ? "Your answer" : ok ? "Right answer" : "";
        return (
          <li
            key={i}
            className={cn(
              "flex items-start gap-2.5 rounded-md px-2 py-1 text-base",
              ok ? "bg-success-soft text-ink" : yours ? "bg-danger-soft text-ink" : "text-ink-secondary",
              (ok || yours) && "forced-colors:border forced-colors:border-[CanvasText]",
            )}
            data-choice-mark={yours && ok ? "yours-right" : yours ? "yours" : ok ? "right" : ""}
          >
            <span className="flex h-[1lh] shrink-0 items-center">
              <Icon name={ok || !yours ? "success" : "error"} className={cn("size-(--ph-icon-size-sm)", ok ? "text-success-ink" : yours ? "text-danger-ink" : "invisible")} />
            </span>
            {kind !== "truefalse" && <Letter i={i} />}
            <span className="min-w-0 flex-1 wrap-break-word">
              <MathText text={c} />
            </span>
            {words && <span className={cn("shrink-0 text-sm font-medium", ok ? "text-success-ink" : "text-danger-ink")}>{words}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** The review's markdown, in the app's type: headings stay small, lists keep their markers. */
type MdProps = { children?: React.ReactNode };
const MD = {
  h1: ({ children }: MdProps) => <h4 className="text-md font-semibold text-ink">{children}</h4>,
  h2: ({ children }: MdProps) => <h4 className="text-md font-semibold text-ink">{children}</h4>,
  h3: ({ children }: MdProps) => <h4 className="text-base font-semibold text-ink">{children}</h4>,
  ul: ({ children }: MdProps) => <ul className="list-disc ps-6">{children}</ul>,
  ol: ({ children }: MdProps) => <ol className="list-decimal ps-6">{children}</ol>,
  code: ({ children }: MdProps) => <code className="rounded-xs bg-hover px-1 font-mono text-sm">{children}</code>,
};

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-col gap-4 px-6 py-5">
      <div>
        <Button type="button" variant="ghost" size="sm" className="-ms-2" onClick={onBack} data-back-to-study="">
          <Icon name="chevron-left" />
          Back to Study
        </Button>
      </div>
      {children}
    </div>
  );
}
