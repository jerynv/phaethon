import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";
import { AnimatePresence, animate, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { useNav } from "@/app/store";
import { ArtCanvas } from "@/components/art";
import { cleanMessage, SurfaceError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardMedia, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
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
import { needsModel, plural, type MakeProgress } from "../lib/words";
import type { StudyScreen } from "../StudyView";
import { useLoad } from "../use-load";
import { EASE, Slide } from "./motion";
import { Crumbs, Disc, JobBar, Page, StudyText } from "./parts";

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
      if (!typing && e.key === "Enter" && t && /^(BUTTON|A)$/.test(t.tagName) && !t.hasAttribute("data-choice")) return;
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
          q && stage === "results" ? (
            <Button size="sm" variant="outline" onClick={onBack}>
              Back to study
            </Button>
          ) : null
        }
      />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <Page narrow className="gap-8">
          {quiz.error ? <SurfaceError title="Couldn’t open the quiz" message={cleanMessage(quiz.error)} onRetry={quiz.reload} /> : null}
          {skeleton ? <QuizSkeleton /> : null}
          {q && stage !== "results" ? (
            <div className="flex flex-col gap-3">
              <div className="flex h-8 items-center gap-3">
                <span className="text-muted-foreground text-sm">
                  Question{" "}
                  <span className="text-foreground tabular-nums" data-testid="quiz-position">
                    {stage === "take" && current ? `${at + 1} of ${total}` : `${total} of ${total}`}
                  </span>
                </span>
                {only ? <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-medium text-primary text-xs">Retaking misses</span> : null}
                <span className="ml-auto text-muted-foreground text-sm tabular-nums">{answered} answered</span>
                <Button size="icon-sm" variant="ghost-muted" aria-label="Close quiz" className="-mr-1.5" onClick={onBack}>
                  <Icon icon={icons.close} />
                </Button>
              </div>
              <Rail questions={shown} at={at} answers={answers} flagged={flagged} onGo={(i) => (setStage("take"), goTo(i))} />
            </div>
          ) : null}
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
              path={path}
              attempt={attempt}
              sure={sure}
              job={job}
              review={review}
              onRetake={retake}
              onReview={() => void reviewMistakes()}
              onDone={onBack}
              onStudyCards={(deck) => open({ kind: "review", paths: [deck] })}
            />
          ) : null}
        </Page>
        {q && stage === "take" && current ? (
          <div className="border-t bg-background">
            <div className="mx-auto flex h-14 w-full max-w-(--chat-max-width) items-center gap-3 px-6">
              <Button variant="ghost" disabled={at === 0} onClick={() => goTo(at - 1)} aria-label="Previous question">
                <Icon icon={icons.arrowLeft} />
                <span className="max-sm:hidden">Back</span>
              </Button>
              <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 truncate text-muted-foreground text-xs max-md:hidden">
                <Kbd variant="keycap">1</Kbd>–<Kbd variant="keycap">{Math.min(9, Math.max(2, choicesOf(current).length))}</Kbd>
                <span className="mr-2">answer</span>
                <Kbd variant="keycap">Enter</Kbd>
                <span className="mr-2">next</span>
                <Kbd variant="keycap">F</Kbd>
                <span>flag</span>
              </span>
              <span className="flex-1 md:hidden" />
              {at + 1 < total ? (
                <Button variant={isAnswered(answers[current.id]) ? "default" : "outline"} onClick={next}>
                  Next
                  <Icon icon={icons.arrowRight} />
                </Button>
              ) : (
                <Button onClick={() => setStage("check")}>
                  Finish
                  <Icon icon={icons.check} />
                </Button>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** A thin ink bar in one segment per question: answered, current, flagged; click to go there. */
function Rail({ questions, at, answers, flagged, onGo }: { questions: Question[]; at: number; answers: Answers; flagged: string[]; onGo: (i: number) => void }) {
  return (
    <nav className="flex shrink-0 gap-1" aria-label="Questions">
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
                  className="group relative flex h-3 min-w-1 flex-1 items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <span
                className={cn(
                  "h-1 w-full rounded-full bg-muted transition-colors duration-200 group-hover:bg-foreground/15",
                  done && "bg-foreground/35 group-hover:bg-foreground/45",
                  i === at && "bg-ink group-hover:bg-ink",
                )}
              />
              {flag ? <span className="absolute -top-0.5 right-0 size-1.5 rounded-full bg-warning ring-2 ring-background" /> : null}
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
  question,
  answer,
  sure,
  flagged,
  onAnswer,
  onSure,
  onFlag,
}: {
  space: string;
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
    <article className="flex flex-col gap-6" data-testid="quiz-question">
      <div className="flex flex-col gap-3">
        <div className="flex h-7 items-center gap-2 text-muted-foreground text-sm">
          <span>{kindLabel(question.kind)}</span>
          {question.topic ? (
            <>
              <span className="text-subtle-foreground">·</span>
              <Truncate className="min-w-0">{question.topic}</Truncate>
            </>
          ) : null}
          <Button
            size="xs"
            variant={flagged ? "outline" : "ghost-muted"}
            shape="pill"
            className={cn("ml-auto", flagged && "border-warning/40 bg-warning/8 text-warning-foreground")}
            aria-pressed={flagged}
            onClick={onFlag}
          >
            <Icon icon={icons.flag} className={cn(flagged && "text-warning-foreground")} />
            {flagged ? "Flagged" : "Flag"}
          </Button>
        </div>
        <StudyText text={question.prompt} space={space} id={`q-${question.id}`} className="text-foreground [&_.markdown]:text-xl [&_.markdown]:tracking-title" />
      </div>

      {!typed ? (
        <ChoiceList multi={multi} choices={choices} answer={answer} onAnswer={onAnswer} render={(c, i) => <StudyText text={choiceLabel(question, c)} space={space} id={`q-${question.id}-${i}`} className="flex-1 [&_.markdown]:text-base" />} />
      ) : question.kind === "short" ? (
        <Textarea rows={4} aria-label="Your answer" placeholder="Your answer (⌘↵ for next)" className="text-base" value={typeof answer === "string" ? answer : ""} onChange={(e) => onAnswer(e.target.value)} />
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
            className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm"
            role="group"
            aria-label="How sure are you?"
          >
            <span className="mr-1">How sure?</span>
            {SURE.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={sure === s.value}
                onClick={() => onSure(s.value)}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-full border bg-card pr-1.5 pl-3 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  sure === s.value && "border-primary/50 bg-primary/8 hover:bg-primary/10",
                )}
              >
                {s.label}
                <Kbd variant="keycap" className="h-5 min-w-5 max-md:hidden">
                  {s.key.toUpperCase()}
                </Kbd>
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
    <div className="flex flex-wrap gap-1.5">
      {idx.map((i) => (
        <Button key={i} size="xs" variant="outline" className="min-w-8 tabular-nums" onClick={() => onGo(i)}>
          {i + 1}
        </Button>
      ))}
    </div>
  );
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }}>
      <Card data-testid="quiz-check">
        {grading ? <JobBar value={job.fraction} /> : null}
        <CardHeader className="gap-1 p-6 pb-4">
          <CardTitle className="text-lg">{grading ? "Checking your answers…" : "Ready to check?"}</CardTitle>
          <CardDescription className="tabular-nums">
            {grading
              ? gradingWords(job.progress, questions.length - c.unanswered.length)
              : `${questions.length - c.unanswered.length} of ${questions.length} answered.${c.unanswered.length ? " Unanswered ones count as wrong." : ""}`}
          </CardDescription>
        </CardHeader>
        {!grading && (c.unanswered.length || c.flagged.length) ? (
          <CardContent className="gap-3 px-6 pb-6">
            {c.unanswered.length ? (
              <Card variant="well" className="gap-2 p-4">
                <p className="text-muted-foreground text-sm">Not answered</p>
                {list(c.unanswered)}
              </Card>
            ) : null}
            {c.flagged.length ? (
              <Card variant="well" className="gap-2 p-4">
                <p className="flex items-center gap-1.5 text-muted-foreground text-sm">
                  <Icon icon={icons.flag} className="size-3.5 text-warning-foreground" />
                  Flagged for review
                </p>
                {list(c.flagged)}
              </Card>
            ) : null}
          </CardContent>
        ) : null}
        <CardFooter className="px-6">
          <Button variant="outline" disabled={grading} onClick={() => onGo(c.unanswered[0] ?? c.flagged[0] ?? 0)}>
            Keep going
          </Button>
          <Button disabled={grading} onClick={onSubmit}>
            {grading ? "Checking…" : "Check answers"}
          </Button>
        </CardFooter>
      </Card>
    </motion.div>
  );
}

/** The line under "Checking your answers…": how far it has got, never the title again. */
function gradingWords(p: MakeProgress | null, answered: number): string {
  if (p && p.total > 1) return `${Math.min(p.done, p.total)} of ${p.total} checked`;
  return `${plural(answered, "answer")}, each checked against your materials`;
}

// ---- Results ----

/** Each verdict as a small tinted chip (7274's "Pending"), so a list of misses stays calm. */
const VERDICT: Record<Verdict, { label: string; chip: string }> = {
  correct: { label: "Right", chip: "bg-primary/10 text-primary" },
  partial: { label: "Partly right", chip: "bg-warning/12 text-warning-foreground" },
  wrong: { label: "Not right", chip: "bg-destructive/8 text-destructive-foreground" },
  ungraded: { label: "Not graded", chip: "bg-muted text-muted-foreground" },
};

/** One calm line for the score, not a grade. */
function headline(share: number): string {
  if (share >= 0.9) return "You know this well";
  if (share >= 0.75) return "Nearly there";
  if (share >= 0.5) return "Good progress";
  return "Worth another pass";
}

function Results({
  space,
  quiz,
  path,
  attempt,
  sure,
  job,
  review,
  onRetake,
  onReview,
  onDone,
  onStudyCards,
}: {
  space: string;
  quiz: Quiz;
  path: string;
  attempt: Attempt;
  sure: Record<string, Sure>;
  job: Job | null;
  review: { summary: string; deckPath?: string } | null;
  onRetake: (ids: string[] | null) => void;
  onReview: () => void;
  onDone: () => void;
  onStudyCards: (deck: string) => void;
}) {
  const { points, total, ungraded } = attemptPoints(attempt.results);
  const share = total ? points / total : 0;
  const missed = missedIds(attempt.results);
  const topics = topicBreakdown(quiz.questions, attempt.results);
  const items = reviewList(quiz.questions, attempt.results, sure);
  const byId = new Map(attempt.results.map((r) => [r.id, r]));
  const g = quiz.grounding;
  const counts = attempt.results.reduce<Record<Verdict, number>>((n, r) => ((n[verdictOf(r)] += 1), n), { correct: 0, partial: 0, wrong: 0, ungraded: 0 });
  const reviewing = job?.kind === "reviewing";
  // When the explanation lands: a brief tick on the button, then it points down at the card (it never asks again).
  const reviewRef = useRef<HTMLDivElement>(null);
  const [justExplained, setJustExplained] = useState(false);
  useEffect(() => {
    if (!review) return;
    setJustExplained(true);
    reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    const t = setTimeout(() => setJustExplained(false), 1200);
    return () => clearTimeout(t);
  }, [review]);
  return (
    <div className="flex flex-col gap-8" data-testid="quiz-results">
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }}>
        <Card className="rounded-panel">
          {reviewing ? <JobBar value={job.fraction} className="z-10" /> : null}
          <CardMedia className="h-28">
            <ArtCanvas palette="lilac" seed={path} weave className="absolute inset-0" />
          </CardMedia>
          <div className="flex flex-col gap-5 p-6">
            <div className="flex flex-col gap-1">
              <h2 className="font-medium text-lg tracking-title">{headline(share)}</h2>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <CountUp value={Math.round(share * 100)} className="font-medium text-3xl text-foreground tabular-nums tracking-hero" />
                <span className="text-base text-muted-foreground tabular-nums">
                  {pointsText(points)} of {total} right{ungraded ? ` · ${ungraded} not graded` : ""}
                </span>
              </div>
              {g?.exam ? <p className="mt-1 text-muted-foreground text-sm [overflow-wrap:anywhere]">For {g.exam}{g.scope ? `: ${tidyScope(g.scope)}` : ""}</p> : null}
            </div>
            <ScoreBar results={attempt.results} />
            <Card variant="well" className="gap-0 px-4 py-1.5">
              {counts.correct ? <OutcomeRow tone="done" label={`${counts.correct} right`} /> : null}
              {counts.partial ? <OutcomeRow tone="partial" label={`${counts.partial} partly right`} /> : null}
              {counts.wrong ? <OutcomeRow tone="wrong" label={`${counts.wrong} to go over`} /> : null}
              {counts.ungraded ? <OutcomeRow tone="muted" label={`${counts.ungraded} not graded`} /> : null}
            </Card>
            <div className="grid grid-cols-2 gap-2">
              {missed.length ? (
                <>
                  <Button onClick={() => onRetake(missed)}>
                    Retake {plural(missed.length, "miss", "misses")}
                  </Button>
                  {review ? (
                    <Button variant="outline" success={justExplained} onClick={() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })}>
                      Explained
                      <Icon icon={icons.arrowDown} />
                    </Button>
                  ) : (
                    <Button variant="outline" pending={reviewing} disabled={!!job} onClick={onReview}>
                      <Icon icon={icons.ai} />
                      {reviewing ? "Explaining…" : "Explain my mistakes"}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Button onClick={onDone}>Done</Button>
                  <Button variant="outline" onClick={() => onRetake(null)}>
                    Take again
                  </Button>
                </>
              )}
            </div>
          </div>
        </Card>
      </motion.div>

      {review ? (
        <motion.div ref={reviewRef} className="scroll-mt-6" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}>
          <Card>
            <div className="flex items-center gap-2.5 border-b px-5 py-3">
              <Icon icon={icons.ai} className="size-4.5 text-muted-foreground" />
              <span className="flex-1 font-medium text-base">What to work on</span>
              {review.deckPath ? (
                <Button size="sm" variant="outline" onClick={() => onStudyCards(review.deckPath!)}>
                  Study these cards
                </Button>
              ) : null}
            </div>
            <div className="px-5 py-4">
              <StudyText text={review.summary || "Nothing stood out."} space={space} id={`review-${attempt.path}`} />
            </div>
          </Card>
        </motion.div>
      ) : null}

      {topics.length > 1 || (topics.length === 1 && topics[0]!.topic !== "Other") ? (
        <section className="flex flex-col gap-3" data-testid="quiz-topics">
          <h3 className="font-medium text-lg tracking-title">By topic</h3>
          <Card className="gap-0 px-5 py-2">
            {topics.map((t, i) => {
              const p = t.percent ?? 0;
              return (
                <div key={t.topic} className="flex h-10 items-center gap-3 text-sm">
                  <Disc tone={t.percent == null ? "muted" : p >= 80 ? "done" : p >= 50 ? "partial" : "wrong"} />
                  <Truncate className="min-w-0 flex-1 text-foreground">{t.topic}</Truncate>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {pointsText(t.points)}/{t.graded}
                  </span>
                  <span className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted max-sm:hidden">
                    <motion.span
                      className="absolute inset-y-0 left-0 rounded-full bg-foreground/35"
                      initial={{ width: 0 }}
                      animate={{ width: `${p}%` }}
                      transition={{ duration: 0.5, delay: 0.05 * i, ease: EASE }}
                    />
                  </span>
                  <span className="w-12 shrink-0 text-right text-foreground tabular-nums">{t.percent == null ? "–" : `${Math.round(p)}%`}</span>
                </div>
              );
            })}
          </Card>
        </section>
      ) : null}

      {items.length ? (
        <section className="flex flex-col gap-3" data-testid="quiz-review">
          <h3 className="font-medium text-lg tracking-title">What to go over</h3>
          <div className="flex flex-col gap-3">
            {items.map((it) => {
              const question = quiz.questions.find((x) => x.id === it.id)!;
              return <ReviewCard key={it.id} space={space} number={it.index + 1} question={question} result={byId.get(it.id)!} why={WHY_WORDS[it.why]} defaultOpen={it.why === "confident-miss" || it.why === "miss"} />;
            })}
          </div>
        </section>
      ) : null}

      <Collapsible>
        <CollapsibleTrigger className="group flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground">
          <Icon icon={icons.chevronRight} className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
          All {plural(quiz.questions.length, "answer")}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 pt-3">
            {quiz.questions.map((x, i) => (byId.get(x.id) ? <ReviewCard key={x.id} space={space} number={i + 1} question={x} result={byId.get(x.id)!} /> : null))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}

function OutcomeRow({ tone, label }: { tone: "done" | "partial" | "wrong" | "muted"; label: string }) {
  return (
    <div className="flex h-9 items-center gap-3 text-sm">
      <Disc tone={tone} />
      <span className="text-foreground tabular-nums">{label}</span>
    </div>
  );
}

/** One segment per question, coloured by how it went. */
function ScoreBar({ results }: { results: QuestionResult[] }) {
  return (
    <div className="flex gap-1" aria-hidden>
      {results.map((r, i) => {
        const v = verdictOf(r);
        return (
          <motion.span
            key={r.id}
            initial={{ opacity: 0, scaleY: 0.4 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{ duration: 0.2, delay: 0.03 * i, ease: EASE }}
            className={cn("h-1.5 flex-1 rounded-full", v === "correct" ? "bg-primary" : v === "partial" ? "bg-warning/50" : v === "wrong" ? "bg-destructive/35" : "bg-muted")}
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
    <Collapsible defaultOpen={defaultOpen} className="overflow-hidden rounded-card border bg-card shadow-card">
      <CollapsibleTrigger className="group flex w-full items-start gap-3 px-5 py-4 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-2xs text-muted-foreground tabular-nums">{number}</span>
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex items-center gap-1.5 text-muted-foreground text-sm">
            <span className={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs tabular-nums", v.chip)}>
              {verdict === "partial" && result.partial != null ? `${Math.round(result.partial * 100)}% right` : (why ?? v.label)}
            </span>
            {question.topic ? (
              <>
                <span className="text-subtle-foreground">·</span>
                <Truncate className="min-w-0">{question.topic}</Truncate>
              </>
            ) : null}
          </div>
          <StudyText text={question.prompt} space={space} id={`r-${question.id}`} reveal={question.kind === "cloze"} className="[&_.markdown]:text-base" />
        </div>
        <Icon icon={icons.chevronDown} className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 px-5 pb-5 pl-13 text-sm">
          {!result.correct ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl border border-border/70 bg-well px-4 py-3 text-sm">
              <dt className="text-muted-foreground">You said</dt>
              <dd className="min-w-0">{given ? <StudyText text={given} space={space} id={`g-${question.id}`} className="[&_.markdown]:text-sm" /> : <span className="text-muted-foreground">Nothing</span>}</dd>
              {expected ? (
                <>
                  <dt className="text-muted-foreground">{typed && question.kind === "short" ? "A good answer" : "Answer"}</dt>
                  <dd className="min-w-0">
                    <StudyText text={expected} space={space} id={`e-${question.id}`} className="[&_.markdown]:text-sm" />
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
    <div className="flex flex-col gap-6 motion-safe:animate-skeleton" aria-hidden>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-32 animate-none" />
        <Skeleton className="h-1 w-full animate-none" />
      </div>
      <Skeleton className="h-5 w-4/5 animate-none" />
      <div className="flex flex-col gap-2">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-14 w-full animate-none rounded-card" />
        ))}
      </div>
    </div>
  );
}

const CHOICE =
  "group flex min-h-14 items-center gap-4 rounded-card border bg-card px-4 py-3 text-left shadow-card outline-none transition-[border-color,background-color,box-shadow] duration-150 hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring data-checked:border-primary data-checked:bg-primary/4 data-checked:ring-1 data-checked:ring-primary";
const KEYCAP =
  "flex size-7 shrink-0 items-center justify-center rounded-md border bg-keycap font-medium text-muted-foreground text-xs tabular-nums transition-colors group-data-checked:border-primary group-data-checked:bg-primary group-data-checked:text-primary-foreground";

/** Enter, ← and → move between questions, so Base UI's own handling of those keys stays out of the way (↑ and ↓ still move between choices). */
const quizKeys = (e: React.KeyboardEvent & { preventBaseUIHandler?: () => void }) => {
  if (e.key === "Enter" || e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventBaseUIHandler?.();
};

/** A question's choices as Base UI radios (one answer) or checkboxes (several), drawn as large cards with their key. */
function ChoiceList({
  multi,
  choices,
  answer,
  onAnswer,
  render,
}: {
  multi: boolean;
  choices: string[];
  answer: unknown;
  onAnswer: (a: string | string[]) => void;
  render: (choice: string, index: number) => ReactNode;
}) {
  const keycap = (i: number, picked: boolean) => (
    <span className={KEYCAP} aria-hidden>
      {multi && picked ? <Icon icon={icons.check} className="size-3.5" /> : i < 9 ? i + 1 : choiceLetter(i)}
    </span>
  );
  if (multi) {
    const list = answerList(answer as never);
    const value = choices.filter((c) => includesAnswer(answer as never, c));
    return (
      <CheckboxGroup value={value} onValueChange={(v) => onAnswer(list.filter((x) => !choices.includes(x)).concat(v as string[]))} aria-label="Choices" className="flex flex-col gap-2">
        <p className="text-muted-foreground text-sm">Choose all that apply.</p>
        {choices.map((c, i) => (
          <CheckboxPrimitive.Root key={c} value={c} data-choice="" onKeyDown={quizKeys} className={CHOICE} nativeButton render={<motion.button type="button" whileTap={{ scale: 0.995 }} />}>
            {keycap(i, value.includes(c))}
            {render(c, i)}
          </CheckboxPrimitive.Root>
        ))}
      </CheckboxGroup>
    );
  }
  const value = choices.find((c) => includesAnswer(answer as never, c)) ?? null;
  return (
    <RadioGroupPrimitive value={value} onValueChange={(v) => onAnswer(v as string)} aria-label="Choices" className="flex flex-col gap-2">
      {choices.map((c, i) => (
        <RadioPrimitive.Root key={c} value={c} data-choice="" onKeyDown={quizKeys} className={CHOICE} nativeButton render={<motion.button type="button" whileTap={{ scale: 0.995 }} />}>
          {keycap(i, value === c)}
          {render(c, i)}
        </RadioPrimitive.Root>
      ))}
    </RadioGroupPrimitive>
  );
}
