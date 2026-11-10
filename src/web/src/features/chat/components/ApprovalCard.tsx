import { ChevronDownIcon, ChevronUpIcon, FilePenLineIcon, FilePlusIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Toggle, ToggleGroup } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { hueColor, useSpace } from "../context";
import { diffCounts, diffLines, diffSummary, foldDiff, type DiffRow } from "../lib/diff";
import type { PendingApproval } from "../lib/timeline";
import { CardProblem, KeyHint, cardActions, cardKeys, cardShell, useCardArrival } from "./cards";
import { Markdown } from "./Markdown";

type View = "changes" | "formatted" | "plain";
const VIEW_LABEL: Record<View, string> = { changes: "Changes", formatted: "Formatted", plain: "Plain text" };
const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

function viewsFor(a: PendingApproval): View[] {
  const md = isMarkdown(a.path);
  if (a.action === "replace" && a.before !== null) return md ? ["changes", "formatted", "plain"] : ["changes", "plain"];
  return md ? ["formatted", "plain"] : ["plain"];
}

/** Every changed line carries a visible sign and, for screen readers, "Removed" or "Added". */
function DiffView({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="py-1 font-mono text-[0.8125rem] leading-relaxed">
      {rows.map((r, i) =>
        r.kind === "fold" ? (
          <p key={i} className="my-0.5 px-3 font-sans text-xs text-muted-foreground italic">
            {r.count} unchanged line{r.count === 1 ? "" : "s"}
          </p>
        ) : (
          <p
            key={i}
            data-diff={r.kind}
            className={cn(
              "flex pe-3 whitespace-pre-wrap wrap-anywhere",
              r.kind === "removed" && "bg-destructive/10 text-destructive-foreground",
              r.kind === "added" && "bg-success/10 text-success-foreground",
            )}
          >
            <span aria-hidden className="w-7 shrink-0 text-center select-none opacity-70">
              {r.kind === "removed" ? "−" : r.kind === "added" ? "+" : " "}
            </span>
            {r.kind !== "same" && <span className="sr-only">{r.kind === "removed" ? "Removed: " : "Added: "}</span>}
            <span className="min-w-0">{r.text || " "}</span>
          </p>
        ),
      )}
    </div>
  );
}

/** "The new file has 12 lines." from the core's summary, which ends "(12 lines)." */
function sizeLine(summary: string, replacing: boolean): string {
  const m = /\((\d+) lines?\)\.?$/.exec(summary.trim());
  if (!m) return summary;
  const n = Number(m[1]);
  return `${replacing ? "The new version" : "The new file"} has ${n} line${n === 1 ? "" : "s"}.`;
}

/**
 * A write the assistant wants to make, waiting for the person: what file, in
 * which space, created or replaced; the changes (or the new file) to read
 * first; Allow or Don't allow. Nothing changes unless allowed.
 */
export function ApprovalCard({
  approval,
  onAnswer,
  announce,
}: {
  approval: PendingApproval;
  onAnswer: (id: string, allow: boolean) => Promise<string | null>;
  announce: (t: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const previewId = useId();
  const space = useSpace(approval.space);
  const replacing = approval.action === "replace";
  const views = viewsFor(approval);
  const [view, setView] = useState<View>(views[0]);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const diff = useMemo(
    () => (approval.action === "replace" && approval.before !== null ? diffLines(approval.before, approval.detail) : null),
    [approval.action, approval.before, approval.detail],
  );
  useCardArrival(ref, approval.id, announce, `Phaethon wants to ${replacing ? "replace" : "create"} ${approval.path}.`);

  const answer = async (allow: boolean) => {
    if (busy) return;
    setBusy(true);
    const failed = await onAnswer(approval.id, allow);
    if (failed) {
      setProblem(failed);
      ref.current?.focus();
    }
  };

  const shown = views.includes(view) ? view : views[0];
  const counts = diff ? diffCounts(diff) : null;
  const caption =
    shown === "changes" && diff
      ? diffSummary(diff)
      : shown === "formatted"
        ? replacing
          ? "The new version, formatted"
          : "The new file, formatted"
        : replacing
          ? "The new version"
          : "The new file";
  const folded = shown === "changes" && !!diff && !all && foldDiff(diff).some((r) => r.kind === "fold");

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onKeyDown={cardKeys(() => void answer(true), () => void answer(false), busy || !!problem)}
      className={cardShell}
      data-approval-card={approval.action}
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {replacing ? <FilePenLineIcon className="size-4.5" /> : <FilePlusIcon className="size-4.5" />}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            Phaethon wants to {replacing ? "replace a file" : "create a file"} in
            <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
              <span aria-hidden className="size-2 rounded-full" style={{ background: hueColor(space.hue) }} />
              {space.name}
            </span>
          </p>
          <h3 id={titleId} className="text-base font-semibold leading-snug">
            {replacing ? "Replace" : "Create"} <span className="font-mono text-[0.9375rem] wrap-anywhere">{approval.path}</span>
            <span className="sr-only"> in {space.name}</span>
          </h3>
          <p id={descId} className="text-sm text-muted-foreground">
            {sizeLine(approval.summary, replacing)}
            {counts && (counts.added || counts.removed) ? (
              <span aria-hidden className="ms-1.5 font-mono text-xs">
                <span className="text-success-foreground">+{counts.added}</span> <span className="text-destructive-foreground">−{counts.removed}</span>
              </span>
            ) : null}
          </p>
        </div>
      </div>
      {(approval.detail !== "" || diff) && (
        <div className="flex flex-col gap-2 px-4 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={previewId} className="text-sm font-medium text-muted-foreground" aria-hidden>
              {caption}
            </p>
            {views.length > 1 && (
              <ToggleGroup
                aria-label="Show"
                size="sm"
                value={[shown]}
                onValueChange={(v: unknown[]) => v[0] && setView(v[0] as View)}
              >
                {views.map((v) => (
                  <Toggle key={v} value={v} className="min-h-6 px-2">
                    {VIEW_LABEL[v]}
                  </Toggle>
                ))}
              </ToggleGroup>
            )}
          </div>
          <Preview key={`${approval.id}:${shown}:${all}`} labelledBy={previewId} label={caption} all={all}>
            {shown === "changes" && diff ? (
              <DiffView rows={all ? diff : foldDiff(diff)} />
            ) : shown === "formatted" ? (
              <Markdown text={approval.detail} headingShift={3} className="px-4 py-3" />
            ) : (
              <pre className="m-0 px-3 py-2 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap wrap-anywhere">{approval.detail}</pre>
            )}
          </Preview>
          <PreviewToggle all={all} folded={folded} onChange={setAll} />
          {approval.truncated && (
            <p className="flex items-start gap-1.5 text-sm">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
              This file is too long to show in full here, so the preview stops partway. Allow writes the whole file.
            </p>
          )}
        </div>
      )}
      <div className={cardActions}>
        {problem && <CardProblem text={problem} />}
        <Button variant="outline" size="lg" disabled={busy} aria-keyshortcuts="Control+Backspace Meta+Backspace" onClick={() => void answer(false)}>
          Don’t allow
          <KeyHint keyName="⌫" />
        </Button>
        <Button size="lg" disabled={busy} aria-keyshortcuts="Control+Enter Meta+Enter" onClick={() => void answer(true)}>
          Allow
          <KeyHint keyName="↵" />
        </Button>
      </div>
    </div>
  );
}

function Preview({ children, labelledBy, label, all }: { children: React.ReactNode; labelledBy: string; label: string; all: boolean }) {
  return (
    <div
      tabIndex={0}
      role="group"
      aria-labelledby={labelledBy}
      aria-label={label}
      className={cn(
        "overflow-auto rounded-lg border bg-muted/30 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !all && "max-h-[min(18rem,34dvh)]",
      )}
      data-approval-preview=""
    >
      {children}
    </div>
  );
}

function PreviewToggle({ all, folded, onChange }: { all: boolean; folded: boolean; onChange: (v: boolean) => void }) {
  const [more, setMore] = useState(false);
  const probe = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = probe.current?.previousElementSibling as HTMLElement | null;
    if (!el) return;
    const measure = () => setMore(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [all]);
  if (!all && !(more || folded)) return <span ref={probe} hidden />;
  return (
    <>
      <span ref={probe} hidden />
      <Button variant="ghost-muted" size="xs" className="-ms-1.5 self-start" onClick={() => onChange(!all)}>
        {all ? <ChevronUpIcon aria-hidden /> : <ChevronDownIcon aria-hidden />}
        {all ? "Show less" : "Show all"}
      </Button>
    </>
  );
}
