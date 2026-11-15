import { CheckIcon, CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, CircleXIcon, RotateCcwIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useDelayed } from "@/hooks/use-delayed";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { cn } from "@/lib/utils";
import { studyQuiz, studyQuizSubmit, studyReviewMistakes } from "../api";
import { kindLabel } from "../lib/kinds";
import { countText, jobFraction } from "../lib/progress";
import {
  type Answer,
  type Answers,
  answerList,
  attemptPoints,
  choiceLabel,
  choiceLetter,
  choicesOf,
  clearDraft,
  includesAnswer,
  isAnswered,
  loadDraft,
  pointsText,
  saveDraft,
  tidyScope,
  verdictOf,
  type Verdict,
} from "../lib/quiz-answers";
import type { Attempt, Question, QuestionResult, Quiz, StudyEvent } from "../lib/types";
import { needsModel, plural, progressWords, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { Crumbs, JobBar, JobLine, StudyText } from "./parts";

type Job = { kind: "grading" | "reviewing"; progress: MakeProgress | null; fraction: number };

/**
 * Taking a quiz: every question with its own kind of answer, kept as a draft
 * until checked; then the graded attempt (right / partly / wrong per question,
 * the feedback and the passages it comes from), a retry of the missed ones,
 * and a look over the mistakes.
 */
export function QuizScreen({ space, path, onBack, open }: { space: SpaceView; path: string; onBack: () => void; open: (s: StudyScreen) => void }) {
  const quiz = useLoad(() => studyQuiz(space.id, path), [space.id, path]);
  const skeleton = useDelayed(quiz.loading && !quiz.data);
  const [answers, setAnswers] = useState<Answers>({});
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [only, setOnly] = useState<string[] | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [review, setReview] = useState<{ summary: string; deckPath?: string } | null>(null);
  const run = useRef(0);
  const q = quiz.data;

  useEffect(() => {
    if (q) setAnswers(loadDraft(space.id, path, q.created, q.questions.map((x) => x.id)));
  }, [q, space.id, path]);

  const setAnswer = (id: string, a: Answer) => {
    setAnswers((cur) => {
      const next = { ...cur, [id]: a };
      if (q) saveDraft(space.id, path, q.created, next);
      return next;
    });
  };

  const shown = useMemo(() => (q ? (only ? q.questions.filter((x) => only.includes(x.id)) : q.questions) : []), [q, only]);
  const answered = q ? q.questions.filter((x) => isAnswered(answers[x.id])).length : 0;
  const results = useMemo(() => new Map((attempt?.results ?? []).map((r) => [r.id, r])), [attempt]);
  const missed = attempt ? attempt.results.filter((r) => !r.ungraded && !r.correct).map((r) => r.id) : [];

  const submit = async () => {
    if (!q) return;
    const id = ++run.current;
    setJob({ kind: "grading", progress: null, fraction: 0 });
    setError(null);
    let failed: string | null = null;
    let got: Attempt | null = null;
    const end = await studyQuizSubmit(space.id, path, answers, (e: StudyEvent) => {
      if (run.current !== id) return;
      if (e.type === "progress") setJob((j) => j && { ...j, progress: e, fraction: jobFraction(e, "single", j.fraction) });
      else if (e.type === "error") failed = e.message;
      else if (e.type === "done" && e.attempt) got = e.attempt;
    });
    if (run.current !== id) return;
    setJob(null);
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (!got && !failed) failed = "Phaethon’s core stopped answering before it finished grading.";
    if (failed) return setError({ title: "Couldn’t check your answers", message: failed });
    setAttempt(got);
    setOnly(null);
    setReview(null);
    clearDraft(space.id, path);
    document.getElementById("quiz-top")?.scrollIntoView({ block: "start" });
  };

  const reviewMistakes = async () => {
    if (!attempt) return;
    const id = ++run.current;
    setJob({ kind: "reviewing", progress: null, fraction: 0 });
    setError(null);
    let failed: string | null = null;
    let got: { summary: string; deckPath?: string } | null = null;
    const end = await studyReviewMistakes(space.id, attempt.path, (e) => {
      if (run.current !== id) return;
      if (e.type === "progress") setJob((j) => j && { ...j, progress: e, fraction: jobFraction(e, "single", j.fraction) });
      else if (e.type === "error") failed = e.message;
      else if (e.type === "done") got = { summary: e.summary ?? "", deckPath: e.deckPath };
    });
    if (run.current !== id) return;
    setJob(null);
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (failed) return setError({ title: "Couldn’t look over your mistakes", message: failed });
    setReview(got);
  };

  const retryMistakes = () => {
    if (!q || !attempt) return;
    const next = { ...answers };
    for (const id of missed) delete next[id];
    // Answers given in the attempt stand for the ones that were right.
    for (const r of attempt.results) if (!missed.includes(r.id) && next[r.id] == null) next[r.id] = typeof r.given === "boolean" ? String(r.given) : r.given;
    setAnswers(next);
    saveDraft(space.id, path, q.created, next);
    setOnly(missed);
    setAttempt(null);
    setReview(null);
    document.getElementById("quiz-top")?.scrollIntoView({ block: "start" });
  };

  const takeAgain = () => {
    if (!q) return;
    setAnswers({});
    clearDraft(space.id, path);
    setAttempt(null);
    setOnly(null);
    setReview(null);
  };

  return (
    <>
      <Header title={<Crumbs onBack={onBack}>{q?.title ?? "Quiz"}</Crumbs>} />
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div id="quiz-top" className="mx-auto flex w-full max-w-2xl flex-col gap-3 px-4 pt-6 pb-4">
          {quiz.error ? <SurfaceError title="Couldn’t open the quiz" message={cleanMessage(quiz.error)} onRetry={quiz.reload} /> : null}
          {skeleton ? <QuizSkeleton /> : null}
          {q ? (
            <>
              <QuizMeta quiz={q} />
              {error ? (
                <SurfaceError
                  title={error.title}
                  message={error.message}
                  actions={needsModel(error.message) ? [{ label: "Open settings", onClick: () => useNav.getState().openSettings("providers") }] : []}
                  onRetry={() => void (attempt ? reviewMistakes() : submit())}
                />
              ) : null}
              {attempt ? (
                <ScoreCard attempt={attempt} missed={missed.length} busy={!!job} onRetry={retryMistakes} onReview={() => void reviewMistakes()} onAgain={takeAgain} />
              ) : null}
              {job?.kind === "reviewing" ? (
                <div className="relative overflow-hidden rounded-xl border bg-card px-4 pt-3.5 pb-3">
                  <JobBar value={job.fraction} />
                  <JobLine label={progressWords(job.progress ?? { step: "reviewing", done: 0, total: 1 }, { quiz: true })} count={countText(job.progress)} />
                </div>
              ) : null}
              {review ? (
                <div className="rounded-xl border bg-card">
                  <div className="flex items-center gap-2 border-b px-4 py-2.5">
                    <SparklesIcon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    <span className="flex-1 font-medium text-sm">What to work on</span>
                    {review.deckPath ? (
                      <Button size="xs" variant="outline" onClick={() => open({ kind: "review", paths: [review.deckPath!] })}>
                        Study these cards
                      </Button>
                    ) : null}
                  </div>
                  <div className="px-4 py-3">
                    <StudyText text={review.summary || "Nothing stood out."} space={space.id} id={`review-${path}`} />
                  </div>
                </div>
              ) : null}
              {only ? (
                <div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
                  <RotateCcwIcon className="size-3.5" strokeWidth={2} />
                  <span className="flex-1 tabular-nums">Showing the {plural(only.length, "question")} you missed.</span>
                  <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => setOnly(null)}>
                    Show all
                  </button>
                </div>
              ) : null}
              <ol className="flex flex-col gap-3">
                {shown.map((question) => (
                  <QuestionCard
                    key={question.id}
                    space={space.id}
                    number={q.questions.indexOf(question) + 1}
                    question={question}
                    answer={answers[question.id]}
                    result={results.get(question.id)}
                    disabled={!!attempt || job?.kind === "grading"}
                    onAnswer={(a) => setAnswer(question.id, a)}
                  />
                ))}
              </ol>
            </>
          ) : null}
        </div>
        {q && !attempt ? (
          <div className="sticky bottom-0 border-t bg-background/92 backdrop-blur-sm">
            {job?.kind === "grading" ? <JobBar value={job.fraction} /> : null}
            <div className="mx-auto flex h-12 w-full max-w-2xl items-center gap-3 px-4">
              <span className="min-w-0 flex-1 truncate text-muted-foreground text-xs tabular-nums">
                {job?.kind === "grading" ? progressWords(job.progress ?? { step: "grading", done: 0, total: 1 }, { quiz: true }) : `${answered} of ${q.questions.length} answered`}
              </span>
              <Button size="sm" disabled={!!job || answered === 0} onClick={() => void submit()}>
                {job?.kind === "grading" ? <Spinner size="sm" /> : null}
                {job?.kind === "grading" ? "Checking…" : "Check answers"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

function QuizMeta({ quiz }: { quiz: Quiz }) {
  const g = quiz.grounding;
  const parts = [quiz.course, plural(quiz.questions.length, "question"), g?.exam ? `For ${g.exam}${g.scope ? `: ${tidyScope(g.scope)}` : ""}` : null].filter(Boolean);
  return <Truncate className="px-1 text-muted-foreground text-xs tabular-nums">{parts.join(" · ")}</Truncate>;
}

function ScoreCard({ attempt, missed, busy, onRetry, onReview, onAgain }: { attempt: Attempt; missed: number; busy: boolean; onRetry: () => void; onReview: () => void; onAgain: () => void }) {
  const { points, total, ungraded } = attemptPoints(attempt.results);
  const share = total ? points / total : 0;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border bg-card px-4 py-3.5">
      <div className={cn("font-semibold text-2xl tabular-nums tracking-[-0.02em]", share >= 0.8 ? "text-success-foreground" : share < 0.6 ? "text-warning-foreground" : "text-foreground")}>
        {Math.round(share * 100)}%
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm tabular-nums">
          {pointsText(points)} of {total} right
        </div>
        <div className="text-muted-foreground text-xs tabular-nums">
          {[missed ? `${plural(missed, "question")} to go over` : "Every graded question right", ungraded ? `${ungraded} not graded: no model is set up` : null].filter(Boolean).join(" · ")}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {missed ? (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={onReview}>
              Look over mistakes
            </Button>
            <Button size="xs" disabled={busy} onClick={onRetry}>
              <RotateCcwIcon />
              Retry mistakes
            </Button>
          </>
        ) : (
          <Button size="xs" variant="outline" onClick={onAgain}>
            Take again
          </Button>
        )}
      </div>
    </div>
  );
}

const VERDICT: Record<Verdict, { icon: React.ReactNode; label: string; className: string }> = {
  correct: { icon: <CircleCheckIcon />, label: "Right", className: "text-success-foreground" },
  partial: { icon: <CircleDashedIcon />, label: "Partly right", className: "text-warning-foreground" },
  wrong: { icon: <CircleXIcon />, label: "Not right", className: "text-error-foreground" },
  ungraded: { icon: <CircleHelpIcon />, label: "Not graded", className: "text-muted-foreground" },
};

function QuestionCard({
  space,
  number,
  question,
  answer,
  result,
  disabled,
  onAnswer,
}: {
  space: string;
  number: number;
  question: Question;
  answer: Answer | undefined;
  result?: QuestionResult;
  disabled: boolean;
  onAnswer: (a: Answer) => void;
}) {
  const verdict = result ? verdictOf(result) : null;
  const v = verdict ? VERDICT[verdict] : null;
  const choices = choicesOf(question);
  const multi = question.kind === "multi";
  return (
    <li className="overflow-hidden rounded-xl border bg-card">
      <div className="flex gap-3 px-4 pt-3.5 pb-2">
        <span className="w-5 shrink-0 pt-0.5 text-muted-foreground text-xs tabular-nums">{number}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span>{kindLabel(question.kind)}</span>
            {question.topic ? (
              <>
                <span className="text-subtle-foreground">·</span>
                <Truncate className="min-w-0">{question.topic}</Truncate>
              </>
            ) : null}
            {v ? (
              <span className={cn("ml-auto flex shrink-0 items-center gap-1 font-medium [&_svg]:size-3.5", v.className)}>
                {v.icon}
                {verdict === "partial" && result?.partial != null ? `${Math.round(result.partial * 100)}%` : v.label}
              </span>
            ) : null}
          </div>
          <StudyText text={question.prompt} space={space} id={`q-${question.id}`} reveal={!!result && question.kind === "cloze"} />
        </div>
      </div>
      <div className="flex flex-col gap-1 px-4 pb-3.5 pl-12">
        {choices.length && question.kind !== "short" && question.kind !== "cloze" ? (
          choices.map((c, i) => {
            const picked = includesAnswer(answer, c);
            const right = result ? includesAnswer(result.expected, c) : false;
            const wrongPick = result && picked && !right;
            return (
              <button
                key={c}
                type="button"
                disabled={disabled}
                aria-pressed={picked}
                onClick={() => {
                  if (multi) {
                    const list = answerList(answer);
                    onAnswer(picked ? list.filter((x) => x.trim().toLowerCase() !== c.trim().toLowerCase()) : [...list, c]);
                  } else onAnswer(c);
                }}
                className={cn(
                  "flex min-h-8 items-center gap-2.5 rounded-lg border px-2.5 py-1 text-left text-sm transition-colors enabled:hover:bg-accent disabled:cursor-default",
                  picked && !result && "border-primary/50 bg-primary/6",
                  result && right && "border-success/40 bg-success/6",
                  wrongPick && "border-error/40 bg-error/6",
                )}
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center border font-medium text-2xs text-muted-foreground",
                    multi ? "rounded-[5px]" : "rounded-full",
                    picked && !result && "border-primary bg-primary text-primary-foreground",
                    result && right && "border-success bg-success text-white",
                    wrongPick && "border-error bg-error text-white",
                  )}
                >
                  {multi && picked ? <CheckIcon className="size-3" strokeWidth={2.5} /> : choiceLetter(i)}
                </span>
                <StudyText text={choiceLabel(question, c)} space={space} id={`q-${question.id}-${i}`} className="[&_.markdown]:text-sm" />
              </button>
            );
          })
        ) : question.kind === "short" ? (
          <Textarea rows={3} disabled={disabled} placeholder="Your answer" value={typeof answer === "string" ? answer : ""} onChange={(e) => onAnswer(e.target.value)} />
        ) : (
          <Input size="sm" disabled={disabled} placeholder="The missing word or phrase" value={typeof answer === "string" ? answer : ""} onChange={(e) => onAnswer(e.target.value)} />
        )}
      </div>
      {result ? <Feedback space={space} question={question} result={result} /> : null}
    </li>
  );
}

function Feedback({ space, question, result }: { space: string; question: Question; result: QuestionResult }) {
  const typed = question.kind === "short" || question.kind === "cloze";
  const expected = answerList(result.expected).join(", ");
  return (
    <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 pl-12 text-sm">
      {typed && !result.correct && expected ? (
        <div className="flex gap-2 text-xs">
          <span className="shrink-0 text-muted-foreground">{question.kind === "short" ? "A good answer" : "Answer"}</span>
          <StudyText text={expected} space={space} id={`exp-${question.id}`} className="[&_.markdown]:text-xs" />
        </div>
      ) : null}
      <StudyText text={result.feedback || question.explanation} space={space} id={`fb-${question.id}`} className="text-muted-foreground [&_.markdown]:text-sm [&_.markdown]:text-foreground/85" />
      {question.citations?.length ? (
        <div className="-mx-0.5 flex flex-wrap items-center gap-y-1">
          {question.citations.map((c) => (
            <CitationChip key={`${c.source}${c.quote}`} space={space} citation={{ path: c.source, quote: c.quote }} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuizSkeleton() {
  return (
    <div className="flex flex-col gap-3 motion-safe:animate-skeleton" aria-hidden>
      <Skeleton className="mx-1 h-2.5 w-64 animate-none" />
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-xl border px-4 py-4 pl-12">
          <Skeleton className="h-2 w-24 animate-none" />
          <Skeleton className="h-3 w-[72%] animate-none" />
          {[0, 1, 2].map((k) => (
            <Skeleton key={k} className="h-8 w-full animate-none rounded-lg" />
          ))}
        </div>
      ))}
    </div>
  );
}
