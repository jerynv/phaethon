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
import { mathAsText, mathPieces } from "@/lib/study-math";

import { SourceLine } from "@/components/rich/citation";

import { CardText, MathText } from "./card-text";
import { GroundingSummary } from "./grounding";
import { attemptOf, baseName, doneField, needsModel, percent, plainError, plural } from "./words";

type Answers = Record<string, string | string[]>;

const KIND_HINT: Record<string, string> = {
  choice: "Choose one answer.",
  multi: "Choose all that apply.",
  truefalse: "True or false?",
  short: "Answer in a sentence or two.",
  cloze: "Fill in the blank.",
};

/** A choice that is a formula and nothing else. */
const mathOnly = (s: string) => mathPieces(s).every((p) => p.math || !p.text.trim());

const isAnswered = (a: string | string[] | undefined) => (Array.isArray(a) ? a.length > 0 : !!a?.trim());
const asText = (a: string | string[] | undefined) => (Array.isArray(a) ? a.join(", ") : a ?? "");

/**
 * A quiz, all on one page: each question is its own group with its number
 * and kind, so it can be read and answered in any order, and every answer
 * stays in view to check before handing it in. Choices are radio buttons
 * (arrow keys move between them) or checkboxes. Then the results, each
 * question marked Correct, Partly right or Not right in words and an icon,
 * with feedback and where to read more; and from there a review of the
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
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    let live = true;
    studyQuiz(space, path).then(
      (q) => live && setQuiz(q),
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
          setRound((n) => n + 1);
        }}
        onMakeFromMistakes={() => onMakeFromMistakes(attempt, quiz)}
        onStudyDeck={onStudyDeck}
      />
    );
  }

  const answered = quiz.questions.filter((q) => isAnswered(answers[q.id])).length;
  const missing = quiz.questions.length - answered;

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
    if (got) setAttempt(got);
    else setSubmitError(failed || "Your answers couldn’t be checked. Try again.");
  }

  const set = (qid: string, v: string | string[]) => setAnswers((a) => ({ ...a, [qid]: v }));

  return (
    <Shell onBack={onBack}>
      <div className="flex flex-col gap-0.5">
        <h2 ref={headingRef} tabIndex={-1} className="text-xl font-semibold wrap-break-word text-ink" data-view-focus="" data-quiz-title="">
          <MathText text={quiz.title} />
        </h2>
        <p className="text-sm text-ink-secondary">
          {plural(quiz.questions.length, "question")}
          {quiz.course ? ` · ${quiz.course}` : ""} · Answer them in any order, then check your answers at the end.
        </p>
      </div>
      {quiz.grounding && <GroundingSummary space={space} g={quiz.grounding} />}
      <form ref={formRef} key={round} onSubmit={submit} noValidate className="flex flex-col gap-4" data-quiz-form="">
        <ol className="flex flex-col gap-4">
          {quiz.questions.map((q, i) => (
            <li key={q.id}>
              <QuestionField space={space} index={i} total={quiz.questions.length} q={q} value={answers[q.id]} onChange={(v) => set(q.id, v)} />
            </li>
          ))}
        </ol>
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
        <div className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line bg-raised px-3 py-2.5 shadow-sm forced-colors:border-[CanvasText]">
          <p className="min-w-0 flex-1 text-base text-ink" data-answered="">
            {answered} of {quiz.questions.length} answered
          </p>
          {grading ? (
            <p role="status" className="flex items-center gap-2 text-base text-ink-secondary" data-grading="">
              <Icon name="spinner" className="animate-spin" />
              Checking your answers{grading.total ? ` (${grading.done} of ${grading.total})` : ""}…
            </p>
          ) : askUnanswered ? (
            <div id={`${id}-unanswered`} tabIndex={-1} role="group" aria-labelledby={`${id}-unanswered-text`} className="flex flex-wrap items-center gap-2" data-unanswered="">
              <span id={`${id}-unanswered-text`} className="text-base text-ink">
                {plural(missing, "question")} {missing === 1 ? "has" : "have"} no answer. Check anyway?
              </span>
              <Button type="button" variant="outline" size="sm" onClick={() => setAskUnanswered(false)}>
                Keep answering
              </Button>
              <Button type="submit" size="sm" data-submit-anyway="">
                Check my answers
              </Button>
            </div>
          ) : (
            <Button type="submit" data-quiz-submit="">
              Check my answers
            </Button>
          )}
        </div>
      </form>
    </Shell>
  );
}

function QuestionField({
  space,
  index,
  total,
  q,
  value,
  onChange,
}: {
  space: string;
  index: number;
  total: number;
  q: Question;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
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
        <p aria-hidden="true" className="text-sm font-medium text-ink-secondary">
          Question {index + 1} <span className="font-normal">· {KIND_HINT[q.kind]}</span>
        </p>
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
                aria-label={mathOnly(c) ? mathAsText(c) : undefined}
                name={`${id}-q`}
                value={c}
                checked={value === c}
                onChange={() => onChange(c)}
                className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
              />
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
                  aria-label={mathOnly(c) ? mathAsText(c) : undefined}
                  checked={list.includes(c)}
                  onChange={(e) => onChange(e.target.checked ? [...list, c] : list.filter((x) => x !== c))}
                  className="mt-[calc((1lh-var(--ph-icon-size))/2)] size-(--ph-icon-size) shrink-0 accent-accent-fill"
                />
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
      {q.citations?.length ? <SourceLine space={space} cites={q.citations} className="border-t border-line pt-2" /> : null}
    </fieldset>
  );
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

      <ol className="flex flex-col gap-3" aria-label="Your answers">
        {attempt.results.map((r, i) => {
          const q = byId.get(r.id);
          const v = verdict(r);
          return (
            <li key={r.id} className="flex flex-col gap-2 rounded-xl border border-line bg-raised px-4 py-3.5 forced-colors:border-[CanvasText]" data-result={r.id} data-verdict={r.correct ? "correct" : (r.partial ?? 0) > 0 ? "partial" : "wrong"}>
              <h3 className="flex flex-wrap items-center gap-x-2 text-base font-semibold text-ink">
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
