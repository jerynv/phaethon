import { ArrowLeft, ArrowRight, ArrowCounterClockwise, CheckCircle, CircleDashed, Flag, Question as QuestionIcon, Sparkle, XCircle } from "@phosphor-icons/react";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { CitationChip } from "@/features/chat/components/CitationChip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { studyQuiz, studyQuizSubmit, studyReviewMistakes } from "../api";
import { useStudyFlow } from "../flow-store";
import { kindLabel } from "../lib/kinds";
import { jobFraction } from "../lib/progress";
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
import { beforeCheck, keyAction, missedIds, reviewList, SURE, type Sure, topicBreakdown, WHY_WORDS } from "../lib/quiz-results";
import { loadQuizSession, saveQuizSession } from "../lib/quiz-session";
import type { Attempt, Question, QuestionResult, Quiz, StudyEvent } from "../lib/types";
import { needsModel, plural, progressWords, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { EASE, Slide } from "./motion";
import { Crumbs, JobBar, StudyText } from "./parts";

type Job = { kind: "grading" | "reviewing"; progress: MakeProgress | null; fraction: number };
type Stage = "take" | "check" | "results";

/**
 * Taking a quiz, one question at a time: progress along the top (a segment
 * per question, flags marked), keys for everything (1–9 answer, Enter next,
 * ← back, F flag, G/U/S how sure), a check of what's unanswered or flagged
 * before grading, then the results: the score, the score per topic, what to
 * go over (sure-but-wrong first) with the passages each answer comes from,
 * and a retake of the misses.
 */
export function QuizScreen({ space, path, onBack, open }: { space: SpaceView; path: string; onBack: () => void; open: (s: StudyScreen) => void }) {
  const quiz = useLoad(() => studyQuiz(space.id, path), [space.id, path]);
  const skeleton = useDelayed(quiz.loading && !quiz.data);
  const q = quiz.data;
  const [answers, setAnswers] = useState<Answers>({});
  const [flagged, setFlagged] = useState<string[]>([]);
  const [sure, setSure] = useState<Record<string, Sure>>({});
  const [at, setAt] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [only, setOnly] = useState<string[] | null>(null);
  const [stage, setStage] = useState<Stage>("take");
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<{ title: string; message: string } | null>(null);
  const [review, setReview] = useState<{ summary: string; deckPath?: string } | null>(null);
  const run = useRef(0);
  const pick = useStudyFlow((s) => s.pick);

  useEffect(() => {
    if (!q) return;
    const ids = q.questions.map((x) => x.id);
    setAnswers(loadDraft(space.id, path, q.created, ids));
    const s = loadQuizSession(space.id, path, q.created, ids);
    setFlagged(s.flagged);
    setSure(s.sure ?? {});
    setAt(s.at);
  }, [q, space.id, path]);

  const shown = useMemo(() => (q ? (only ? q.questions.filter((x) => only.includes(x.id)) : q.questions) : []), [q, only]);
  const current = shown[Math.min(at, Math.max(0, shown.length - 1))];
  const answered = shown.filter((x) => isAnswered(answers[x.id])).length;

  const keep = useCallback(
    (next: { answers?: Answers; flagged?: string[]; sure?: Record<string, Sure>; at?: number }) => {
      if (!q) return;
      if (next.answers) saveDraft(space.id, path, q.created, next.answers);
      saveQuizSession(space.id, path, q.created, { layout: "single", flagged: next.flagged ?? flagged, at: next.at ?? at, sure: next.sure ?? sure });
    },
    [q, space.id, path, flagged, at, sure],
  );

  const setAnswer = (id: string, a: Answer) =>
    setAnswers((cur) => {
      const next = { ...cur, [id]: a };
      keep({ answers: next });
      return next;
    });
  const toggleFlag = (id: string) =>
    setFlagged((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      keep({ flagged: next });
      return next;
    });
  const setSureOf = (id: string, s: Sure) =>
    setSure((cur) => {
      const next = { ...cur };
      if (next[id] === s) delete next[id];
      else next[id] = s;
      keep({ sure: next });
      return next;
    });
  const goTo = (i: number) => {
    if (i < 0 || i >= shown.length) return;
    setDir(i >= at ? 1 : -1);
    setAt(i);
    keep({ at: i });
  };
  const next = () => (at + 1 < shown.length ? goTo(at + 1) : setStage("check"));

  const submit = async () => {
    if (!q) return;
    const id = ++run.current;
    setJob({ kind: "grading", progress: null, fraction: 0 });
    setError(null);
    let failed: string | null = null;
    let got: Attempt | null = null;
    const end = await studyQuizSubmit(
      space.id,
      path,
      answers,
      (e: StudyEvent) => {
        if (run.current !== id) return;
        if (e.type === "progress") setJob((j) => j && { ...j, progress: e, fraction: jobFraction(e, "single", j.fraction) });
        else if (e.type === "error") failed = e.message;
        else if (e.type === "done" && e.attempt) got = e.attempt;
      },
      pick,
    );
    if (run.current !== id) return;
    setJob(null);
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (!got && !failed) failed = "Phaethon’s core stopped answering before it finished grading.";
    if (failed) return setError({ title: "Couldn’t check your answers", message: failed });
    setAttempt(got);
    setReview(null);
    setStage("results");
    clearDraft(space.id, path);
  };

  const reviewMistakes = async () => {
    if (!attempt) return;
    const id = ++run.current;
    setJob({ kind: "reviewing", progress: null, fraction: 0 });
    setError(null);
    let failed: string | null = null;
    let got: { summary: string; deckPath?: string } | null = null;
    const end = await studyReviewMistakes(
      space.id,
      attempt.path,
      (e) => {
        if (run.current !== id) return;
        if (e.type === "progress") setJob((j) => j && { ...j, progress: e, fraction: jobFraction(e, "single", j.fraction) });
        else if (e.type === "error") failed = e.message;
        else if (e.type === "done") got = { summary: e.summary ?? "", deckPath: e.deckPath };
      },
      pick,
    );
    if (run.current !== id) return;
    setJob(null);
    if (end.kind === "rejected") failed = cleanMessage(end.error);
    if (failed) return setError({ title: "Couldn’t look over your mistakes", message: failed });
    setReview(got);
  };

  /** Start over on `ids` (the misses, or everything): their answers cleared, the rest kept as given. */
  const retake = (ids: string[] | null) => {
    if (!q) return;
    const nextAnswers: Answers = {};
    if (ids && attempt) for (const r of attempt.results) if (!ids.includes(r.id)) nextAnswers[r.id] = typeof r.given === "boolean" ? String(r.given) : r.given;
    setAnswers(nextAnswers);
    setFlagged([]);
    setSure({});
    setOnly(ids);
    setAt(0);
    setDir(1);
    setAttempt(null);
    setReview(null);
    setStage("take");
    saveDraft(space.id, path, q.created, nextAnswers);
    saveQuizSession(space.id, path, q.created, { layout: "single", flagged: [], at: 0, sure: {} });
  };

  // Keys, when focus isn't in a text field.
  useEffect(() => {
    if (stage !== "take" || !current || job) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      const mod = e.metaKey || e.ctrlKey;
      // In a text field only Enter moves on (⌘/Ctrl+Enter in a long answer); elsewhere modified keys are the app's.
      if (typing && (e.key !== "Enter" || (t?.tagName === "TEXTAREA" && !mod))) return;
      if (!typing && mod) return;
      // Buttons and links answer Enter themselves.
      if (!typing && e.key === "Enter" && t && /^(BUTTON|A)$/.test(t.tagName) && !t.dataset.choice) return;
      if (document.querySelector("[data-slot=dialog-popup],[role=menu]")) return;
      const a = keyAction(e.key, current, answers[current.id]);
      if (!a) return;
      e.preventDefault();
      if (a.kind === "answer") setAnswer(current.id, a.answer);
      else if (a.kind === "next") next();
      else if (a.kind === "prev") goTo(at - 1);
      else if (a.kind === "flag") toggleFlag(current.id);
      else if (a.kind === "sure") setSureOf(current.id, a.sure);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const total = shown.length;

  return (
    <>
      <Header
        title={<Crumbs onBack={onBack}>{q?.title ?? "Quiz"}</Crumbs>}
        actions={
          q && stage === "take" && current ? (
            <span className="text-muted-foreground text-xs tabular-nums" data-testid="quiz-position">
              {only ? "Retaking · " : ""}
              {at + 1} of {total}
            </span>
          ) : null
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        {q && stage !== "results" ? <Rail questions={shown} at={at} answers={answers} flagged={flagged} onGo={(i) => (setStage("take"), goTo(i))} /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-6 pb-8">
            {quiz.error ? <SurfaceError title="Couldn’t open the quiz" message={cleanMessage(quiz.error)} onRetry={quiz.reload} /> : null}
            {skeleton ? <QuizSkeleton /> : null}
            {error ? (
              <SurfaceError
                title={error.title}
                message={error.message}
                actions={needsModel(error.message) ? [{ label: "Open settings", onClick: () => useNav.getState().openSettings("providers") }] : []}
                onRetry={() => void (stage === "results" ? reviewMistakes() : submit())}
              />
            ) : null}
            {q && stage === "take" && current ? (
              <Slide id={current.id} dir={dir}>
                <QuestionView
                  space={space.id}
                  number={q.questions.indexOf(current) + 1}
                  total={q.questions.length}
                  question={current}
                  answer={answers[current.id]}
                  sure={sure[current.id]}
                  flagged={flagged.includes(current.id)}
                  onAnswer={(a) => setAnswer(current.id, a)}
                  onSure={(s) => setSureOf(current.id, s)}
                  onFlag={() => toggleFlag(current.id)}
                />
              </Slide>
            ) : null}
            {q && stage === "check" ? (
              <CheckSheet questions={shown} answers={answers} flagged={flagged} job={job} onGo={(i) => (setStage("take"), goTo(i))} onSubmit={() => void submit()} />
            ) : null}
            {q && stage === "results" && attempt ? (
              <Results
                space={space.id}
                quiz={q}
                attempt={attempt}
                sure={sure}
                job={job}
                review={review}
                onRetake={retake}
                onReview={() => void reviewMistakes()}
                onStudyCards={(deck) => open({ kind: "review", paths: [deck] })}
              />
            ) : null}
          </div>
        </div>
        {q && stage === "take" && current ? (
          <div className="border-t bg-background">
            <div className="mx-auto flex h-12 w-full max-w-2xl items-center gap-2 px-4">
              <Button size="sm" variant="ghost" disabled={at === 0} onClick={() => goTo(at - 1)} aria-label="Previous question">
                <ArrowLeft />
                <span className="max-sm:hidden">Back</span>
              </Button>
              <span className="min-w-0 flex-1 truncate text-center text-muted-foreground text-xs tabular-nums">
                {answered} of {total} answered
                <span className="max-md:hidden">
                  {" · "}
                  <Kbd>1</Kbd>–<Kbd>{Math.min(9, Math.max(2, choicesOf(current).length))}</Kbd> answer · <Kbd>↵</Kbd> next · <Kbd>F</Kbd> flag
                </span>
              </span>
              {at + 1 < total ? (
                <Button size="sm" variant={isAnswered(answers[current.id]) ? "default" : "outline"} onClick={next}>
                  Next
                  <ArrowRight />
                </Button>
              ) : (
                <Button size="sm" onClick={() => setStage("check")}>
                  Finish
                  <CheckCircle weight="bold" />
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** One segment per question: answered, current, flagged; click to go there. */
function Rail({ questions, at, answers, flagged, onGo }: { questions: Question[]; at: number; answers: Answers; flagged: string[]; onGo: (i: number) => void }) {
  return (
    <nav className="flex shrink-0 gap-0.5 px-4 pt-2" aria-label="Questions">
      {questions.map((x, i) => {
        const done = isAnswered(answers[x.id]);
        const flag = flagged.includes(x.id);
        return (
          <Tooltip key={x.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => onGo(i)}
                  aria-label={`Question ${i + 1}${done ? ", answered" : ""}${flag ? ", flagged" : ""}`}
                  aria-current={i === at ? "step" : undefined}
                  className="group relative flex h-4 min-w-1 flex-1 items-center"
                />
              }
            >
              <span
                className={cn(
                  "h-1 w-full rounded-full bg-muted transition-colors duration-200 group-hover:bg-muted-foreground/30",
                  done && "bg-primary/45 group-hover:bg-primary/60",
                  i === at && "bg-primary group-hover:bg-primary",
                )}
              />
              {flag ? <span className="-top-0.5 absolute right-0 size-1.5 rounded-full bg-warning" /> : null}
            </TooltipTrigger>
            <TooltipPopup>
              {`Question ${i + 1}`}
              {flag ? " · flagged" : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </nav>
  );
}

function QuestionView({
  space,
  number,
  total,
  question,
  answer,
  sure,
  flagged,
  onAnswer,
  onSure,
  onFlag,
}: {
  space: string;
  number: number;
  total: number;
  question: Question;
  answer: Answer | undefined;
  sure?: Sure;
  flagged: boolean;
  onAnswer: (a: Answer) => void;
  onSure: (s: Sure) => void;
  onFlag: () => void;
}) {
  const choices = choicesOf(question);
  const multi = question.kind === "multi";
  const typed = question.kind === "short" || question.kind === "cloze";
  const has = isAnswered(answer);
  return (
    <article className="flex flex-col gap-5" data-testid="quiz-question">
      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="tabular-nums">
          Question {number} <span className="text-subtle-foreground">/ {total}</span>
        </span>
        <span className="text-subtle-foreground">·</span>
        <span>{kindLabel(question.kind)}</span>
        {question.topic ? (
          <>
            <span className="text-subtle-foreground">·</span>
            <Truncate className="min-w-0">{question.topic}</Truncate>
          </>
        ) : null}
        <Button size="xs" variant={flagged ? "outline" : "ghost-muted"} className={cn("ml-auto", flagged && "border-warning/40 text-warning-foreground")} aria-pressed={flagged} onClick={onFlag}>
          <Flag weight={flagged ? "fill" : "light"} />
          {flagged ? "Flagged" : "Flag"}
        </Button>
      </div>

      <StudyText text={question.prompt} space={space} id={`q-${question.id}`} className="[&_.markdown]:text-base [&_.markdown]:leading-relaxed" />

      {!typed ? (
        <div className="flex flex-col gap-1.5" role={multi ? "group" : "radiogroup"} aria-label="Choices">
          {multi ? <p className="text-muted-foreground text-xs">Choose all that apply.</p> : null}
          {choices.map((c, i) => {
            const picked = includesAnswer(answer, c);
            return (
              <motion.button
                key={c}
                type="button"
                role={multi ? "checkbox" : "radio"}
                aria-checked={picked}
                data-choice=""
                whileTap={{ scale: 0.995 }}
                onClick={() => {
                  if (multi) {
                    const list = answerList(answer);
                    onAnswer(picked ? list.filter((x) => x.trim().toLowerCase() !== c.trim().toLowerCase()) : [...list, c]);
                  } else onAnswer(c);
                }}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-lg border bg-card px-3 py-2 text-left transition-colors duration-150 hover:border-input hover:bg-accent/60",
                  picked && "border-primary/60 bg-primary/6 hover:border-primary/60 hover:bg-primary/8",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center border font-medium text-muted-foreground text-xs tabular-nums transition-colors",
                    multi ? "rounded-md" : "rounded-full",
                    picked && "border-primary bg-primary text-primary-foreground",
                  )}
                >
                  {multi && picked ? <CheckCircle weight="bold" className="size-3.5" /> : i < 9 ? i + 1 : choiceLetter(i)}
                </span>
                <StudyText text={choiceLabel(question, c)} space={space} id={`q-${question.id}-${i}`} className="flex-1 [&_.markdown]:text-sm" />
              </motion.button>
            );
          })}
        </div>
      ) : question.kind === "short" ? (
        <Textarea rows={4} aria-label="Your answer" placeholder="Your answer (⌘↵ for next)" value={typeof answer === "string" ? answer : ""} onChange={(e) => onAnswer(e.target.value)} />
      ) : (
        <Input aria-label="Your answer" placeholder="The missing word or phrase, then ↵" value={typeof answer === "string" ? answer : ""} onChange={(e) => onAnswer(e.target.value)} />
      )}

      <AnimatePresence initial={false}>
        {has ? (
          <motion.div
            key="sure"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.16, ease: EASE }}
            className="flex items-center gap-2 text-muted-foreground text-xs"
            role="group"
            aria-label="How sure are you?"
          >
            <span>How sure?</span>
            {SURE.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={sure === s.value}
                onClick={() => onSure(s.value)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-full border px-2 transition-colors hover:bg-accent hover:text-foreground",
                  sure === s.value && "border-primary/40 bg-primary/8 text-foreground",
                )}
              >
                {s.label}
                <Kbd className="max-md:hidden">{s.key.toUpperCase()}</Kbd>
              </button>
            ))}
            <span className="text-subtle-foreground max-sm:hidden">Optional</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </article>
  );
}

/** Before grading: what's unanswered and flagged, each a way back to it. */
function CheckSheet({ questions, answers, flagged, job, onGo, onSubmit }: { questions: Question[]; answers: Answers; flagged: string[]; job: Job | null; onGo: (i: number) => void; onSubmit: () => void }) {
  const c = beforeCheck(
    questions.map((x) => x.id),
    answers,
    flagged,
  );
  const grading = job?.kind === "grading";
  const list = (idx: number[]) => (
    <div className="flex flex-wrap gap-1">
      {idx.map((i) => (
        <Button key={i} size="xs" variant="outline" className="min-w-8 tabular-nums" onClick={() => onGo(i)}>
          {i + 1}
        </Button>
      ))}
    </div>
  );
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }} className="relative overflow-hidden rounded-xl border bg-card" data-testid="quiz-check">
      {grading ? <JobBar value={job.fraction} /> : null}
      <div className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="font-semibold text-lg tracking-tight">{grading ? "Checking your answers…" : "Ready to check?"}</h2>
          <p className="mt-0.5 text-muted-foreground text-sm tabular-nums">
            {grading
              ? progressWords(job.progress ?? { step: "grading", done: 0, total: 1 }, { quiz: true })
              : `${questions.length - c.unanswered.length} of ${questions.length} answered.${c.unanswered.length ? " Unanswered ones count as wrong." : ""}`}
          </p>
        </div>
        {!grading && c.unanswered.length ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-xs">Not answered</p>
            {list(c.unanswered)}
          </div>
        ) : null}
        {!grading && c.flagged.length ? (
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1 text-muted-foreground text-xs">
              <Flag weight="fill" className="size-3 text-warning" />
              Flagged for review
            </p>
            {list(c.flagged)}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" disabled={grading} onClick={() => onGo(c.unanswered[0] ?? c.flagged[0] ?? 0)}>
            Keep going
          </Button>
          <Button size="sm" disabled={grading} onClick={onSubmit}>
            {grading ? <Spinner size="sm" /> : null}
            {grading ? "Checking…" : "Check answers"}
          </Button>
        </div>
      </div>
    </motion.section>
  );
}

// ---- Results ----

const VERDICT: Record<Verdict, { icon: ReactNode; label: string; className: string }> = {
  correct: { icon: <CheckCircle weight="fill" />, label: "Right", className: "text-success-foreground" },
  partial: { icon: <CircleDashed weight="bold" />, label: "Partly right", className: "text-warning-foreground" },
  wrong: { icon: <XCircle weight="fill" />, label: "Not right", className: "text-error-foreground" },
  ungraded: { icon: <QuestionIcon weight="light" />, label: "Not graded", className: "text-muted-foreground" },
};

function Results({
  space,
  quiz,
  attempt,
  sure,
  job,
  review,
  onRetake,
  onReview,
  onStudyCards,
}: {
  space: string;
  quiz: Quiz;
  attempt: Attempt;
  sure: Record<string, Sure>;
  job: Job | null;
  review: { summary: string; deckPath?: string } | null;
  onRetake: (ids: string[] | null) => void;
  onReview: () => void;
  onStudyCards: (deck: string) => void;
}) {
  const { points, total, ungraded } = attemptPoints(attempt.results);
  const share = total ? points / total : 0;
  const missed = missedIds(attempt.results);
  const topics = topicBreakdown(quiz.questions, attempt.results);
  const items = reviewList(quiz.questions, attempt.results, sure);
  const byId = new Map(attempt.results.map((r) => [r.id, r]));
  const g = quiz.grounding;
  return (
    <div className="flex flex-col gap-4" data-testid="quiz-results">
      <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }} className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
          <div>
            <CountUp value={Math.round(share * 100)} className={cn("font-semibold text-2xl tabular-nums tracking-tight", share >= 0.8 ? "text-success-foreground" : share < 0.6 ? "text-warning-foreground" : "text-foreground")} />
            <p className="text-muted-foreground text-sm tabular-nums">
              {pointsText(points)} of {total} right{ungraded ? ` · ${ungraded} not graded` : ""}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            {missed.length ? (
              <>
                <Button size="sm" variant="outline" disabled={!!job} onClick={onReview}>
                  {job?.kind === "reviewing" ? <Spinner size="sm" /> : <Sparkle weight="light" />}
                  {job?.kind === "reviewing" ? "Looking over…" : "Explain my mistakes"}
                </Button>
                <Button size="sm" onClick={() => onRetake(missed)}>
                  <ArrowCounterClockwise weight="bold" />
                  Retake {plural(missed.length, "miss", "misses")}
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => onRetake(null)}>
                <ArrowCounterClockwise weight="bold" />
                Take again
              </Button>
            )}
          </div>
        </div>
        <ScoreBar results={attempt.results} />
        {g?.exam ? <p className="mt-3 text-muted-foreground text-xs [overflow-wrap:anywhere]">For {g.exam}{g.scope ? `: ${tidyScope(g.scope)}` : ""}</p> : null}
      </motion.section>

      {review ? (
        <section className="rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-4 py-2.5">
            <Sparkle weight="light" className="size-4 text-muted-foreground" />
            <span className="flex-1 font-medium text-sm">What to work on</span>
            {review.deckPath ? (
              <Button size="xs" variant="outline" onClick={() => onStudyCards(review.deckPath!)}>
                Study these cards
              </Button>
            ) : null}
          </div>
          <div className="px-4 py-3">
            <StudyText text={review.summary || "Nothing stood out."} space={space} id={`review-${attempt.path}`} />
          </div>
        </section>
      ) : null}

      {topics.length > 1 || (topics.length === 1 && topics[0]!.topic !== "Other") ? (
        <section className="flex flex-col gap-1.5" data-testid="quiz-topics">
          <h3 className="px-1 font-medium text-muted-foreground text-xs">By topic</h3>
          <div className="flex flex-col rounded-xl border bg-card py-1">
            {topics.map((t, i) => (
              <div key={t.topic} className="flex h-9 items-center gap-3 px-4">
                <Truncate className="min-w-0 flex-1 text-sm">{t.topic}</Truncate>
                <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                  {pointsText(t.points)}/{t.graded}
                </span>
                <span className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
                  <motion.span
                    className={cn("absolute inset-y-0 left-0 rounded-full", (t.percent ?? 0) >= 80 ? "bg-success" : (t.percent ?? 0) < 60 ? "bg-warning" : "bg-primary")}
                    initial={{ width: 0 }}
                    animate={{ width: `${t.percent ?? 0}%` }}
                    transition={{ duration: 0.5, delay: 0.05 * i, ease: EASE }}
                  />
                </span>
                <span className="w-10 shrink-0 text-right text-sm tabular-nums">{t.percent == null ? "–" : `${Math.round(t.percent)}%`}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {items.length ? (
        <section className="flex flex-col gap-1.5" data-testid="quiz-review">
          <h3 className="px-1 font-medium text-muted-foreground text-xs">What to go over</h3>
          <div className="flex flex-col gap-2">
            {items.map((it) => {
              const question = quiz.questions.find((x) => x.id === it.id)!;
              return <ReviewCard key={it.id} space={space} number={it.index + 1} question={question} result={byId.get(it.id)!} why={WHY_WORDS[it.why]} defaultOpen={it.why === "confident-miss" || it.why === "miss"} />;
            })}
          </div>
        </section>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger className="px-1 text-muted-foreground text-xs hover:text-foreground">All {plural(quiz.questions.length, "answer")}</CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-2 pt-2">
            {quiz.questions.map((x, i) => (byId.get(x.id) ? <ReviewCard key={x.id} space={space} number={i + 1} question={x} result={byId.get(x.id)!} /> : null))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

/** One segment per question, coloured by how it went. */
function ScoreBar({ results }: { results: QuestionResult[] }) {
  return (
    <div className="mt-4 flex gap-0.5" aria-hidden>
      {results.map((r, i) => {
        const v = verdictOf(r);
        return (
          <motion.span
            key={r.id}
            initial={{ opacity: 0, scaleY: 0.4 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{ duration: 0.2, delay: 0.02 * i, ease: EASE }}
            className={cn("h-1.5 flex-1 rounded-full", v === "correct" ? "bg-success" : v === "partial" ? "bg-warning" : v === "wrong" ? "bg-error/70" : "bg-muted")}
          />
        );
      })}
    </div>
  );
}

function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) {
      el.textContent = `${value}%`;
      return;
    }
    const c = animate(0, value, { duration: 0.6, ease: EASE, onUpdate: (v) => (el.textContent = `${Math.round(v)}%`) });
    return () => c.stop();
  }, [value, reduce]);
  return (
    <span ref={ref} className={className} data-testid="quiz-score">
      {value}%
    </span>
  );
}

function ReviewCard({ space, number, question, result, why, defaultOpen = false }: { space: string; number: number; question: Question; result: QuestionResult; why?: string; defaultOpen?: boolean }) {
  const verdict = verdictOf(result);
  const v = VERDICT[verdict];
  const typed = question.kind === "short" || question.kind === "cloze";
  const given = answerList(result.given).map((a) => choiceLabel(question, a)).join(", ");
  const expected = answerList(result.expected).map((a) => choiceLabel(question, a)).join(", ");
  return (
    <Collapsible defaultOpen={defaultOpen} className="rounded-xl border bg-card">
      <CollapsibleTrigger className="flex w-full items-start gap-3 px-4 py-3 text-left">
        <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", v.className)}>{v.icon}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5 text-muted-foreground text-xs">
            <span className="tabular-nums">{number}</span>
            <span className="text-subtle-foreground">·</span>
            <span className={v.className}>{verdict === "partial" && result.partial != null ? `${Math.round(result.partial * 100)}%` : (why ?? v.label)}</span>
            {question.topic ? (
              <>
                <span className="text-subtle-foreground">·</span>
                <Truncate className="min-w-0">{question.topic}</Truncate>
              </>
            ) : null}
          </div>
          <StudyText text={question.prompt} space={space} id={`r-${question.id}`} reveal={question.kind === "cloze"} className="[&_.markdown]:text-sm" />
        </div>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-2.5 border-t px-4 py-3 pl-11 text-sm">
          {!result.correct ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted-foreground">You said</dt>
              <dd className="min-w-0">{given ? <StudyText text={given} space={space} id={`g-${question.id}`} className="[&_.markdown]:text-xs" /> : <span className="text-muted-foreground">Nothing</span>}</dd>
              {expected ? (
                <>
                  <dt className="text-muted-foreground">{typed && question.kind === "short" ? "A good answer" : "Answer"}</dt>
                  <dd className="min-w-0">
                    <StudyText text={expected} space={space} id={`e-${question.id}`} className="[&_.markdown]:text-xs" />
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
          <StudyText text={result.feedback || question.explanation} space={space} id={`fb-${question.id}`} className="text-muted-foreground [&_.markdown]:text-sm [&_.markdown]:text-foreground/85" />
          {question.citations?.length ? (
            <div className="-mx-0.5 flex flex-wrap items-center gap-y-1">
              <span className="px-0.5 text-muted-foreground text-xs">Read again</span>
              {question.citations.map((c) => (
                <CitationChip key={`${c.source}${c.quote}`} space={space} citation={{ path: c.source, quote: c.quote }} />
              ))}
            </div>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function QuizSkeleton() {
  return (
    <div className="flex flex-col gap-5 motion-safe:animate-skeleton" aria-hidden>
      <Skeleton className="h-2.5 w-48 animate-none" />
      <Skeleton className="h-4 w-4/5 animate-none" />
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-11 w-full animate-none rounded-lg" />
        ))}
      </div>
    </div>
  );
}
