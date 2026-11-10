/**
 * Taking a quiz: one question per screen or the whole form, answers kept on
 * this computer until checked, flags and a question map, then results with
 * each question's verdict, the right answer, the explanation and the passage
 * it came from. A short answer the core couldn't grade shows as not graded and
 * is left out of the score, as the core leaves it out.
 */
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleHelpIcon,
  FlagIcon,
  InfoIcon,
  LayersIcon,
  MessageCircleQuestionIcon,
  MinusIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { announce } from "../courses/shared/announce";
import { useComposeRequest } from "../courses/shared/compose-request";
import { EduPage, ErrorState, Meter, PageHeader, Progress } from "../courses/shared/kit";
import { studyQuiz, studyQuizSubmit, studyReviewMistakes } from "./api";
import { CardText, MathText } from "./CardText";
import { GroundingSummary, SourceLine } from "./Grounding";
import { mathAsText } from "./lib/math";
import {
  answerList,
  attemptPoints,
  choiceLabel,
  choiceLetter,
  choicesOf,
  clearDraft,
  includesAnswer,
  isAnswered,
  listWords,
  loadDraft,
  pointsText,
  saveDraft,
  verdictOf,
  type Answer,
  type Answers,
  type Verdict,
} from "./lib/quiz-answers";
import { loadQuizSession, questionHelpContext, saveQuizSession, type QuizSession } from "./lib/quiz-session";
import type { Attempt, Question, Quiz, QuestionResult } from "./lib/types";
import { baseName, needsModel, percent, plainError, plural, progressWords } from "./lib/words";

const KIND_HINT: Record<Question["kind"], string> = {
  choice: "Choose one.",
  truefalse: "True or false.",
  multi: "Choose all that apply.",
  cloze: "Fill in the blank.",
  short: "Answer in a sentence or two.",
};

export function QuizView({
  space,
  path,
  arrived,
  onBack,
  onMakeFromMistakes,
  onStudyDeck,
}: {
  space: string;
  path: string;
  arrived?: boolean;
  onBack: () => void;
  onMakeFromMistakes: (attempt: Attempt, quiz: Quiz) => void;
  onStudyDeck: (deckPath: string) => void;
}) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [restored, setRestored] = useState(0);
  const [session, setSession] = useState<QuizSession>({ layout: "single", flagged: [], at: 0 });
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [grading, setGrading] = useState<{ done: number; total: number } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [missing, setMissing] = useState<number[] | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [focusQ, setFocusQ] = useState(0);
  const missingRef = useRef<HTMLDivElement>(null);
  const openSettings = useNav((s) => s.openSettings);

  const load = useCallback(() => {
    setError(null);
    studyQuiz(space, path).then(
      (q) => {
        const ids = q.questions.map((x) => x.id);
        const draft = loadDraft(space, path, q.created, ids);
        setQuiz(q);
        setAnswers(draft);
        setRestored(Object.values(draft).filter(isAnswered).length);
        setSession(loadQuizSession(space, path, q.created, ids));
        if (arrived) announce(`Your quiz is ready: ${mathAsText(q.title)}, ${plural(q.questions.length, "question")}. Question 1.`);
      },
      (e) => setError(errorText(e)),
    );
  }, [space, path, arrived]);
  useEffect(load, [load]);

  const ids = useMemo(() => quiz?.questions.map((q) => q.id) ?? [], [quiz]);
  const answered = ids.filter((id) => isAnswered(answers[id])).length;

  const setAnswer = (id: string, a: Answer) => {
    if (!quiz) return;
    const next = { ...answers, [id]: a };
    setAnswers(next);
    saveDraft(space, path, quiz.created, next);
  };
  const updateSession = (patch: Partial<QuizSession>) => {
    if (!quiz) return;
    const next = { ...session, ...patch };
    setSession(next);
    saveQuizSession(space, path, quiz.created, next);
  };
  const goTo = (i: number) => {
    updateSession({ at: i });
    setFocusQ((n) => n + 1);
  };

  const submit = async (force = false) => {
    if (!quiz) return;
    const gaps = ids.map((id, i) => (isAnswered(answers[id]) ? -1 : i)).filter((i) => i >= 0);
    if (gaps.length && !force) {
      setMissing(gaps);
      requestAnimationFrame(() => missingRef.current?.focus());
      return;
    }
    setMissing(null);
    setSubmitError(null);
    setGrading({ done: 0, total: 0 });
    let got: Attempt | null = null;
    let failed: string | null = null;
    const end = await studyQuizSubmit(space, path, answers, (e) => {
      if (e.type === "progress") setGrading({ done: e.done, total: e.total });
      else if (e.type === "error") failed = e.message;
      else if (e.type === "done" && e.attempt) got = e.attempt;
    });
    if (end.kind === "rejected") failed = plainError(end.error);
    setGrading(null);
    if (got) {
      clearDraft(space, path);
      setAttempt(got);
    } else setSubmitError(failed ?? "Your answers couldn’t be checked. Try again.");
  };

  const again = () => {
    if (!quiz) return;
    setAttempt(null);
    setAnswers({});
    setRestored(0);
    clearDraft(space, path);
    updateSession({ at: 0, flagged: [] });
    setFormKey((k) => k + 1);
  };

  const help = (q: Question) => {
    if (!quiz) return;
    useComposeRequest.getState().compose(space, questionHelpContext(quiz, path, q, answers[q.id]));
    useNav.getState().go({ kind: "chat" }, space);
  };

  if (error)
    return (
      <EduPage narrow>
        <PageHeader title={baseName(path)} back={{ label: "Study", onClick: onBack }} focusKey="error" />
        <ErrorState title="This quiz couldn’t be opened." message={error} onRetry={load} />
      </EduPage>
    );
  if (!quiz)
    return (
      <EduPage narrow>
        <PageHeader title={baseName(path)} back={{ label: "Study", onClick: onBack }} meta="Opening the quiz…" />
        <div role="status" aria-label="Opening the quiz" className="h-80 rounded-2xl border bg-card motion-safe:animate-pulse" />
      </EduPage>
    );

  if (attempt)
    return <QuizResults space={space} quiz={quiz} attempt={attempt} onBack={onBack} onAgain={again} onMakeFromMistakes={() => onMakeFromMistakes(attempt, quiz)} onStudyDeck={onStudyDeck} />;

  const n = quiz.questions.length;
  const at = Math.min(session.at, n - 1);
  const single = session.layout === "single";
  const shown = single ? [quiz.questions[at]!] : quiz.questions;

  return (
    <EduPage narrow label={`Quiz: ${mathAsText(quiz.title)}`}>
      <PageHeader
        back={{ label: "Study", onClick: onBack }}
        title={<MathText text={quiz.title} />}
        focusKey={arrived ? undefined : "quiz"}
        meta={[plural(n, "question"), quiz.course, quiz.grounding?.exam].filter(Boolean).join(" · ")}
        actions={
          <>
            <ToggleGroup variant="segmented" size="sm" aria-label="Layout" value={[session.layout]} onValueChange={(v) => v[0] && updateSession({ layout: v[0] as QuizSession["layout"] })}>
              <ToggleGroupItem value="single">One at a time</ToggleGroupItem>
              <ToggleGroupItem value="all">All questions</ToggleGroupItem>
            </ToggleGroup>
            {(quiz.grounding || quiz.sources.length > 0) && (
              <Popover>
                <PopoverTrigger render={<Button variant="ghost" size="icon" aria-label="Where this quiz comes from" />}>
                  <InfoIcon aria-hidden />
                </PopoverTrigger>
                <PopoverPopup className="w-[min(26rem,calc(100vw-2rem))]" align="end">
                  <div className="flex flex-col gap-3 text-sm">
                    <h2 className="font-semibold">Where it comes from</h2>
                    {quiz.grounding && <GroundingSummary g={quiz.grounding} space={space} noun="question" />}
                    {quiz.sources.length > 0 && <p className="text-muted-foreground">Made from {quiz.sources.map(baseName).join(", ")}.</p>}
                  </div>
                </PopoverPopup>
              </Popover>
            )}
          </>
        }
      />

      {restored > 0 && (
        <div className="-mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card px-4 py-2.5 text-sm" data-quiz-draft="">
          <span className="text-muted-foreground">
            Your answers from before are here · {answered} of {n} answered
          </span>
          <Button size="sm" variant="ghost" onClick={again}>
            <RotateCcwIcon aria-hidden />
            Start over
          </Button>
        </div>
      )}

      <QuestionMap
        quiz={quiz}
        answers={answers}
        flagged={session.flagged}
        current={single ? at : -1}
        onPick={(i) => (single ? goTo(i) : document.getElementById(`quiz-q-${quiz.questions[i]!.id}`)?.focus())}
      />

      <form
        key={formKey}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-6"
      >
        {shown.map((q) => {
          const i = quiz.questions.indexOf(q);
          return (
            <QuestionField
              key={q.id}
              q={q}
              i={i}
              n={n}
              value={answers[q.id]}
              flagged={session.flagged.includes(q.id)}
              focusKey={single ? focusQ : undefined}
              onChange={(a) => setAnswer(q.id, a)}
              onFlag={() => updateSession({ flagged: session.flagged.includes(q.id) ? session.flagged.filter((x) => x !== q.id) : [...session.flagged, q.id] })}
              onHelp={() => help(q)}
              onEnter={single && i < n - 1 ? () => goTo(i + 1) : undefined}
            />
          );
        })}

        {missing && (
          <div ref={missingRef} tabIndex={-1} role="group" aria-label="Questions without an answer" className="flex flex-col gap-3 rounded-xl border border-warning/32 bg-warning-surface p-4 outline-none" data-quiz-missing="">
            <p className="text-sm text-warning-foreground">
              {missing.length === 1
                ? `Question ${missing[0]! + 1} has no answer.`
                : `${missing.length} questions have no answer${missing.length <= 6 ? `: ${listWords(missing.map((i) => i + 1))}` : ""}.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => {
                  setMissing(null);
                  if (single) goTo(missing[0]!);
                  else document.getElementById(`quiz-q-${ids[missing[0]!]}`)?.focus();
                }}
              >
                Go to question {missing[0]! + 1}
              </Button>
              <Button size="sm" type="button" onClick={() => void submit(true)}>
                Check them anyway
              </Button>
            </div>
          </div>
        )}

        {grading ? (
          <div className="flex flex-col gap-2" data-quiz-grading="">
            <Progress value={grading.total ? grading.done / grading.total : null} label="Checking your answers" valueText={grading.total ? `${grading.done} of ${grading.total}` : undefined} />
            <p role="status" className="text-sm text-muted-foreground">
              {progressWords({ step: "grading", done: grading.done, total: grading.total }, { quiz: true })}
            </p>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
            {single ? (
              <>
                <Button type="button" variant="ghost" disabled={at === 0} onClick={() => goTo(at - 1)}>
                  <ChevronLeftIcon aria-hidden />
                  Previous
                </Button>
                <div className="flex gap-2">
                  {at < n - 1 && answered > 0 && (
                    <Button type="submit" variant="ghost">
                      Check my answers
                    </Button>
                  )}
                  {at < n - 1 ? (
                    <Button type="button" onClick={() => goTo(at + 1)}>
                      Next
                      <ChevronRightIcon aria-hidden />
                    </Button>
                  ) : (
                    <Button type="submit">Check my answers</Button>
                  )}
                </div>
              </>
            ) : (
              <>
                <span className="text-sm text-muted-foreground">
                  {answered} of {n} answered
                </span>
                <Button type="submit">Check my answers</Button>
              </>
            )}
          </div>
        )}
        {submitError && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-error/32 bg-error-surface px-4 py-3 text-sm text-error-foreground">
            <span className="me-auto">{submitError}</span>
            {needsModel(submitError) && (
              <Button size="sm" variant="outline" type="button" onClick={() => openSettings("assistant")}>
                Open Settings
              </Button>
            )}
          </div>
        )}
      </form>
    </EduPage>
  );
}

function QuestionMap({ quiz, answers, flagged, current, onPick }: { quiz: Quiz; answers: Answers; flagged: string[]; current: number; onPick: (i: number) => void }) {
  const answered = quiz.questions.filter((q) => isAnswered(answers[q.id])).length;
  return (
    <nav aria-label="Questions" className="flex flex-col gap-2.5">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span className="shrink-0 tabular-nums">
          {answered} of {quiz.questions.length} answered
        </span>
        <Meter value={answered / quiz.questions.length} />
      </div>
      <ol className="flex flex-wrap gap-1.5">
        {quiz.questions.map((q, i) => {
          const done = isAnswered(answers[q.id]);
          const flag = flagged.includes(q.id);
          return (
            <li key={q.id}>
              <button
                type="button"
                onClick={() => onPick(i)}
                aria-current={i === current ? "step" : undefined}
                aria-label={`Question ${i + 1}, ${done ? "answered" : "no answer yet"}${flag ? ", flagged" : ""}`}
                className={cn(
                  "relative flex size-8 items-center justify-center rounded-lg border text-sm font-medium tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  done ? "border-primary/30 bg-primary/10 text-foreground" : "bg-card text-muted-foreground hover:bg-accent",
                  i === current && "border-foreground ring-1 ring-foreground",
                )}
              >
                {i + 1}
                {flag && <FlagIcon aria-hidden className="absolute -top-1.5 -right-1.5 size-3.5 fill-warning text-warning-foreground" />}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function QuestionField({
  q,
  i,
  n,
  value,
  flagged,
  focusKey,
  onChange,
  onFlag,
  onHelp,
  onEnter,
}: {
  q: Question;
  i: number;
  n: number;
  value: Answer | undefined;
  flagged: boolean;
  focusKey?: number;
  onChange: (a: Answer) => void;
  onFlag: () => void;
  onHelp: () => void;
  onEnter?: () => void;
}) {
  const id = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusKey) headingRef.current?.focus({ preventScroll: false });
  }, [focusKey]);
  const choices = choicesOf(q);
  const enter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && onEnter) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <fieldset className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:p-6" data-question={q.id}>
      <legend className="sr-only">
        Question {i + 1} of {n}. {KIND_HINT[q.kind]}
      </legend>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm text-muted-foreground">
            Question {i + 1} of {n} · {KIND_HINT[q.kind]}
          </span>
          <h3 ref={headingRef} id={`quiz-q-${q.id}`} tabIndex={-1} className="text-lg leading-relaxed font-medium text-foreground outline-none">
            {/\{\{.*?\}\}|_{3,}/.test(q.prompt) ? <CardText text={q.prompt} /> : <MathText text={q.prompt} />}
          </h3>
        </div>
        <div className="flex shrink-0 gap-0.5">
          <Button type="button" size="icon-sm" variant="ghost" aria-pressed={flagged} aria-label={`Flag question ${i + 1}`} onClick={onFlag} className={cn(flagged && "text-warning-foreground")}>
            <FlagIcon aria-hidden className={cn(flagged && "fill-warning")} />
          </Button>
          <Button type="button" size="icon-sm" variant="ghost" aria-label={`Ask for help with question ${i + 1}`} onClick={onHelp}>
            <MessageCircleQuestionIcon aria-hidden />
          </Button>
        </div>
      </div>

      {(q.kind === "choice" || q.kind === "truefalse") && (
        <div role="radiogroup" aria-labelledby={`quiz-q-${q.id}`} className={cn("grid gap-2", q.kind === "truefalse" && "sm:grid-cols-2")}>
          {choices.map((c, k) => {
            const checked = typeof value === "string" && value === c;
            const spoken = mathAsText(c) !== c ? `${choiceLetter(k)}. ${mathAsText(c)}` : undefined;
            return (
              <label
                key={c}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-[0.9375rem] transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring motion-reduce:transition-none",
                  checked ? "border-primary bg-primary/8" : "hover:bg-accent",
                )}
              >
                <input
                  type="radio"
                  name={`${id}-r`}
                  className="peer sr-only"
                  checked={checked}
                  aria-label={spoken}
                  onChange={() => onChange(c)}
                  onClick={(e) => {
                    if (checked) {
                      e.preventDefault();
                      onChange("");
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === " " && checked) {
                      e.preventDefault();
                      onChange("");
                    }
                  }}
                />
                <span
                  aria-hidden
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-sm font-semibold",
                    checked ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground",
                  )}
                >
                  {choiceLetter(k)}
                </span>
                <span className="min-w-0 pt-0.5 text-foreground">
                  <MathText text={choiceLabel(q, c)} />
                </span>
              </label>
            );
          })}
        </div>
      )}

      {q.kind === "multi" && (
        <div className="grid gap-2" role="group" aria-labelledby={`quiz-q-${q.id}`}>
          {choices.map((c, k) => {
            const list = Array.isArray(value) ? value : [];
            const checked = list.includes(c);
            return (
              <label
                key={c}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 text-[0.9375rem] transition-colors has-focus-visible:ring-2 has-focus-visible:ring-ring motion-reduce:transition-none",
                  checked ? "border-primary bg-primary/8" : "hover:bg-accent",
                )}
              >
                <input
                  type="checkbox"
                  className="sr-only"
                  checked={checked}
                  aria-label={mathAsText(c) !== c ? `${choiceLetter(k)}. ${mathAsText(c)}` : undefined}
                  onChange={() => onChange(checked ? list.filter((x) => x !== c) : [...list, c])}
                />
                <span aria-hidden className={cn("flex size-6 shrink-0 items-center justify-center rounded-md border", checked ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground")}>
                  {checked ? <CheckIcon className="size-4" /> : <span className="text-sm font-semibold">{choiceLetter(k)}</span>}
                </span>
                <span className="min-w-0 pt-0.5 text-foreground">
                  <MathText text={c} />
                </span>
              </label>
            );
          })}
        </div>
      )}

      {q.kind === "cloze" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-cloze`} className="text-sm font-medium text-foreground">
            What goes in the blank
          </label>
          <Input id={`${id}-cloze`} className="max-w-sm" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} onKeyDown={enter} autoComplete="off" />
        </div>
      )}

      {q.kind === "short" && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-short`} className="text-sm font-medium text-foreground">
            Your answer
          </label>
          <Textarea id={`${id}-short`} rows={3} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />
        </div>
      )}
    </fieldset>
  );
}

const VERDICT: Record<Verdict, { word: (r: QuestionResult) => string; icon: React.ReactNode; className: string }> = {
  correct: { word: () => "Correct", icon: <CheckIcon aria-hidden />, className: "text-success-foreground" },
  partial: { word: (r) => `Partly right (${percent(r.partial ?? 0)})`, icon: <MinusIcon aria-hidden />, className: "text-warning-foreground" },
  wrong: { word: () => "Not right", icon: <XIcon aria-hidden />, className: "text-destructive-foreground" },
  ungraded: { word: () => "Not graded", icon: <CircleHelpIcon aria-hidden />, className: "text-muted-foreground" },
};

function QuizResults({
  space,
  quiz,
  attempt,
  onBack,
  onAgain,
  onMakeFromMistakes,
  onStudyDeck,
}: {
  space: string;
  quiz: Quiz;
  attempt: Attempt;
  onBack: () => void;
  onAgain: () => void;
  onMakeFromMistakes: () => void;
  onStudyDeck: (deckPath: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "again">("all");
  const [review, setReview] = useState<{ state: "running" | "done" | "error"; summary?: string; deckPath?: string; message?: string } | null>(null);
  const results = attempt.results.length ? attempt.results : [];
  const { points, total, ungraded } = attemptPoints(results);
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const again = results.filter((r) => verdictOf(r) !== "correct");
  const list = filter === "all" ? results : again;
  const mistakes = results.filter((r) => verdictOf(r) === "wrong" || verdictOf(r) === "partial").length;

  const runReview = async () => {
    setReview({ state: "running" });
    let done: { summary?: string; deckPath?: string } | null = null;
    let message: string | null = null;
    const end = await studyReviewMistakes(space, attempt.path, (e) => {
      if (e.type === "done") done = { summary: e.summary, deckPath: e.deckPath };
      else if (e.type === "error") message = e.message;
    });
    if (end.kind === "rejected") message = plainError(end.error);
    setReview(done ? { state: "done", ...(done as { summary?: string; deckPath?: string }) } : { state: "error", message: message ?? "The review couldn’t be made. Try again." });
  };

  return (
    <EduPage narrow label="Quiz results">
      <PageHeader back={{ label: "Study", onClick: onBack }} title={<MathText text={quiz.title} />} focusKey="results" meta="Results" />
      <section aria-labelledby="score-h" className="flex flex-col gap-4 rounded-2xl border bg-card p-5 sm:p-6" data-quiz-score="">
        <div className="flex flex-col gap-1">
          <h2 id="score-h" className="text-sm font-medium text-muted-foreground">
            Your score
          </h2>
          <p className="text-3xl font-semibold tracking-tight whitespace-nowrap text-foreground tabular-nums">
            {total > 0 ? `${pointsText(points)} of ${total}` : "Not graded"}
            {total > 0 && <span className="ms-2 text-xl font-medium text-muted-foreground">{percent(attempt.score)}</span>}
          </p>
          {ungraded > 0 && (
            <p className="text-sm text-muted-foreground">
              {plural(ungraded, "answer")} couldn’t be graded and {ungraded === 1 ? "isn’t" : "aren’t"} in the score.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {mistakes > 0 && (
            <Button variant="outline" onClick={() => void runReview()} disabled={review?.state === "running"}>
              Review my mistakes
            </Button>
          )}
          {mistakes > 0 && (
            <Button variant="outline" onClick={onMakeFromMistakes}>
              <LayersIcon aria-hidden />
              Cards from mistakes
            </Button>
          )}
          <Button variant="ghost" onClick={onAgain}>
            <RotateCcwIcon aria-hidden />
            Take it again
          </Button>
        </div>
      </section>

      {review && (
        <section aria-label="Review of your mistakes" className="flex flex-col gap-3 rounded-2xl border bg-card p-5 sm:p-6" aria-busy={review.state === "running"}>
          {review.state === "running" ? (
            <p role="status" className="text-sm text-muted-foreground">
              {progressWords({ step: "reviewing", done: 0, total: 1 }, { quiz: true })}
            </p>
          ) : review.state === "error" ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {review.message}
            </p>
          ) : (
            <>
              <div className="prose-edu text-[0.9375rem] leading-relaxed text-foreground [&_h2]:mt-4 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h2:first-child]:mt-0 [&_li]:my-1 [&_ul]:list-disc [&_ul]:ps-5">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                  {review.summary ?? ""}
                </ReactMarkdown>
              </div>
              {review.deckPath && (
                <div>
                  <Button size="sm" onClick={() => onStudyDeck(review.deckPath!)}>
                    Study the cards made from them
                  </Button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Questions</h2>
        {again.length > 0 && again.length < results.length && (
          <ToggleGroup variant="segmented" size="sm" aria-label="Show" value={[filter]} onValueChange={(v) => v[0] && setFilter(v[0] as "all" | "again")}>
            <ToggleGroupItem value="all">All {results.length}</ToggleGroupItem>
            <ToggleGroupItem value="again">To look at again ({again.length})</ToggleGroupItem>
          </ToggleGroup>
        )}
      </div>
      <ol className="flex flex-col gap-4">
        {list.map((r) => {
          const q = byId.get(r.id);
          if (!q) return null;
          const i = quiz.questions.indexOf(q);
          return <ResultCard key={r.id} space={space} q={q} r={r} i={i} />;
        })}
      </ol>
    </EduPage>
  );
}

function ResultCard({ space, q, r, i }: { space: string; q: Question; r: QuestionResult; i: number }) {
  const verdict = verdictOf(r);
  const v = VERDICT[verdict];
  const choices = choicesOf(q);
  const openFile = useNav((s) => s.openFile);
  const cites = q.citations ?? [];
  return (
    <li className="flex flex-col gap-4 rounded-2xl border bg-card p-5 sm:p-6" data-result={r.id} data-verdict={verdict}>
      <div className="flex flex-col gap-1.5">
        <p className={cn("flex items-center gap-1.5 text-sm font-semibold [&_svg]:size-4", v.className)}>
          {v.icon}
          <span>
            Question {i + 1}: {v.word(r)}
          </span>
        </p>
        <div className="text-[0.9375rem] leading-relaxed font-medium text-foreground">
          <MathText text={q.prompt.replace(/\{\{.*?\}\}/g, "___")} />
        </div>
      </div>
      {choices.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {choices.map((c, k) => {
            const mine = includesAnswer(r.given, c);
            const right = includesAnswer(r.expected, c);
            if (!mine && !right) return (
              <li key={c} className="flex items-start gap-3 px-3 py-1.5 text-sm text-muted-foreground">
                <span className="w-6 shrink-0 text-center font-semibold">{choiceLetter(k)}</span>
                <MathText text={choiceLabel(q, c)} />
              </li>
            );
            return (
              <li
                key={c}
                className={cn(
                  "flex items-start gap-3 rounded-lg border px-3 py-1.5 text-sm",
                  right ? "border-success/40 bg-success/6" : "border-destructive/30 bg-error-surface",
                )}
              >
                <span className="w-6 shrink-0 text-center font-semibold text-foreground">{choiceLetter(k)}</span>
                <span className="min-w-0 flex-1 text-foreground">
                  <MathText text={choiceLabel(q, c)} />
                </span>
                <span className={cn("flex shrink-0 items-center gap-1 text-sm font-medium [&_svg]:size-3.5", right ? "text-success-foreground" : "text-destructive-foreground")}>
                  {right ? <CheckIcon aria-hidden /> : <XIcon aria-hidden />}
                  {mine && right ? "Your answer, right" : mine ? "Your answer" : "Right answer"}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted-foreground">Your answer</dt>
          <dd className="text-foreground">{answerList(r.given).length ? <MathText text={answerList(r.given).join(", ")} /> : <span className="text-muted-foreground">No answer</span>}</dd>
          {verdict !== "correct" && (
            <>
              <dt className="text-muted-foreground">{q.kind === "short" ? "A good answer" : "Right answer"}</dt>
              <dd className="text-foreground">
                <MathText text={answerList(r.expected).join(", ")} />
              </dd>
            </>
          )}
        </dl>
      )}
      <div className={cn("text-sm leading-relaxed", verdict === "ungraded" ? "rounded-lg bg-muted px-3 py-2 text-foreground" : "text-muted-foreground")}>
        <MathText text={r.feedback} />
      </div>
      {cites.length ? (
        <SourceLine cites={cites} space={space} />
      ) : q.source ? (
        <button type="button" className="self-start text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground" onClick={() => openFile(q.source!, space)}>
          Read more in {baseName(q.source)}
        </button>
      ) : null}
    </li>
  );
}
