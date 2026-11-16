import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessAnswer, LessonAnswer, UiRecord } from "#shared/agent.ts";
import { useViewActive } from "@/app/Header";
import { useNav } from "@/app/store";
import { toast } from "@/components/toast";
import { StartTruncate } from "@/components/truncate";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Button } from "@/components/ui/button";
import { Card as Surface } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Toggle, ToggleGroup } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { KeyAction, KeyActions } from "@/components/ui/key-actions";
import { Step, StepList } from "@/components/ui/step-list";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import type { Remember } from "../api";
import { diffCounts, diffLines, foldDiff } from "../lib/diff";
import { useChats } from "../store";
import { Markdown } from "./Markdown";
import { isLifeRecord, LifeRecordView } from "./LifeCards";
import type { PendingAccess, PendingApproval, PendingQuestion } from "../lib/timeline";

/**
 * The frame every "needs you" card shares (ref d706): a white card, a blue
 * status line on top ("Ready to change week6.md"), the body in a grey well,
 * and the keyed choices underneath ("Y Apply change · N Don't allow").
 */
function Card({ icon, disc = true, title, meta, children, keys, footer, cardRef }: { icon: IconData; disc?: boolean; title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; keys?: React.ReactNode; footer?: React.ReactNode; cardRef?: React.Ref<HTMLDivElement> }) {
  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 6, scale: 0.99 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", stiffness: 460, damping: 36 }}
      className="my-3"
      data-slot="pending-card"
    >
      <Surface className="gap-4 p-4">
        <div className="flex min-w-0 items-center gap-2.5 px-2 pt-0.5">
          {/* The references' filled blue disc with a white glyph (d706 "Draft is Ready", "Escalated"). */}
          {disc ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Icon icon={icon} className="size-3" />
            </span>
          ) : (
            <Icon icon={icon} className="size-5 text-primary" />
          )}
          <div className="min-w-0 flex-1 truncate text-base text-primary">{title}</div>
          {meta ? <div className="shrink-0 text-muted-foreground text-xs tabular-nums">{meta}</div> : null}
        </div>
        {children}
        {keys ? <KeyActions>{keys}</KeyActions> : null}
        {footer}
      </Surface>
    </motion.div>
  );
}

/** The grey inset that holds what is being asked about. */
function Well({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 rounded-xl border border-border/70 bg-well p-4", className)}>{children}</div>;
}

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = (which: string, f: () => Promise<unknown>, failed: string) => {
    if (busy) return;
    setBusy(which);
    f().catch((e) => toast.error(failed, errorText(e))).finally(() => setBusy(null));
  };
  return [busy, run] as const;
}

/** Whether a key press belongs to a text field. Anything typed into a field, the composer included, is never an answer. */
const typing = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

/** The chat composer while it has focus and nothing in it: a new card may take focus from it. */
const emptyComposer = (el: Element | null) => el instanceof HTMLTextAreaElement && el.dataset.slot === "composer-input" && el.value === "";

/**
 * Single keys answer the card on screen (Y, N, …) unless the person is typing
 * somewhere. The newest card owns the keys; the card takes focus when nothing
 * else has it (an empty composer counts), so Enter and Escape work too. Any
 * other key typed while the card has focus goes to the composer.
 */
function useAnswerKeys(keys: Record<string, () => void>, box: React.RefObject<HTMLDivElement | null>) {
  const latest = useRef(keys);
  latest.current = keys;
  // The chat stays mounted behind other pages; a card there must not answer keys pressed on them.
  const active = useViewActive();
  useEffect(() => {
    if (!active) return;
    const a = document.activeElement;
    if (!a || a === document.body || emptyComposer(a)) box.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || typing(document.activeElement)) return;
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      const key = e.key.toLowerCase();
      const f = latest.current[key];
      if (!f) return;
      // Enter and Escape mean something to whatever has focus; they answer only when the card has it (or nothing does).
      const focus = document.activeElement;
      if ((key === "enter" || key === "escape") && focus && focus !== document.body && !box.current?.contains(focus)) return;
      e.preventDefault();
      f();
    };
    // Capture, so the card answers before the composer pulls the key in as text.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [box, active]);
}

function Key({ k }: { k: string }) {
  return <Kbd className="-mr-0.5">{k}</Kbd>;
}

/** A keyed choice's label, with the spinner while that answer is being sent. */
function Choice({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {children}
      {busy ? <Spinner size="sm" className="text-muted-foreground" /> : null}
    </span>
  );
}

const DIFF_FOLDED = 8;

export function ApprovalCard({ approval, onAnswer }: { approval: PendingApproval; onAnswer: (allow: boolean) => Promise<void> }) {
  const [busy, run] = useBusy();
  const [showAll, setShowAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const spaceName = useNav((s) => s.spaces.data?.find((x) => x.id === approval.space)?.name ?? "this space");
  const lines = useMemo(() => diffLines(approval.before ?? "", approval.detail), [approval.before, approval.detail]);
  const rows = useMemo(() => foldDiff(lines), [lines]);
  const counts = diffCounts(lines);
  const failed = "Couldn’t send your answer";
  const verb = approval.action === "create" ? "create" : "change";
  const allow = () => run("allow", () => onAnswer(true), failed);
  const deny = () => run("deny", () => onAnswer(false), failed);
  // Remembering is answered through the store, which saves it with the answer (core: agent_approve `remember`).
  const remember = (scope: Remember) => run(scope, () => useChats.getState().approve(approval.space, approval.id, true, scope), failed);
  useAnswerKeys({ y: allow, enter: allow, n: deny, escape: deny, c: () => remember("conversation"), s: () => remember("space") }, box);
  const long = rows.length > DIFF_FOLDED;
  const visible = long && !showAll ? rows.slice(0, DIFF_FOLDED) : rows;
  return (
    <Card
      cardRef={box}
      icon={icons.check}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Ready to {verb}</span>
          <StartTruncate value={approval.path} />
        </span>
      }
      meta={
        <span>
          <span className="text-success-foreground">+{counts.added}</span> <span className="text-error-foreground">−{counts.removed}</span>
        </span>
      }
      keys={
        <>
          <KeyAction shortcut="Y" data-primary="" disabled={!!busy} onClick={allow}>
            <Choice busy={busy === "allow"}>{approval.action === "create" ? "Create file" : "Apply change"}</Choice>
          </KeyAction>
          <KeyAction shortcut="N" disabled={!!busy} onClick={deny}>
            <Choice busy={busy === "deny"}>Don’t allow</Choice>
          </KeyAction>
        </>
      }
    >
      <Well>
        <div className="-mx-2 max-h-64 overflow-auto font-mono text-xs leading-5">
          {visible.map((r, i) =>
            r.kind === "fold" ? (
              <div key={i} className="bg-muted/60 px-2 text-muted-foreground">
                ⋯ {r.count} unchanged {r.count === 1 ? "line" : "lines"}
              </div>
            ) : (
              <div key={i} className={cn("whitespace-pre px-2", r.kind === "added" && "bg-success/10 text-success-foreground", r.kind === "removed" && "bg-error/10 text-error-foreground")}>
                <span className="mr-2 inline-block w-2 select-none opacity-60">{r.kind === "added" ? "+" : r.kind === "removed" ? "−" : " "}</span>
                {r.text || " "}
              </div>
            ),
          )}
          {long ? (
            <button type="button" onClick={() => setShowAll((v) => !v)} className="w-full px-2 py-1 text-left font-sans text-muted-foreground hover:bg-accent hover:text-foreground">
              {showAll ? "Show less" : `Show all ${rows.length} lines`}
            </button>
          ) : null}
          {approval.truncated ? <div className="px-2 py-1 font-sans text-muted-foreground">The file is long; only the start is shown.</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger render={<Button size="xs" shape="rect" variant="outline" disabled={!!busy} pending={busy === "conversation"} onClick={() => remember("conversation")} />}>
              Allow in this chat
              <Key k="C" />
            </TooltipTrigger>
            <TooltipPopup>This conversation writes files in {spaceName} without asking again</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button size="xs" shape="rect" variant="outline" disabled={!!busy} pending={busy === "space"} onClick={() => remember("space")} />}>
              Always in {spaceName}
              <Key k="S" />
            </TooltipTrigger>
            <TooltipPopup>Every conversation writes files in {spaceName} without asking. Never outside it. Take it back in Settings › Spaces</TooltipPopup>
          </Tooltip>
        </div>
      </Well>
    </Card>
  );
}

export function AccessCard({ access, spaceName, onAnswer }: { access: PendingAccess; spaceName: (id: string) => string; onAnswer: (a: AccessAnswer) => Promise<void> }) {
  const [busy, run] = useBusy();
  const box = useRef<HTMLDivElement>(null);
  const where = access.path.replace(/\/+$/, "") ? `${spaceName(access.space)} / ${access.path}` : `all of ${spaceName(access.space)}`;
  const failed = "Couldn’t send your answer";
  const answer = (a: AccessAnswer) => run(a, () => onAnswer(a), failed);
  useAnswerKeys({ y: () => answer("once"), enter: () => answer("once"), a: () => answer("always"), n: () => answer("deny"), escape: () => answer("deny") }, box);
  return (
    <Card
      cardRef={box}
      icon={icons.key}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">Wants to read</span>
          <StartTruncate value={where} />
        </span>
      }
      meta="Read only"
      keys={
        <>
          <KeyAction shortcut="Y" data-primary="" disabled={!!busy} onClick={() => answer("once")}>
            <Choice busy={busy === "once"}>Allow once</Choice>
          </KeyAction>
          <KeyAction shortcut="A" disabled={!!busy} onClick={() => answer("always")}>
            <Choice busy={busy === "always"}>Always allow</Choice>
          </KeyAction>
          <KeyAction shortcut="N" disabled={!!busy} onClick={() => answer("deny")}>
            <Choice busy={busy === "deny"}>Don’t allow</Choice>
          </KeyAction>
        </>
      }
    >
      {access.reason ? (
        <Well>
          <p className="text-base wrap-anywhere">{access.reason}</p>
        </Well>
      ) : null}
    </Card>
  );
}

/** A choice row: the whole row picks, the control shows the state. */
const OPTION = "flex cursor-default items-start gap-3 rounded-xl border bg-card px-3 py-2.5 text-left text-base transition-colors hover:bg-accent has-data-checked:border-primary/50 has-data-checked:bg-primary/6";

const CONFIDENCE = [
  { value: 25, label: "Guessing" },
  { value: 50, label: "Unsure" },
  { value: 75, label: "Fairly sure" },
  { value: 100, label: "Certain" },
];

export function QuestionCard({ question, space, disabled, onAnswer }: { question: PendingQuestion; space: string; disabled: boolean; onAnswer: (a: LessonAnswer) => Promise<void> }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [confidence, setConfidence] = useState<number | null>(null);
  const [busy, run] = useBusy();
  const q = question.question;
  const check = question.kind === "check" ? question.question : null;
  const role = check?.role === "probe" ? "Before we start" : check?.role === "predict" ? "Predict" : question.kind === "explainBack" ? "Explain it back" : "Check";
  const ready = check ? chosen.length > 0 : text.trim().length > 0;
  const submit = (answer: LessonAnswer) => run("send", () => onAnswer(answer), "Couldn’t send your answer");
  return (
    <Card
      icon={icons.help}
      disc={false}
      title={role}
      meta={check?.multiSelect ? "Choose all that apply" : null}
      footer={
        <div className="flex flex-wrap items-center gap-2 border-t px-2 pt-3">
          <span className="text-muted-foreground text-sm">How sure?</span>
          <ToggleGroup variant="segmented" value={confidence === null ? [] : [String(confidence)]} onValueChange={(v) => setConfidence(v.length ? Number(v[v.length - 1]) : null)}>
            {CONFIDENCE.map((c) => (
              <Toggle key={c.value} value={String(c.value)}>
                {c.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span className="flex-1" />
          <Button size="xs" shape="rect" variant="ghost" disabled={disabled || !!busy} onClick={() => submit({ dontKnow: true })}>
            I don’t know
          </Button>
          <Button size="xs" shape="rect" disabled={disabled || !ready} pending={!!busy} onClick={() => submit(check ? { answers: chosen, confidence: confidence ?? undefined } : { text, confidence: confidence ?? undefined })}>
            Answer
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 px-2">
        <Markdown inline text={q.question} space={space} messageKey={q.id} className="text-base" />
        {check ? (
          check.multiSelect ? (
            <CheckboxGroup value={chosen} onValueChange={(v) => setChosen(v as string[])} disabled={disabled} className="flex flex-col gap-1.5">
              {check.options.map((o) => (
                <label key={o.value} className={OPTION}>
                  <Checkbox value={o.value} className="mt-0.5" />
                  <Markdown inline text={o.label} space={space} messageKey={q.id} className="min-w-0" />
                </label>
              ))}
            </CheckboxGroup>
          ) : (
            <RadioGroup value={chosen[0] ?? null} onValueChange={(v) => setChosen([v as string])} disabled={disabled} className="gap-1.5">
              {check.options.map((o) => (
                <label key={o.value} className={OPTION}>
                  <Radio value={o.value} className="mt-1" />
                  <Markdown inline text={o.label} space={space} messageKey={q.id} className="min-w-0" />
                </label>
              ))}
            </RadioGroup>
          )
        ) : (
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="In your own words…" className="min-h-20" disabled={disabled} />
        )}
        {busy ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm" role="status">
            <Spinner size="sm" /> Sending your answer…
          </p>
        ) : null}
      </div>
    </Card>
  );
}

/** One quiet line in the reply's step column: a glyph in the 20 px gutter, then words. */
function Line({ icon, children }: { icon: IconData; children: React.ReactNode }) {
  return (
    <div className="my-0.5 flex min-h-8 min-w-0 items-center gap-3 text-muted-foreground text-sm">
      <span className="flex w-5 shrink-0 justify-center">
        <Icon icon={icon} className="size-4" />
      </span>
      {children}
    </div>
  );
}

/** Saved records that aren't tool steps: one quiet line each, the lesson plan as a small path. */
export function RecordLine({ record, spaceName, space }: { record: Exclude<UiRecord, { kind: "tool" }>; spaceName: (id: string) => string; space?: string }) {
  const openSettings = useNav((s) => s.openSettings);
  if (isLifeRecord(record)) return space ? <LifeRecordView record={record} space={space} /> : null;
  switch (record.kind) {
    case "lessonPlan":
      return (
        <Surface variant="well" className="my-3 gap-1 px-4 pt-3.5 pb-2">
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Icon icon={icons.path} className="size-4" />
            Lesson plan
          </div>
          <p className="font-medium text-base">{record.goal}</p>
          <StepList>
            {record.nodes.map((n) => (
              <Step key={n.id} state="pending">
                <span className="text-foreground">{n.label}</span>
              </Step>
            ))}
          </StepList>
        </Surface>
      );
    case "check":
      return (
        <Line icon={icons.help}>
          <span className="min-w-0 flex-1 wrap-anywhere">{record.question}</span>
          {record.answered ? (
            <span
              className={cn(
                "shrink-0 rounded-md px-2 py-0.5 font-medium text-xs",
                record.correct === true ? "bg-success/8 text-success-foreground" : record.correct === false ? "bg-error/8 text-error-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {record.correct === true ? "Right" : record.correct === false ? "Not quite" : "Answered"}
            </span>
          ) : null}
        </Line>
      );
    case "approval":
      return (
        <Line icon={record.allowed ? icons.write : icons.blocked}>
          <span className="shrink-0">{record.allowed ? (record.action === "create" ? "Created" : "Changed") : "Not allowed:"}</span>
          <StartTruncate value={record.path} className="font-mono text-xs" />
          {record.auto ? (
            <>
              <span className="shrink-0 text-subtle-foreground">· {record.auto === "space" ? "allowed in this space" : "allowed in this chat"}</span>
              <button type="button" onClick={() => openSettings("spaces")} className="shrink-0 text-primary hover:underline">
                Manage
              </button>
            </>
          ) : null}
        </Line>
      );
    case "access":
      return (
        <Line icon={record.answer === "deny" ? icons.blocked : icons.key}>
          <span className="shrink-0">{record.answer === "deny" ? "Not allowed to read" : record.answer === "always" ? "Always allowed to read" : "Allowed once to read"}</span>
          <StartTruncate value={record.path ? `${spaceName(record.space)} / ${record.path}` : spaceName(record.space)} />
          {record.answer === "always" ? (
            <button type="button" onClick={() => openSettings("spaces")} className="shrink-0 text-primary hover:underline">
              Manage
            </button>
          ) : null}
        </Line>
      );
    case "read":
      return (
        <Line icon={record.tool === "search" ? icons.search : record.tool === "list" ? icons.list : icons.read}>
          <span className="shrink-0">{record.tool === "search" ? "Searched" : record.tool === "list" ? "Listed" : "Read"}</span>
          <StartTruncate value={record.path ? `${spaceName(record.space)} / ${record.path}` : spaceName(record.space)} />
          {record.query ? <span className="min-w-0 truncate">for “{record.query}”</span> : null}
        </Line>
      );
    case "stopped":
    case "progress":
      return null;
  }
}
