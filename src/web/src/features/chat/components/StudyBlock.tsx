import { Cards, Exam } from "@phosphor-icons/react";
import { CircleAlertIcon, FileTextIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { RowError } from "@/components/errors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Channel, errorText } from "@/lib/core";
import { studyChatCancel, studyChatMake, studyChatPlan, type StudyEvent } from "../api";
import { guessKind, makeLabel, openLabel, planSentence, planTitle, questionBefore, readBlock, type StudyPlan } from "../lib/study-chat";
import { useSpaceChat } from "../store";

type Run = { state: "idle" } | { state: "running"; step: string; done: number; total: number } | { state: "done"; made: string } | { state: "error"; message: string };

/** A quiz or deck the assistant proposed (a `phaethon-study` block): what it will be, and a button to make it. */
export function StudyBlock({ code, space, streaming, messageKey }: { code: string; space: string; streaming: boolean; messageKey: string }) {
  const read = readBlock(code, !streaming);
  const chat = useSpaceChat(space);
  const setView = useNav((s) => s.setView);
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [run, setRun] = useState<Run>({ state: "idle" });
  const question = questionBefore(chat.messages.map((m) => ({ key: m.key, role: m.role, text: m.role === "user" ? m.text : undefined })), messageKey);
  const block = read.state === "ok" ? read.block : null;
  const asked = useRef<string | null>(null);

  useEffect(() => {
    if (!block || asked.current === block) return;
    asked.current = block;
    studyChatPlan(space, block, question).then(setPlan, (e) => setPlanError(errorText(e)));
  }, [block, space, question]);

  const kind = read.state === "ok" ? read.kind : guessKind(code);
  const Icon = kind === "quiz" ? Exam : Cards;

  if (read.state === "invalid") return <RowError className="my-2" message={`This study plan couldn’t be read: ${read.why}`} />;
  if (read.state === "writing" || (!plan && !planError)) {
    return (
      <div className="my-3 flex items-center gap-3 rounded-xl border p-3">
        <Icon className="size-5 shrink-0 text-muted-foreground" />
        <div className="flex flex-1 flex-col gap-1.5">
          <span className="text-shimmer font-medium text-sm">{kind === "quiz" ? "Planning a quiz…" : "Planning flashcards…"}</span>
          <Skeleton className="h-2 w-2/3" />
        </div>
      </div>
    );
  }
  if (planError || !plan) return <RowError className="my-2" message={planError ?? "No plan"} onRetry={() => ((asked.current = null), setPlanError(null))} />;

  const make = () => {
    setRun({ state: "running", step: "Starting", done: 0, total: plan.count });
    const ch = new Channel<StudyEvent>((e) => {
      if (e.type === "progress") setRun({ state: "running", step: e.step, done: e.done, total: e.total });
      else if (e.type === "done") setRun({ state: "done", made: e.path ?? "" });
      else if (e.type === "error") setRun({ state: "error", message: e.message });
      else if (e.type === "cancelled") setRun({ state: "idle" });
      else if (e.type === "needsScope") setRun({ state: "error", message: `Phaethon doesn’t know what ${e.exam} in ${e.courseName} covers yet. Map the course in Study first.` });
    });
    studyChatMake(space, block!, question, "", ch).catch((e) => setRun({ state: "error", message: errorText(e) })).finally(() => ch.close());
  };

  const pct = run.state === "running" && run.total ? Math.round((run.done / run.total) * 100) : 0;
  return (
    <div className="relative my-3 overflow-hidden rounded-xl border bg-card">
      {run.state === "running" ? (
        <div className="absolute inset-x-0 top-0 h-0.5 bg-muted">
          <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      ) : null}
      <div className="flex items-start gap-3 p-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Icon className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-medium text-sm">{planTitle(plan)}</span>
          <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{planSentence(plan)}</p>
          {plan.sources.length ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {plan.sources.slice(0, 6).map((s) => (
                <span key={s.path} className="inline-flex max-w-48 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                  <FileTextIcon className="size-3 shrink-0" />
                  <span className="truncate">{s.name}</span>
                </span>
              ))}
              {plan.sources.length > 6 ? <span className="px-1 py-0.5 text-2xs text-muted-foreground">+{plan.sources.length - 6}</span> : null}
            </div>
          ) : null}
          {[...plan.notes, ...(plan.unknown.length ? [`Not in this space: ${plan.unknown.join(", ")}`] : []), ...(plan.material ? [plan.material.text] : [])].map((n) => (
            <p key={n} className="flex items-start gap-1.5 text-warning-foreground text-xs">
              <CircleAlertIcon className="mt-0.5 size-3 shrink-0" />
              <span className="[overflow-wrap:anywhere]">{n}</span>
            </p>
          ))}
          {run.state === "running" ? (
            <p className="mt-1 flex items-center gap-2 text-muted-foreground text-xs">
              <span className="min-w-0 flex-1 truncate">{run.step}</span>
              <span className="shrink-0 tabular-nums">
                {run.done}/{run.total}
              </span>
            </p>
          ) : null}
          {run.state === "error" ? <RowError className="mt-1" message={run.message} onRetry={make} /> : null}
        </div>
        <div className="shrink-0">
          {run.state === "done" || plan.made ? (
            <Button size="xs" onClick={() => setView("study")}>
              {openLabel(plan)}
            </Button>
          ) : run.state === "running" ? (
            <Button size="xs" variant="outline" onClick={() => void studyChatCancel(space, plan.origin)}>
              <Spinner size="xs" /> Stop
            </Button>
          ) : (
            <Button size="xs" onClick={make} disabled={plan.running}>
              {makeLabel(plan)}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
