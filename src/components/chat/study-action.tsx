import { useAuiState } from "@assistant-ui/react";
import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { announce } from "@/components/shell/announcer";
import { ScopeEvidence } from "@/components/study/grounding";
import { requestStudy } from "@/components/study/space-view";
import { needsModel, plainError } from "@/components/study/words";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Input } from "@/components/ui/input";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { studyChatCancel, studyChatMake, studyChatPlan, studyScopeState, type Grounding, type StudyEvent, type UnknownScope } from "@/lib/study";
import { STUDY_FENCE, makeLabel, openLabel, planSentence, planTitle, questionBefore, readBlock, type PlanScope, type StudyPlan } from "@/lib/study-chat";
import { mathAsText } from "@/lib/study-math";

import { SpaceIdContext } from "./approval-card";

// ---- Runs, kept outside the card: a card that re-renders or remounts while
// its quiz is being made picks the run up again, and one plan runs once. ----

type Run =
  | { at: "running"; step: string; done: number; total: number; kept?: number; dropped?: number }
  | { at: "done"; path: string; grounding?: Grounding }
  | { at: "error"; message: string; needs?: UnknownScope }
  | { at: "cancelled" };

const runs = new Map<string, Run>();
const listeners = new Set<() => void>();
const setRun = (key: string, r: Run) => {
  runs.set(key, r);
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const useRun = (key: string) => useSyncExternalStore(subscribe, () => runs.get(key));

/** Make the plan; opens it in Study when done. Ignored while it already runs. */
function start(space: string, plan: StudyPlan, block: string, question: string, reply: string) {
  const key = `${space}\n${plan.origin}`;
  if (runs.get(key)?.at === "running") return;
  setRun(key, { at: "running", step: "", done: 0, total: 0 });
  let end: Run | null = null;
  let needs: UnknownScope | undefined;
  const onEvent = (e: StudyEvent) => {
    if (e.type === "progress") setRun(key, { at: "running", step: e.step, done: e.done, total: e.total, kept: e.kept, dropped: e.dropped });
    else if (e.type === "done" && e.path) end = { at: "done", path: e.path, grounding: e.grounding };
    else if (e.type === "needsScope") needs = { course: e.course, courseName: e.courseName, exam: e.exam };
    else if (e.type === "error") end = { at: "error", message: plainError(e.message), needs };
    else if (e.type === "cancelled") end = { at: "cancelled" };
  };
  studyChatMake(space, block, question, reply, onEvent).then(
    () => finish(end ?? { at: "error", message: "It stopped before it was made. Try again." }),
    (e: unknown) => finish({ at: "error", message: plainError(e) }),
  );
  function finish(r: Run) {
    setRun(key, r);
    if (r.at === "done") {
      const short = r.grounding && r.grounding.kept < r.grounding.asked ? ` Only ${r.grounding.kept} of ${r.grounding.asked} passed the check against your notes.` : "";
      announce(plan.kind === "quiz" ? `Your quiz is made.${short} Opening it in Study.` : `Your flashcards are made.${short} Opening them in Study.`);
      requestStudy(space, plan.kind === "quiz" ? "take" : "cards", undefined, r.path);
    } else if (r.at === "cancelled") announce("Stopped. Nothing was made.");
  }
}

type Running = Extract<Run, { at: "running" }>;
const noun = (p: StudyPlan) => (p.kind === "quiz" ? "questions" : "cards");
const courseOf = (p: StudyPlan) => p.scope?.courseName ?? (p.sources.length === 1 ? p.sources[0].name : "your course");
/** Each step in plain words; a careful run takes minutes, so each says what it is doing. */
const STEP_WORDS: Record<string, (p: StudyPlan, r: Running) => string> = {
  mapping: (p, r) =>
    `Mapping what ${courseOf(p)} teaches${p.exam ? ` and what ${p.exam} covers` : ""}, from its own materials${r.total > 1 ? ` (part ${Math.min(r.done + 1, r.total)} of ${r.total})` : ""}. This takes a few minutes the first time…`,
  reading: (p) => `Finding the passages that teach each topic${p.exam ? ` in ${p.exam}` : ""}…`,
  making: (p, r) => (r.done === 0 ? `Writing the ${noun(p)} from those passages…` : `Writing replacements for the ${noun(p)} that didn’t pass…`),
  checking: (_p, r) =>
    `Checking each one against your notes${r.total ? ` (${Math.min(r.done, r.total)} of ${r.total})` : ""}: ${r.kept ?? 0} kept, ${r.dropped ?? 0} dropped so far…`,
  saving: (p) => (p.kind === "quiz" ? "Saving the quiz…" : "Saving the cards…"),
};

/** What a kind of thing is called while the block is still arriving. */
const guessKind = (code: string) => (/"kind"\s*:\s*"(deck|flashcards|cards)"/i.test(code) ? "deck" : "quiz");

/**
 * A ```phaethon-study block in a reply, shown as a card instead of code:
 * what will be made, in plain words, and Generate quiz (or Make
 * flashcards). The block is checked by the core (chat.rs); a half-written
 * one says it's still being written, a broken one says so quietly. While
 * the reply is still coming the button waits. Generating shows its steps in
 * words (said politely) with Stop; an error says why with Try again; when it
 * is made, Study opens on it. Afterwards, and after a reload, the card offers
 * Open quiz: the core remembers what each block made.
 */
export function StudyAction({ code }: { code: string }) {
  const space = useContext(SpaceIdContext);
  const complete = useAuiState((s) => s.message.status?.type !== "running");
  const question = useAuiState((s) => questionBefore(s.thread.messages as never, s.message.id));
  const reply = useAuiState((s) =>
    s.message.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n\n"),
  );
  const read = readBlock(code, complete);
  const block = read.state === "ok" ? read.block : null;
  const [plan, setPlan] = useState<StudyPlan | null>(null);
  const [planError, setPlanError] = useState("");
  const [checked, setChecked] = useState(0);
  const titleId = useId();

  useEffect(() => {
    if (!block || !space) return;
    let live = true;
    studyChatPlan(space, block, question).then(
      (p) => {
        if (!live) return;
        setPlan(p);
        setPlanError("");
      },
      (e: unknown) => {
        if (!live) return;
        setPlan(null);
        setPlanError(plainError(e));
      },
    );
    return () => {
      live = false;
    };
  }, [space, block, question, checked]);

  const key = plan ? `${space}\n${plan.origin}` : "";
  const run = useRun(key);
  // Made in another window, or before a reload while it was still running: ask again now and then.
  useEffect(() => {
    if (!plan?.running || run) return;
    const t = setInterval(() => setChecked((n) => n + 1), 3000);
    return () => clearInterval(t);
  }, [plan?.running, run]);

  // Where focus goes as the card changes: to the control that replaced the one pressed.
  const actionRef = useRef<HTMLButtonElement>(null);
  const wantFocus = useRef(false);
  const at = run?.at;
  useLayoutEffect(() => {
    if (wantFocus.current && actionRef.current) {
      actionRef.current.focus();
      wantFocus.current = false;
    }
  }, [at]);
  const press = useCallback(() => {
    if (!plan || !block) return;
    wantFocus.current = true;
    start(space, plan, block, question, reply);
  }, [plan, block, space, question, reply]);
  const stop = useCallback(() => {
    if (!plan) return;
    wantFocus.current = true;
    void studyChatCancel(space, plan.origin);
  }, [plan, space]);

  if (read.state === "invalid") {
    return (
      <p className="my-3 flex items-start gap-2 text-base text-ink-secondary" data-study-action="invalid">
        <Icon name="info" className="mt-0.5" />
        <span className="min-w-0 wrap-break-word">{read.why} Ask again if you’d like a quiz or flashcards made.</span>
      </p>
    );
  }
  if (planError) {
    return (
      <p className="my-3 flex items-start gap-2 text-base text-ink-secondary" data-study-action="unusable">
        <Icon name="info" className="mt-0.5" />
        <span className="min-w-0 wrap-break-word">{planError}</span>
      </p>
    );
  }

  const kind = plan?.kind ?? (read.state === "ok" ? read.kind : guessKind(code));
  const made = run?.at === "done" ? run.path : plan?.made;
  const busy = run?.at === "running" || (!run && plan?.running);
  const label = plan ? planTitle(plan) : kind === "quiz" ? "Practice quiz" : "Flashcards";

  let status = "";
  if (read.state === "writing") status = "Still writing the plan…";
  else if (!plan) status = "Checking the plan…";
  else if (run?.at === "running") status = (STEP_WORDS[run.step] ?? (() => "Starting…"))(plan, run);
  else if (busy) status = "Being made. It opens in Study when it’s ready.";
  else if (made) status = kind === "quiz" ? "Made. It’s in Study with your quizzes." : "Made. They’re in Study with your decks.";
  else if (run?.at === "cancelled") status = "Stopped. Nothing was made.";

  return (
    <section
      aria-labelledby={titleId}
      className="my-4 flex max-w-(--ph-measure) flex-col gap-3 rounded-xl border border-line bg-raised px-4 py-3.5 shadow-sm forced-colors:border-[CanvasText]"
      data-study-action={read.state === "writing" ? "writing" : !plan ? "checking" : run?.at ?? (made ? "made" : busy ? "running" : "ready")}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-(--ph-control-height) shrink-0 place-items-center rounded-full bg-accent-soft text-accent-soft-ink forced-colors:border forced-colors:border-[CanvasText]">
          <Icon name="book" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-sm font-medium text-ink-secondary">{kind === "quiz" ? "A quiz to make" : "Flashcards to make"}</p>
          <h3 id={titleId} className="text-md font-semibold wrap-break-word text-ink" data-study-action-title="">
            {mathAsText(label)}
          </h3>
          {plan && (
            <p className="text-base wrap-break-word text-ink" data-study-action-summary="">
              {planSentence(plan)}
            </p>
          )}
          {plan && plan.unknown.length > 0 && (
            <p className="text-sm wrap-break-word text-ink-secondary" data-study-action-unknown="">
              Not in this space, so left out: {plan.unknown.join(", ")}.
            </p>
          )}
          {plan?.notes.map((n) => (
            <p key={n} className="text-sm wrap-break-word text-ink-secondary">
              {n}
            </p>
          ))}
          {plan?.scope && <PlanScopeLine space={space} scope={plan.scope} />}
          {run?.at === "done" &&
            run.grounding?.notes?.map((n) => (
              <p key={n} className="flex items-start gap-2 text-sm wrap-break-word text-ink" data-study-action-note="">
                <Icon name="info" className="mt-0.5 shrink-0 text-warning-ink" />
                <span className="min-w-0">{n}</span>
              </p>
            ))}
        </div>
      </div>

      {/* Writing and checking are only shown; what happens after a press is also said. */}
      {(read.state === "writing" || !plan) && (
        <p className="flex items-center gap-2 text-base text-ink-secondary" data-study-action-status="">
          <Icon name="spinner" className="animate-spin" />
          {status}
        </p>
      )}
      <p role="status" className="flex items-center gap-2 text-base text-ink-secondary empty:hidden" data-study-action-live="">
        {plan && busy && <Icon name="spinner" className="animate-spin" />}
        {plan ? status : ""}
      </p>

      {run?.at === "error" && (
        <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-soft px-3 py-2.5 text-base text-ink" data-study-action-error="">
          <Icon name="error" className="mt-0.5 shrink-0 text-danger-ink" />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="wrap-break-word">
              {kind === "quiz" ? "The quiz couldn’t be made." : "The flashcards couldn’t be made."} {run.message}
            </p>
            {needsModel(run.message) && (
              <div>
                <Button type="button" variant="outline" size="sm" onClick={() => openSettings("agent")}>
                  <Icon name="settings" />
                  Open Settings
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
      {run?.at === "error" && run.needs && (
        <ScopeForm
          space={space}
          needs={run.needs}
          onSaved={() => {
            setChecked((n) => n + 1);
            press();
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {made ? (
          <Button
            ref={actionRef}
            type="button"
            onClick={() => requestStudy(space, kind === "quiz" ? "take" : "cards", undefined, made)}
            data-study-action-open=""
          >
            <Icon name="play" />
            {openLabel({ kind })}
          </Button>
        ) : run?.at === "running" ? (
          <Button ref={actionRef} type="button" variant="outline" onClick={stop} data-study-action-stop="">
            <Icon name="stop" />
            Stop
          </Button>
        ) : run?.at === "error" && run.needs ? null : (
          // Waiting on the exam's scope: the form above is the way on, not trying the same again.
          <Button
            ref={actionRef}
            type="button"
            // Waits for the whole reply and a checked plan; never twice at once.
            disabled={!plan || !complete || !!busy}
            onClick={press}
            data-study-action-make=""
          >
            <Icon name={run?.at === "error" ? "retry" : "plus"} />
            {run?.at === "error" ? "Try again" : makeLabel({ kind })}
          </Button>
        )}
      </div>
    </section>
  );
}

/** What the card knows of the exam's scope before anything is made: found (with its evidence), said by the person, not found, or not looked at yet. */
function PlanScopeLine({ space, scope }: { space: string; scope: PlanScope }) {
  return (
    <div className="flex flex-col gap-1" data-study-action-scope={scope.state}>
      <p className="flex items-start gap-2 text-sm wrap-break-word text-ink">
        <Icon name={scope.state === "unknown" ? "warning" : "book"} className={scope.state === "unknown" ? "mt-0.5 shrink-0 text-warning-ink" : "mt-0.5 shrink-0 text-ink-secondary"} />
        <span className="min-w-0">
          {scope.state === "known" ? (
            <>
              <span className="font-semibold">{scope.exam}:</span> {scope.words}
              {scope.fromUser ? " (as you said)" : ""}. Only that is used, and every question is checked against your notes.
            </>
          ) : scope.state === "unknown" ? (
            <>I couldn’t find what {scope.exam} covers in your {scope.courseName} materials. You’ll be asked what it covers before anything is made.</>
          ) : (
            <>Phaethon will first check what {scope.exam} covers in your {scope.courseName} materials, then check every question against your notes.</>
          )}
        </span>
      </p>
      {scope.state === "known" && scope.evidence.length > 0 && (
        <Details summary={scope.fromUser ? "What you said" : "Where this comes from"}>
          <ScopeEvidence space={space} evidence={scope.evidence} />
        </Details>
      )}
    </div>
  );
}

/** The exam's scope wasn't found: say it, and the quiz is made from that. */
function ScopeForm({ space, needs, onSaved }: { space: string; needs: UnknownScope; onSaved: () => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) {
      setProblem(`Say what ${needs.exam} covers, in a few words.`);
      return;
    }
    setSaving(true);
    try {
      await studyScopeState(space, needs.course, needs.exam, text.trim());
      announce(`Saved what ${needs.exam} covers. Making it now.`);
      onSaved();
    } catch (err) {
      setProblem(plainError(err));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={save} noValidate className="flex flex-col gap-1.5" data-scope-form="">
      <label htmlFor={`${id}-scope`} className="text-base font-medium text-ink">
        What does {needs.exam} cover?
      </label>
      <p id={`${id}-hint`} className="text-sm text-ink-secondary">
        As your instructor said it, for example “through HW 6, not graphs or combinatorics”. It’s kept for {needs.courseName} and shown as yours.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={ref}
          id={`${id}-scope`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setProblem("");
          }}
          aria-describedby={`${id}-hint${problem ? ` ${id}-problem` : ""}`}
          aria-invalid={!!problem || undefined}
          className="max-w-md min-w-0 flex-1"
        />
        <Button type="submit" disabled={saving} data-scope-save="">
          {saving ? <Icon name="spinner" className="animate-spin" /> : <Icon name="check" />}
          Save and make it
        </Button>
      </div>
      {problem && (
        <p id={`${id}-problem`} className="text-sm text-danger-ink">
          {problem}
        </p>
      )}
    </form>
  );
}

/** For the markdown renderer: the block's language, drawn as the card with no code header. */
const NoHeader = () => null;
export const STUDY_ACTION_LANGUAGES = {
  [STUDY_FENCE]: { CodeHeader: NoHeader, SyntaxHighlighter: StudyAction },
};
