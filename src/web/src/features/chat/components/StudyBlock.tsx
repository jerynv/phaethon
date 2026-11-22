import { useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { ArtTile } from "@/components/art";
import { RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/core";
import { studySources } from "@/features/study/api";
import { MakeDialog, useStudyPick } from "@/features/study/components/MakeDialog";
import { MakingRow } from "@/features/study/components/MakingRow";
import { jobForOrigin, useMakeJobs } from "@/features/study/jobs";
import { useStudyFlow } from "@/features/study/flow-store";
import { draftFromPlan } from "@/features/study/lib/make-flow";
import type { StudyScreen } from "@/features/study/StudyView";
import type { CourseSource } from "@/features/study/lib/types";
import { useLoad } from "@/features/study/use-load";
import { studyChatPlan } from "../api";
import { guessKind, openLabel, planSentence, planTitle, questionBefore, readBlock, type StudyPlan } from "../lib/study-chat";
import { useSpaceChat } from "../store";

/**
 * A quiz or deck the assistant proposed (a `phaethon-study` block): what it
 * will be, and one button. When the plan says enough (a course, and a test the
 * course has described or topics) the button makes it right here, with the
 * run's progress under the card; only a plan missing something opens the
 * make dialog, at the step that needs an answer.
 */
export function StudyBlock({ code, space, streaming, messageKey }: { code: string; space: string; streaming: boolean; messageKey: string }) {
  const read = readBlock(code, !streaming);
  const chat = useSpaceChat(space);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const question = questionBefore(chat.messages.map((m) => ({ key: m.key, role: m.role, text: m.role === "user" ? m.text : undefined })), messageKey);
  const block = read.state === "ok" ? read.block : null;
  const asked = useRef<string | null>(null);
  const sources = useLoad<CourseSource[]>(() => studySources(space), [space], "study:sources");
  const courses = useMemo(() => (sources.data ?? []).map((s) => s.folder), [sources.data]);
  const draft = useMemo(() => (plan && sources.data ? draftFromPlan(plan, courses, question) : undefined), [plan, sources.data, courses, question]);
  const pick = useStudyPick(space, true);
  const jobs = useMakeJobs((s) => s.jobs);
  const job = useMemo(() => jobForOrigin(jobs, space, plan?.origin), [jobs, space, plan?.origin]);
  const replan = () => block && studyChatPlan(space, block, question).then(setPlan, () => {});

  useEffect(() => {
    const key = block ? `${block}\0${attempt}` : null;
    if (!block || asked.current === key) return;
    asked.current = key;
    let live = true;
    studyChatPlan(space, block, question).then(
      (p) => live && setPlan(p),
      (e) => live && setPlanError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [block, space, question, attempt]);

  // When its run ends: the result opens from here, and the plan is asked for again so it remembers what was made.
  const ended = useRef<string | null>(null);
  useEffect(() => {
    if (!job || job.status === "running" || job.status === "stopping" || ended.current === `${job.id}:${job.status}`) return;
    ended.current = `${job.id}:${job.status}`;
    if (job.status === "done" && job.done?.path) setMade(job.done.path);
    if (job.status === "needsScope") setOpen(true);
    void replan();
  }, [job, block, space, question]);

  const kind = read.state === "ok" ? read.kind : guessKind(code);
  const glyph = kind === "quiz" ? icons.quiz : icons.deck;

  if (read.state === "invalid") return <RowError className="my-2" message={`This study plan couldn’t be read: ${read.why}`} />;
  if (read.state === "writing" || (!plan && !planError)) {
    return (
      <div className="my-3 flex items-center gap-4 rounded-card border bg-card p-3">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-well text-muted-foreground">
          <Icon icon={glyph} className="size-5" />
        </span>
        <div className="flex flex-1 flex-col gap-2">
          <span className="text-shimmer text-base">{kind === "quiz" ? "Planning a quiz…" : "Planning flashcards…"}</span>
          <Skeleton className="h-2.5 w-2/3" />
        </div>
      </div>
    );
  }
  if (planError || !plan) return <RowError className="my-2" message={planError ?? "No plan"} onRetry={() => (setPlanError(null), setAttempt((n) => n + 1))} />;

  const path = made ?? plan.made;
  const openMade = (screen: StudyScreen) => {
    useStudyFlow.getState().goTo(space, screen);
    useNav.getState().setView("study");
  };
  const notes = [...plan.notes, ...(plan.unknown.length ? [`Not in this space: ${plan.unknown.join(", ")}`] : []), ...(plan.material ? [plan.material.text] : [])];
  // The plan says enough to start straight away: a course, and a test the course (or the person) has described, or topics.
  const examTitle = draft?.target === "exam" ? draft.exam.trim() : "";
  const knownWords = plan.scope?.state === "known" ? (plan.scope.words ?? "") : "";
  const ready = !!draft?.course && (draft.target === "topics" || (!!examTitle && (plan.scope?.state === "known" || !!draft.covers.trim())));
  const running = !!job && (job.status === "running" || job.status === "stopping");
  const make = () => {
    if (!draft) return;
    if (!ready) return setOpen(true);
    useMakeJobs.getState().start({ space, draft, examTitle, knownWords, pick: pick.pick, courseName: sources.data?.find((s) => s.folder === draft.course)?.name });
  };

  return (
    <div className="my-3 overflow-hidden rounded-card border bg-card" data-testid="study-block">
      <div className="flex items-start gap-4 p-3">
        <ArtTile palette="lilac" seed={planTitle(plan)} className="size-14">
          <span className="flex size-full items-center justify-center">
            <span className="flex size-8 items-center justify-center rounded-lg bg-card/90 text-foreground">
              <Icon icon={glyph} className="size-4" />
            </span>
          </span>
        </ArtTile>
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-0.5">
          <span className="truncate font-medium text-base">{planTitle(plan)}</span>
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">{planSentence(plan)}</p>
          {plan.sources.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {plan.sources.slice(0, 6).map((s) => (
                <span key={s.path} className="inline-flex max-w-48 items-center gap-1 rounded-md border border-border/70 bg-well px-1.5 py-0.5 text-muted-foreground text-xs">
                  <Icon icon={icons.fileText} className="size-3" />
                  <span className="truncate">{s.name}</span>
                </span>
              ))}
              {plan.sources.length > 6 ? <span className="px-1 py-0.5 text-muted-foreground text-xs tabular-nums">+{plan.sources.length - 6}</span> : null}
            </div>
          ) : null}
          {sources.error ? <RowError className="mt-1" message={`Couldn’t list your courses: ${errorText(sources.error)}`} onRetry={sources.reload} /> : null}
          {notes.map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-sm text-warning-foreground">
              <Icon icon={icons.warning} className="mt-0.5 size-3.5" />
              <span className="[overflow-wrap:anywhere]">{n}</span>
            </p>
          ))}
          {job?.status === "error" && !path ? <RowError className="mt-1" message={job.failure ?? "Couldn’t make it"} onRetry={make} /> : null}
        </div>
        <div className="shrink-0 self-center">
          {path ? (
            <Button size="sm" onClick={() => openMade(plan.kind === "quiz" ? { kind: "quiz", path } : { kind: "review", paths: [path] })}>
              {openLabel(plan)}
            </Button>
          ) : running ? null : plan.running && !job ? (
            <Button size="sm" variant="outline" pending>
              Making…
            </Button>
          ) : (
            <Button size="sm" pending={!draft && !sources.error} onClick={make}>
              <Icon icon={icons.ai} />
              {plan.kind === "quiz" ? "Make this quiz" : "Make these cards"}
            </Button>
          )}
        </div>
      </div>
      {running && job ? <MakingRow job={job} showTitle={false} className="border-t px-3 py-2.5" /> : null}
      {open && draft ? (
        <MakeDialog
          space={space}
          kind={plan.kind}
          open={open}
          onOpenChange={setOpen}
          sources={sources}
          draft={draft}
          job={job?.status === "needsScope" ? job.id : undefined}
          onChanged={() => void replan()}
          onOpen={(screen) => {
            if (screen.kind === "quiz") setMade(screen.path);
            else if (screen.kind === "review" && screen.paths?.[0]) setMade(screen.paths[0]);
            openMade(screen);
          }}
        />
      ) : null}
    </div>
  );
}
