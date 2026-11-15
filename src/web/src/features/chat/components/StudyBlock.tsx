import { useEffect, useMemo, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { RowError } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { studySources } from "@/features/study/api";
import { MakeDialog } from "@/features/study/components/MakeDialog";
import { useStudyFlow } from "@/features/study/flow-store";
import { draftFromPlan } from "@/features/study/lib/make-flow";
import type { StudyScreen } from "@/features/study/StudyView";
import type { CourseSource } from "@/features/study/lib/types";
import { type Loaded, useLoad } from "@/features/study/use-load";
import { studyChatPlan } from "../api";
import { guessKind, openLabel, planSentence, planTitle, questionBefore, readBlock, type StudyPlan } from "../lib/study-chat";
import { useSpaceChat } from "../store";

/**
 * A quiz or deck the assistant proposed (a `phaethon-study` block): what it
 * will be, and a button that opens the make dialog with the plan filled in
 * (course, test or topics, size, kinds), the same flow as Study's.
 */
export function StudyBlock({ code, space, streaming, messageKey }: { code: string; space: string; streaming: boolean; messageKey: string }) {
  const read = readBlock(code, !streaming);
  const chat = useSpaceChat(space);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [made, setMade] = useState<string | null>(null);
  const question = questionBefore(chat.messages.map((m) => ({ key: m.key, role: m.role, text: m.role === "user" ? m.text : undefined })), messageKey);
  const block = read.state === "ok" ? read.block : null;
  const asked = useRef<string | null>(null);
  // Asked for only once the dialog is wanted; an empty list until then.
  const sources = useLoad<CourseSource[] | undefined>(() => (open ? studySources(space) : Promise.resolve(undefined)), [open, space]);
  const courses = useMemo(() => (sources.data ?? []).map((s) => s.folder), [sources.data]);
  const draft = useMemo(() => (plan && sources.data ? draftFromPlan(plan, courses, question) : undefined), [plan, sources.data, courses, question]);

  useEffect(() => {
    if (!block || asked.current === block) return;
    asked.current = block;
    studyChatPlan(space, block, question).then(setPlan, (e) => setPlanError(errorText(e)));
  }, [block, space, question]);

  const kind = read.state === "ok" ? read.kind : guessKind(code);
  const glyph = kind === "quiz" ? icons.quiz : icons.study;

  if (read.state === "invalid") return <RowError className="my-2" message={`This study plan couldn’t be read: ${read.why}`} />;
  if (read.state === "writing" || (!plan && !planError)) {
    return (
      <div className="my-3 flex items-center gap-3 rounded-card border bg-card p-4 shadow-card">
        <Icon icon={glyph} className="size-5 text-muted-foreground" />
        <div className="flex flex-1 flex-col gap-1.5">
          <span className="text-shimmer font-medium text-sm">{kind === "quiz" ? "Planning a quiz…" : "Planning flashcards…"}</span>
          <Skeleton className="h-2 w-2/3" />
        </div>
      </div>
    );
  }
  if (planError || !plan) return <RowError className="my-2" message={planError ?? "No plan"} onRetry={() => ((asked.current = null), setPlanError(null))} />;

  const path = made ?? plan.made;
  const openMade = (screen: StudyScreen) => {
    useStudyFlow.getState().goTo(space, screen);
    useNav.getState().setView("study");
  };
  const notes = [...plan.notes, ...(plan.unknown.length ? [`Not in this space: ${plan.unknown.join(", ")}`] : []), ...(plan.material ? [plan.material.text] : [])];

  return (
    <div className="my-3 overflow-hidden rounded-card border bg-card shadow-card" data-testid="study-block">
      <div className="flex items-start gap-3 p-4">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-well text-foreground">
          <Icon icon={glyph} className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-medium text-base">{planTitle(plan)}</span>
          <p className="text-muted-foreground text-sm [overflow-wrap:anywhere]">{planSentence(plan)}</p>
          {plan.sources.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {plan.sources.slice(0, 6).map((s) => (
                <span key={s.path} className="inline-flex max-w-48 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                  <Icon icon={icons.fileText} className="size-3" />
                  <span className="truncate">{s.name}</span>
                </span>
              ))}
              {plan.sources.length > 6 ? <span className="px-1 py-0.5 text-2xs text-muted-foreground tabular-nums">+{plan.sources.length - 6}</span> : null}
            </div>
          ) : null}
          {open && sources.error ? <RowError className="mt-1" message={`Couldn’t list your courses: ${errorText(sources.error)}`} onRetry={sources.reload} /> : null}
          {notes.map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-warning-foreground text-xs">
              <Icon icon={icons.error} className="mt-0.5 size-3.5" />
              <span className="[overflow-wrap:anywhere]">{n}</span>
            </p>
          ))}
        </div>
        <div className="shrink-0">
          {path ? (
            <Button size="xs" onClick={() => openMade(plan.kind === "quiz" ? { kind: "quiz", path } : { kind: "review", paths: [path] })}>
              {openLabel(plan)}
            </Button>
          ) : plan.running ? (
            <Button size="xs" variant="outline" disabled>
              <Spinner size="xs" /> Making…
            </Button>
          ) : (
            <Button size="xs" disabled={open && !draft && !sources.error} onClick={() => (sources.error ? sources.reload() : undefined, setOpen(true))}>
              {open && !draft && !sources.error ? <Spinner size="xs" /> : <Icon icon={icons.ai} />}
              {plan.kind === "quiz" ? "Make this quiz" : "Make these cards"}
            </Button>
          )}
        </div>
      </div>
      {open ? (
        <MakeDialog
          space={space}
          kind={plan.kind}
          open={open && !!draft}
          onOpenChange={setOpen}
          sources={sources as Loaded<CourseSource[]>}
          draft={draft}
          onChanged={() => void studyChatPlan(space, block!, question).then(setPlan, () => {})}
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
