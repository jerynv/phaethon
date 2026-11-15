import { Path } from "@phosphor-icons/react";
import { CircleHelpIcon, FilePenIcon, KeyRoundIcon } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AccessAnswer, LessonAnswer, UiRecord } from "#shared/agent.ts";
import { useNav } from "@/app/store";
import { toast } from "@/components/toast";
import { StartTruncate } from "@/components/truncate";
import { CheckboxGroup } from "@base-ui/react/checkbox-group";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Toggle, ToggleGroup } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import type { Remember } from "../api";
import { diffCounts, diffLines, foldDiff } from "../lib/diff";
import { useChats } from "../store";
import { Markdown } from "./Markdown";
import type { PendingAccess, PendingApproval, PendingQuestion } from "../lib/timeline";

/** The frame every "needs you" card shares: an icon, a title line, a body, actions at the bottom right. */
function Card({ icon, title, meta, children, actions, tone = "default", cardRef }: { icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; tone?: "default" | "attention"; cardRef?: React.Ref<HTMLDivElement> }) {
  return (
    <motion.div
      ref={cardRef}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: "easeOut" }}
      className={cn("my-3 overflow-hidden rounded-xl border bg-card", tone === "attention" && "border-warning/40")}
      data-slot="pending-card"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className={cn("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", tone === "attention" ? "text-warning-foreground" : "text-muted-foreground")}>{icon}</span>
        <div className="min-w-0 flex-1 truncate font-medium text-sm">{title}</div>
        {meta ? <div className="shrink-0 text-2xs text-muted-foreground tabular-nums">{meta}</div> : null}
      </div>
      {children ? <div className="px-3 pb-2.5">{children}</div> : null}
      {actions ? <div className="flex flex-wrap items-center justify-end gap-1.5 border-t bg-muted/40 px-3 py-2">{actions}</div> : null}
    </motion.div>
  );
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

const typing = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);

/**
 * Single keys answer the card on screen (Y, N, …) unless the person is typing
 * somewhere. The newest card owns the keys; the card takes focus when nothing
 * else has it, so Enter and Escape work too.
 */
function useAnswerKeys(keys: Record<string, () => void>, box: React.RefObject<HTMLDivElement | null>) {
  const latest = useRef(keys);
  latest.current = keys;
  useEffect(() => {
    if (!typing(document.activeElement) && (document.activeElement === document.body || !document.activeElement)) {
      box.current?.querySelector<HTMLButtonElement>("[data-primary]")?.focus({ preventScroll: true });
    }
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [box]);
}

function Key({ k }: { k: string }) {
  return <Kbd className="ml-0.5 h-4 min-w-4 bg-current/10 text-current">{k}</Kbd>;
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
  const verb = approval.action === "create" ? "Create" : "Change";
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
      tone="attention"
      icon={<FilePenIcon strokeWidth={1.75} />}
      title={
        <span className="flex min-w-0 items-center gap-1.5">
          {verb} <StartTruncate value={approval.path} className="font-mono text-xs font-normal text-muted-foreground" />
        </span>
      }
      meta={
        <span>
          <span className="text-success-foreground">+{counts.added}</span> <span className="text-error-foreground">−{counts.removed}</span>
        </span>
      }
      actions={
        <>
          <Button size="xs" variant="ghost" className="mr-auto" disabled={!!busy} onClick={deny}>
            {busy === "deny" ? <Spinner size="xs" /> : null}
            Don’t allow
            <Key k="N" />
          </Button>
          <Tooltip>
            <TooltipTrigger render={<Button size="xs" variant="outline" disabled={!!busy} onClick={() => remember("conversation")} />}>
              {busy === "conversation" ? <Spinner size="xs" /> : null}
              Allow in this chat
              <Key k="C" />
            </TooltipTrigger>
            <TooltipPopup>This conversation writes files in {spaceName} without asking again</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button size="xs" variant="outline" disabled={!!busy} onClick={() => remember("space")} />}>
              {busy === "space" ? <Spinner size="xs" /> : null}
              Always in {spaceName}
              <Key k="S" />
            </TooltipTrigger>
            <TooltipPopup>Every conversation writes files in {spaceName} without asking. Never outside it. Take it back in Settings › Spaces</TooltipPopup>
          </Tooltip>
          <Button size="xs" data-primary="" disabled={!!busy} onClick={allow}>
            {busy === "allow" ? <Spinner size="xs" /> : null}
            {approval.action === "create" ? "Create file" : "Apply change"}
            <Key k="Y" />
          </Button>
        </>
      }
    >
      {approval.summary ? <p className="mb-2 text-muted-foreground text-xs [overflow-wrap:anywhere]">{approval.summary}</p> : null}
      <div className="max-h-64 overflow-auto rounded-md border bg-code font-mono text-2xs leading-[1.1rem]">
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
      tone="attention"
      icon={<KeyRoundIcon strokeWidth={1.75} />}
      title={
        <span className="flex min-w-0 items-center gap-1">
          Read from <StartTruncate value={where} className="font-normal" />
        </span>
      }
      meta="Read only"
      actions={
        <>
          <Button size="xs" variant="ghost" className="mr-auto" disabled={!!busy} onClick={() => answer("deny")}>
            {busy === "deny" ? <Spinner size="xs" /> : null}
            Don’t allow
            <Key k="N" />
          </Button>
          <Button size="xs" variant="outline" disabled={!!busy} onClick={() => answer("always")}>
            {busy === "always" ? <Spinner size="xs" /> : null}
            Always allow
            <Key k="A" />
          </Button>
          <Button size="xs" data-primary="" disabled={!!busy} onClick={() => answer("once")}>
            {busy === "once" ? <Spinner size="xs" /> : null}
            Allow once
            <Key k="Y" />
          </Button>
        </>
      }
    >
      {access.reason ? <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{access.reason}</p> : null}
    </Card>
  );
}

/** A choice row: the whole row picks, the control shows the state. */
const OPTION = "flex cursor-default items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent has-data-checked:border-primary/50 has-data-checked:bg-primary/6";

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
      tone="attention"
      icon={<CircleHelpIcon strokeWidth={1.75} />}
      title={role}
      meta={check?.multiSelect ? "Choose all that apply" : null}
      actions={
        <>
          <Button size="xs" variant="ghost" disabled={disabled || !!busy} onClick={() => submit({ dontKnow: true })}>
            I don’t know
          </Button>
          <Button size="xs" disabled={disabled || !!busy || !ready} onClick={() => submit(check ? { answers: chosen, confidence: confidence ?? undefined } : { text, confidence: confidence ?? undefined })}>
            {busy ? <Spinner size="xs" /> : null}
            Answer
          </Button>
        </>
      }
    >
      <Markdown inline text={q.question} space={space} messageKey={q.id} className="mb-2.5" />
      {check ? (
        check.multiSelect ? (
          <CheckboxGroup value={chosen} onValueChange={(v) => setChosen(v as string[])} disabled={disabled} className="flex flex-col gap-1">
            {check.options.map((o) => (
              <label key={o.value} className={OPTION}>
                <Checkbox value={o.value} className="mt-0.5" />
                <Markdown inline text={o.label} space={space} messageKey={q.id} className="min-w-0 text-sm" />
              </label>
            ))}
          </CheckboxGroup>
        ) : (
          <RadioGroup value={chosen[0] ?? null} onValueChange={(v) => setChosen([v as string])} disabled={disabled} className="gap-1">
            {check.options.map((o) => (
              <label key={o.value} className={OPTION}>
                <Radio value={o.value} className="mt-0.5" />
                <Markdown inline text={o.label} space={space} messageKey={q.id} className="min-w-0 text-sm" />
              </label>
            ))}
          </RadioGroup>
        )
      ) : (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="In your own words…" className="min-h-20" disabled={disabled} />
      )}
      <div className="mt-2.5 flex items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">How sure?</span>
        <ToggleGroup variant="segmented" value={confidence === null ? [] : [String(confidence)]} onValueChange={(v) => setConfidence(v.length ? Number(v[v.length - 1]) : null)}>
          {CONFIDENCE.map((c) => (
            <Toggle key={c.value} value={String(c.value)}>
              {c.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
    </Card>
  );
}

/** Saved records that aren't tool steps: one quiet line each, the lesson plan as a small map. */
export function RecordLine({ record, spaceName }: { record: Exclude<UiRecord, { kind: "tool" }>; spaceName: (id: string) => string }) {
  const openSettings = useNav((s) => s.openSettings);
  switch (record.kind) {
    case "lessonPlan":
      return (
        <div className="my-3 rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2 font-medium text-sm">
            <Path className="size-4 text-muted-foreground" />
            <span className="min-w-0 truncate">{record.goal}</span>
          </div>
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs">
            {record.nodes.map((n, i) => (
              <li key={n.id} className="flex items-center gap-1">
                {i > 0 ? <span className="text-subtle-foreground">→</span> : null}
                <span className="max-w-48 truncate rounded-md bg-muted px-1.5 py-0.5">{n.label}</span>
              </li>
            ))}
          </ol>
        </div>
      );
    case "check":
      return (
        <div className="my-1.5 flex items-start gap-2 text-muted-foreground text-xs">
          <CircleHelpIcon className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{record.question}</span>
          {record.answered ? <span className={cn("shrink-0 font-medium", record.correct === true ? "text-success-foreground" : record.correct === false ? "text-error-foreground" : "")}>{record.correct === true ? "Right" : record.correct === false ? "Not quite" : "Answered"}</span> : null}
        </div>
      );
    case "approval":
      return (
        <div className="my-1 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <FilePenIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="shrink-0">{record.allowed ? (record.action === "create" ? "Created" : "Changed") : "Not allowed:"}</span>
          <StartTruncate value={record.path} className="font-mono text-2xs" />
          {record.auto ? (
            <>
              <span className="shrink-0 text-subtle-foreground">· {record.auto === "space" ? "allowed in this space" : "allowed in this chat"}</span>
              <button type="button" onClick={() => openSettings("spaces")} className="shrink-0 hover:text-foreground hover:underline">
                Manage
              </button>
            </>
          ) : null}
        </div>
      );
    case "access":
      return (
        <div className="my-1 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <KeyRoundIcon className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span className="shrink-0">{record.answer === "deny" ? "Not allowed to read" : record.answer === "always" ? "Always allowed to read" : "Allowed once to read"}</span>
          <StartTruncate value={record.path ? `${spaceName(record.space)} / ${record.path}` : spaceName(record.space)} />
          {record.answer === "always" ? (
            <button type="button" onClick={() => openSettings("spaces")} className="shrink-0 hover:text-foreground hover:underline">
              Manage
            </button>
          ) : null}
        </div>
      );
    case "read":
      return (
        <div className="my-1 flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
          <span className="shrink-0">{record.tool === "search" ? "Searched" : record.tool === "list" ? "Listed" : "Read"}</span>
          <StartTruncate value={record.path ? `${spaceName(record.space)} / ${record.path}` : spaceName(record.space)} />
          {record.query ? <span className="min-w-0 truncate">for “{record.query}”</span> : null}
        </div>
      );
    case "stopped":
    case "progress":
      return null;
  }
}
