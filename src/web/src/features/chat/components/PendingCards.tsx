import { Path } from "@phosphor-icons/react";
import { CircleHelpIcon, FilePenIcon, KeyRoundIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { AccessAnswer, LessonAnswer, UiRecord } from "#shared/agent.ts";
import { useNav } from "@/app/store";
import { toast } from "@/components/toast";
import { StartTruncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { diffCounts, diffLines, foldDiff } from "../lib/diff";
import type { PendingAccess, PendingApproval, PendingQuestion } from "../lib/timeline";

/** The frame every "needs you" card shares: an icon, a title line, a body, actions at the bottom right. */
function Card({ icon, title, meta, children, actions, tone = "default" }: { icon: React.ReactNode; title: React.ReactNode; meta?: React.ReactNode; children?: React.ReactNode; actions?: React.ReactNode; tone?: "default" | "attention" }) {
  return (
    <div className={cn("my-3 overflow-hidden rounded-xl border bg-card", tone === "attention" && "border-primary/30")}>
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span>
        <div className="min-w-0 flex-1 truncate font-medium text-sm">{title}</div>
        {meta ? <div className="shrink-0 text-2xs text-muted-foreground tabular-nums">{meta}</div> : null}
      </div>
      {children ? <div className="px-3 py-2.5">{children}</div> : null}
      {actions ? <div className="flex items-center justify-end gap-1.5 border-t bg-muted/40 px-3 py-2">{actions}</div> : null}
    </div>
  );
}

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = (which: string, f: () => Promise<unknown>, failed: string) => {
    setBusy(which);
    f().catch((e) => toast.error(failed, errorText(e))).finally(() => setBusy(null));
  };
  return [busy, run] as const;
}

export function ApprovalCard({ approval, onAnswer }: { approval: PendingApproval; onAnswer: (allow: boolean) => Promise<void> }) {
  const [busy, run] = useBusy();
  const lines = useMemo(() => diffLines(approval.before ?? "", approval.detail), [approval.before, approval.detail]);
  const rows = useMemo(() => foldDiff(lines), [lines]);
  const counts = diffCounts(lines);
  return (
    <Card
      tone="attention"
      icon={<FilePenIcon strokeWidth={1.75} />}
      title={<span className="flex min-w-0 items-center gap-1.5">{approval.action === "create" ? "Create" : "Change"} <StartTruncate value={approval.path} className="font-mono text-xs font-normal text-muted-foreground" /></span>}
      meta={
        <span>
          <span className="text-success-foreground">+{counts.added}</span> <span className="text-error-foreground">−{counts.removed}</span>
        </span>
      }
      actions={
        <>
          <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => run("deny", () => onAnswer(false), "Couldn’t send your answer")}>
            {busy === "deny" ? <Spinner size="xs" /> : null}
            Don’t allow
          </Button>
          <Button size="xs" disabled={!!busy} onClick={() => run("allow", () => onAnswer(true), "Couldn’t send your answer")}>
            {busy === "allow" ? <Spinner size="xs" /> : null}
            {approval.action === "create" ? "Create file" : "Apply change"}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-muted-foreground text-xs [overflow-wrap:anywhere]">{approval.summary}</p>
      <div className="max-h-64 overflow-auto rounded-md border bg-code font-mono text-2xs leading-[1.1rem]">
        {rows.map((r, i) =>
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
        {approval.truncated ? <div className="px-2 py-1 text-muted-foreground">The file is long; only the start is shown.</div> : null}
      </div>
    </Card>
  );
}

export function AccessCard({ access, spaceName, onAnswer }: { access: PendingAccess; spaceName: (id: string) => string; onAnswer: (a: AccessAnswer) => Promise<void> }) {
  const [busy, run] = useBusy();
  const where = access.path.replace(/\/+$/, "") ? `${spaceName(access.space)} / ${access.path}` : `all of ${spaceName(access.space)}`;
  return (
    <Card
      tone="attention"
      icon={<KeyRoundIcon strokeWidth={1.75} />}
      title={<span className="flex min-w-0 items-center gap-1">Read from <StartTruncate value={where} className="font-normal" /></span>}
      actions={
        <>
          <Button size="xs" variant="ghost" disabled={!!busy} onClick={() => run("deny", () => onAnswer("deny"), "Couldn’t send your answer")}>
            Don’t allow
          </Button>
          <Button size="xs" variant="outline" disabled={!!busy} onClick={() => run("once", () => onAnswer("once"), "Couldn’t send your answer")}>
            {busy === "once" ? <Spinner size="xs" /> : null}
            Allow once
          </Button>
          <Button size="xs" disabled={!!busy} onClick={() => run("always", () => onAnswer("always"), "Couldn’t send your answer")}>
            {busy === "always" ? <Spinner size="xs" /> : null}
            Always allow
          </Button>
        </>
      }
    >
      <p className="text-muted-foreground text-xs [overflow-wrap:anywhere]">{access.reason}</p>
    </Card>
  );
}

const CONFIDENCE = [
  { value: 25, label: "Guessing" },
  { value: 50, label: "Unsure" },
  { value: 75, label: "Fairly sure" },
  { value: 100, label: "Certain" },
];

export function QuestionCard({ question, disabled, onAnswer }: { question: PendingQuestion; disabled: boolean; onAnswer: (a: LessonAnswer) => Promise<void> }) {
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
      <p className="mb-2.5 text-base [overflow-wrap:anywhere]">{q.question}</p>
      {check ? (
        <div className="flex flex-col gap-1">
          {check.options.map((o) => {
            const on = chosen.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => setChosen((c) => (check.multiSelect ? (on ? c.filter((x) => x !== o.value) : [...c, o.value]) : [o.value]))}
                className={cn("flex items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left text-sm transition-colors hover:bg-accent", on && "border-primary/50 bg-primary/6")}
              >
                <span className={cn("mt-0.5 flex size-3.5 shrink-0 items-center justify-center border", check.multiSelect ? "rounded-[3px]" : "rounded-full", on ? "border-primary bg-primary" : "border-input")}>
                  {on ? <span className={cn("bg-primary-foreground", check.multiSelect ? "h-1.5 w-1.5 rounded-[1px]" : "size-1.5 rounded-full")} /> : null}
                </span>
                <span className="min-w-0 [overflow-wrap:anywhere]">{o.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="In your own words…" className="min-h-20" disabled={disabled} />
      )}
      <div className="mt-2.5 flex items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">How sure?</span>
        {CONFIDENCE.map((c) => (
          <button key={c.value} type="button" onClick={() => setConfidence(c.value === confidence ? null : c.value)} className={cn("h-6 rounded-md border px-2 text-xs transition-colors hover:bg-accent", confidence === c.value && "border-primary/50 bg-primary/6 text-foreground")}>
            {c.label}
          </button>
        ))}
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
