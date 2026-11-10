import { BookOpenCheckIcon, CircleAlertIcon, LayersIcon, LoaderIcon, SquareIcon } from "lucide-react";
import { use, useEffect, useState, useSyncExternalStore } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Channel, errorText } from "@/lib/core";
import { studyChatCancel, studyChatMake, studyChatPlan, type StudyEvent } from "../api";
import { MessageContext, useSpaceId } from "../context";
import { guessKind, makeLabel, openLabel, planSentence, planTitle, readBlock, type StudyPlan } from "../lib/study-chat";

type Run =
  | { at: "running"; step?: string; done?: number; total?: number }
  | { at: "done"; path: string; count?: number }
  | { at: "error"; message: string }
  | { at: "cancelled" };

// Runs outlive the card (a remount, a space switch), keyed by space and plan.
const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
const setRun = (key: string, run: Run) => {
  runs.set(key, run);
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

const STEP_WORDS: Record<string, string> = {
  mapping: "Mapping what the course teaches",
  reading: "Reading the material",
  making: "Writing",
  checking: "Checking each one against the notes",
  saving: "Saving",
};

function stepText(run: Extract<Run, { at: "running" }>, kind: "quiz" | "deck"): string {
  if (!run.step) return "Starting…";
  const words = run.step === "making" ? (kind === "quiz" ? "Writing questions" : "Writing cards") : (STEP_WORDS[run.step] ?? "Working");
  return run.total ? `${words}: ${run.done ?? 0} of ${run.total}` : `${words}…`;
}

function make(space: string, plan: StudyPlan, block: string, question: string, reply: string) {
  const key = `${space}\n${plan.origin}`;
  if (runs.get(key)?.at === "running") return;
  setRun(key, { at: "running" });
  const ch = new Channel<StudyEvent>((e) => {
    if (e.type === "progress") setRun(key, { at: "running", step: e.step, done: e.done, total: e.total });
    else if (e.type === "done" && e.path) setRun(key, { at: "done", path: e.path, count: e.questions ?? e.cards });
    else if (e.type === "error") setRun(key, { at: "error", message: e.message });
    else if (e.type === "cancelled") setRun(key, { at: "cancelled" });
    else if (e.type === "needsScope")
      setRun(key, {
        at: "error",
        message: `Phaethon doesn’t know yet what ${e.exam} in ${e.courseName} covers. Say what it covers in a message, then try again.`,
      });
  });
  studyChatMake(space, block, question, reply, ch).catch((e: unknown) => setRun(key, { at: "error", message: errorText(e) }));
}

/**
 * A ```phaethon-study block: the quiz or flashcards the reply offers, checked
 * by the core, with one button that makes them (grounded in the course) and
 * then opens them in Study.
 */
export function StudyCard({ code }: { code: string }) {
  const space = useSpaceId();
  const { streaming, question, reply } = use(MessageContext);
  const state = readBlock(code, !streaming);
  const block = state.state === "ok" ? state.block : "";
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const key = plan ? `${space}\n${plan.origin}` : "";
  const run = useSyncExternalStore(subscribe, () => (key ? runs.get(key) : undefined));
  const nav = useNav();

  useEffect(() => {
    if (!block) return;
    let live = true;
    setPlanError(null);
    studyChatPlan(space, block, question).then(
      (p) => live && setPlan(p),
      (e: unknown) => live && setPlanError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [space, block, question]);

  // Made in another window: look again until it's done.
  useEffect(() => {
    if (!plan?.running || run) return;
    const t = setInterval(() => {
      studyChatPlan(space, block, question).then(setPlan, () => {});
    }, 3000);
    return () => clearInterval(t);
  }, [plan?.running, run, space, block, question]);

  const kind = state.state === "ok" ? state.kind : guessKind(code);
  const Icon = kind === "quiz" ? BookOpenCheckIcon : LayersIcon;

  if (state.state === "invalid") {
    return <p className="ph-block text-sm text-muted-foreground">{state.why} Ask again if you’d like a quiz or flashcards made.</p>;
  }
  if (planError) {
    return (
      <p className="ph-block flex items-start gap-2 text-sm text-muted-foreground">
        <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
        {planError}
      </p>
    );
  }
  if (state.state === "writing" || !plan) {
    return (
      <div className="ph-block ph-ui flex items-center gap-3 rounded-xl border bg-card p-4 text-sm text-muted-foreground" aria-busy="true">
        <Icon aria-hidden className="size-5 shrink-0" />
        {kind === "quiz" ? "Planning a quiz…" : "Planning flashcards…"}
      </div>
    );
  }

  const madePath = run?.at === "done" ? run.path : plan.made;
  const running = run?.at === "running" || (plan.running && !run);
  const open = () =>
    madePath && nav.go(plan.kind === "quiz" ? { kind: "study", quiz: madePath } : { kind: "study", deck: madePath }, space);

  return (
    <section
      aria-label={planTitle(plan)}
      className="ph-block ph-ui flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground"
      data-study-card={plan.kind}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-4.5" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{plan.kind === "quiz" ? "Quiz" : "Flashcards"}</p>
          <p className="font-semibold leading-snug">{planTitle(plan)}</p>
          <p className="text-sm text-muted-foreground">{planSentence(plan)}</p>
        </div>
      </div>
      {(plan.unknown.length > 0 || plan.notes.length > 0 || plan.scope || (plan.material && !madePath)) && (
        <ul className="flex flex-col gap-1 border-t pt-3 text-sm text-muted-foreground">
          {plan.unknown.length > 0 && <li>Not in this space, so left out: {plan.unknown.join(", ")}.</li>}
          {plan.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {plan.scope?.state === "known" && (
            <li>
              {plan.scope.exam} covers: {plan.scope.words || "what its materials list"}
              {plan.scope.fromUser ? " (as you said)" : ""}.
            </li>
          )}
          {plan.scope?.state === "unknown" && <li>Phaethon couldn’t find what {plan.scope.exam} covers. You’ll be asked.</li>}
          {plan.scope?.state === "unmapped" && <li>Phaethon will first check what {plan.scope.exam} covers.</li>}
          {plan.material && !madePath && <li>{plan.material.text}</li>}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={planTitle(plan)}>
        {madePath ? (
          <Button size="sm" onClick={open}>
            {openLabel(plan)}
          </Button>
        ) : running ? (
          <>
            <span className="inline-flex items-center gap-2 text-sm" role="status">
              <LoaderIcon aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
              {run?.at === "running" ? stepText(run, plan.kind) : "Being made…"}
            </span>
            <Button variant="ghost-muted" size="sm" onClick={() => void studyChatCancel(space, plan.origin)}>
              <SquareIcon aria-hidden />
              Stop
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={streaming} onClick={() => make(space, plan, block, question, reply)}>
            {run?.at === "error" ? "Try again" : makeLabel(plan)}
          </Button>
        )}
        {run?.at === "done" && run.count !== undefined && run.count > 0 && (
          <span className="text-sm text-muted-foreground">
            {run.count} {plan.kind === "quiz" ? (run.count === 1 ? "question" : "questions") : run.count === 1 ? "card" : "cards"} ready.
          </span>
        )}
        {run?.at === "cancelled" && <span className="text-sm text-muted-foreground">Stopped. Nothing was saved.</span>}
      </div>
      {run?.at === "error" && (
        <p role="alert" className="flex items-start gap-2 text-sm">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          {run.message}
        </p>
      )}
    </section>
  );
}
