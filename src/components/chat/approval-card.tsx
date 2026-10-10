import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { StaticMarkdown } from "@/components/assistant-ui/elements/markdown-text";
import { modAria } from "@/components/shell/shortcuts";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { findSpace } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { answerApproval, type AgentMessageCustom, type PendingApproval } from "@/runtime/agent-adapter";

import { useCardArrival, useCardKeys } from "./card-arrival";
import { diffLines, diffSummary, foldDiff, type DiffRow } from "./diff";
import { focusPaneComposer, usePane, visibleComposer } from "./pane";

/** The space this thread belongs to, for answering approvals. */
export const SpaceIdContext = createContext("");

/** Put focus back in the composer on screen (after an answer, or when Stop disappears). */
export function focusComposer() {
  visibleComposer()?.focus();
}

type View = "changes" | "formatted" | "plain";
const VIEW_LABEL: Record<View, string> = { changes: "Changes", formatted: "Formatted", plain: "Plain text" };

const isMarkdown = (path: string) => /\.(md|markdown|mdx)$/i.test(path);

/** The views a write offers, the first being the default. */
function viewsFor(a: PendingApproval): View[] {
  const md = isMarkdown(a.path);
  if (a.action === "replace" && a.before !== null) return md ? ["changes", "formatted", "plain"] : ["changes", "plain"];
  return md ? ["formatted", "plain"] : ["plain"];
}

/**
 * A line diff, readable without colour: every changed line carries a visible
 * sign and, for screen readers, the words "Removed" or "Added"; long unchanged
 * stretches fold into "12 unchanged lines" unless everything is shown.
 */
function DiffView({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="font-mono text-sm leading-normal">
      {rows.map((r, i) =>
        r.kind === "fold" ? (
          <p key={i} className="my-1 px-3 font-sans text-ink-secondary italic" data-diff="fold">
            {r.count} unchanged line{r.count === 1 ? "" : "s"}
          </p>
        ) : (
          <p
            key={i}
            data-diff={r.kind}
            className={cn(
              "flex border-s-4 border-transparent pe-3 whitespace-pre-wrap wrap-anywhere",
              r.kind === "removed" && "border-danger bg-danger-soft text-danger-ink",
              r.kind === "added" && "border-success-ink bg-success-soft text-success-ink",
              r.kind === "same" && "text-ink",
            )}
          >
            <span aria-hidden="true" className="w-6 shrink-0 text-center select-none">
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

/**
 * A write the agent wants to make, waiting for the user. It is an inline,
 * non-modal alertdialog. It says whether the file is created or replaced, and
 * in which space (its name and colour mark); a replacement shows what changes
 * (with Removed / Added in words), a Markdown file can be read formatted or as
 * plain text, and "Show all" shows the whole file rather than a cut preview.
 *
 * It takes focus when it appears unless the user is typing in the composer
 * (then it is announced, with the shortcut that goes to it); it is not also
 * announced by the status region, and focus goes back to the composer once
 * answered. Keyboard: Tab moves through the view buttons, the preview
 * (scrollable with arrow keys), Show all, Don't allow and Allow.
 */
export function ApprovalCard() {
  const spaceId = useContext(SpaceIdContext);
  const pane = usePane();
  const approval = useAuiState((s) =>
    s.message.status?.type === "running"
      ? (s.message.metadata.custom as AgentMessageCustom | undefined)?.approval
      : undefined,
  );
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const previewId = useId();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CardProblemState | null>(null);
  const [view, setView] = useState<View>("plain");
  const [all, setAll] = useState(false);

  const space = findSpace(approval?.space || spaceId);
  const replacing = approval?.action === "replace";
  useCardArrival(
    ref,
    approval?.id,
    approval
      ? `Phaethon wants to ${replacing ? "replace" : "create"} ${approval.path || "a file"}${space ? ` in ${space.name}` : ""}.`
      : "",
  );
  useEffect(() => {
    if (!approval) return;
    setBusy(false);
    setProblem(null);
    setView(viewsFor(approval)[0]);
    setAll(false);
  }, [approval?.id]);

  const onKeyDown = useCardKeys({ allow: () => void answer(true), refuse: () => void answer(false), busy: busy || !!problem });

  const diff = useMemo(
    () => (approval?.action === "replace" && approval.before !== null ? diffLines(approval.before, approval.detail) : null),
    [approval?.id],
  );

  if (!approval) return null;
  const views = viewsFor(approval);
  const shown: View = views.includes(view) ? view : views[0];
  const path = approval.path;
  const what = path ? (
    <>
      {replacing ? "Replace" : "Create"} <span className="font-mono wrap-anywhere">{path}</span>
    </>
  ) : (
    "Phaethon wants to change a file"
  );

  async function answer(allow: boolean) {
    if (!approval) return;
    setBusy(true);
    let failed: CardProblemState | null = null;
    try {
      const ok = await answerApproval(spaceId, approval.id, allow);
      if (!ok) failed = { text: "This request has ended. Nothing was changed." };
    } catch (e) {
      failed = { text: ANSWER_NOT_SENT, detail: String(e) };
    }
    if (failed) {
      // The answer can't be given any more: the buttons stay disabled, and
      // focus moves to the card (a disabled button would drop it).
      setProblem(failed);
      ref.current?.focus();
      return;
    }
    focusPaneComposer(pane);
  }

  const caption =
    shown === "changes" && diff
      ? `Changes to ${path || "the file"}: ${diffSummary(diff)}`
      : shown === "formatted"
        ? replacing
          ? "The new version, formatted"
          : "The new file, formatted"
        : replacing
          ? "The new version"
          : "The new file";

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-approval-card=""
      data-action={approval.action}
      data-waiting-card=""
      onKeyDown={onKeyDown}
      className="flex w-full max-w-(--ph-measure) flex-col rounded-lg border border-line-strong bg-raised shadow"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span
          aria-hidden="true"
          className="flex size-(--ph-control-height-lg) shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-ink"
        >
          <Icon name={replacing ? "edit" : "file-text"} />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="flex flex-wrap items-center gap-x-1.5 text-sm text-ink-secondary" data-approval-space="">
            Phaethon wants to {replacing ? "replace a file" : "create a file"} in
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              {space && <SpaceMark hue={space.hue} />}
              {space?.name ?? approval.space}
            </span>
          </p>
          <h3 id={titleId} className="text-md font-semibold text-ink">
            {what}
            {space && <span className="sr-only"> in {space.name}</span>}
          </h3>
          <p id={descId} className="text-base text-ink-secondary">
            {approval.summary} Nothing changes unless you allow it.
          </p>
        </div>
      </div>
      {approval.detail !== "" || diff ? (
        <div className="flex flex-col gap-1.5 px-4 pb-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={previewId} className="text-sm font-medium text-ink-secondary">
              {caption}
            </p>
            {views.length > 1 && (
              <div role="group" aria-label="Show" className="flex flex-wrap gap-1" data-approval-views="">
                {views.map((v) => (
                  <Button
                    key={v}
                    type="button"
                    variant="ghost"
                    size="xs"
                    aria-pressed={shown === v}
                    data-view={v}
                    className="border-line aria-pressed:border-line-strong"
                    onClick={() => setView(v)}
                  >
                    {VIEW_LABEL[v]}
                  </Button>
                ))}
              </div>
            )}
          </div>
          <Preview
            key={`${approval.id}:${shown}:${all}`}
            labelledBy={previewId}
            all={all}
            onShowAll={() => setAll(true)}
            onShowLess={() => setAll(false)}
            folded={shown === "changes" && !!diff && !all && foldDiff(diff).some((r) => r.kind === "fold")}
          >
            {shown === "changes" && diff ? (
              <DiffView rows={all ? diff : foldDiff(diff)} />
            ) : shown === "formatted" ? (
              <StaticMarkdown text={approval.detail} className="max-w-none px-3 py-2" />
            ) : (
              <pre className="px-3 py-2 font-mono text-sm leading-normal whitespace-pre-wrap wrap-anywhere text-ink">
                {approval.detail}
              </pre>
            )}
          </Preview>
          {approval.truncated && (
            <p className="flex items-start gap-1.5 text-sm text-ink" data-approval-truncated="">
              <Icon name="warning" className="mt-px size-(--ph-icon-size-sm) shrink-0 text-warning-ink" />
              This file is too long to show in full here, so the preview stops partway. Allow writes the whole file.
            </p>
          )}
        </div>
      ) : null}
      {/* Sticks to the bottom of the conversation while the card runs past it (a short window,
          large text or targets), so the answer buttons are always in view, never under the composer. */}
      <div className={CARD_ACTIONS} data-card-actions="">
        {problem && <CardProblem problem={problem} className="me-auto" />}
        <Button disabled={busy} variant="outline" size="lg" aria-keyshortcuts={refuseKeys()} onClick={() => void answer(false)}>
          Don&rsquo;t allow
        </Button>
        <Button disabled={busy} size="lg" aria-keyshortcuts={allowKeys()} onClick={() => void answer(true)}>
          <Icon name="check" />
          Allow
        </Button>
      </div>
    </div>
  );
}

/**
 * The preview box: a capped height (so the whole card fits a small window),
 * scrollable from the keyboard, with "Show all" when there is more than fits
 * (or folded lines) and "Show less" after.
 */
function Preview({
  children,
  labelledBy,
  all,
  folded,
  onShowAll,
  onShowLess,
}: {
  children: ReactNode;
  labelledBy: string;
  all: boolean;
  folded: boolean;
  onShowAll: () => void;
  onShowLess: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setMore(el.scrollHeight > el.clientHeight + 1);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return (
    <>
      <div
        ref={box}
        tabIndex={0}
        role="group"
        aria-labelledby={labelledBy}
        data-approval-preview=""
        className={cn(
          "overflow-auto rounded-md border border-line bg-surface-sunken py-1",
          !all && "max-h-[min(var(--ph-preview-max-height),32dvh)]",
        )}
      >
        {children}
      </div>
      {(more || folded) && !all && (
        <Button type="button" variant="ghost" size="sm" className="self-start" data-approval-show-all="" onClick={onShowAll}>
          <Icon name="chevron-down" />
          Show all
        </Button>
      )}
      {all && (
        <Button type="button" variant="ghost" size="sm" className="self-start" data-approval-show-all="" onClick={onShowLess}>
          <Icon name="chevron-up" />
          Show less
        </Button>
      )}
    </>
  );
}

/**
 * A waiting card's answer row: sticky at the bottom of the conversation's
 * scroll area, on the card's own background with a rule above, so while the
 * card is taller than the space it has, its buttons stay in view.
 */
export const CARD_ACTIONS =
  "sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-b-lg border-t border-line bg-raised px-4 pt-3 pb-4";

/** aria-keyshortcuts for a card's yes and no (Cmd+Enter, Cmd+Backspace). */
export const allowKeys = () => `${modAria()}+Enter`;
export const refuseKeys = () => `${modAria()}+Backspace`;

export type CardProblemState = { text: string; detail?: string };

/** When an answer could not be delivered (the IPC call failed). */
export const ANSWER_NOT_SENT =
  "Your answer couldn’t be sent, so nothing was changed. Stop the reply, then send your message again.";

/** Why a card's answer didn't take, in plain words; the raw error folded under Details. */
export function CardProblem({ problem, className }: { problem: CardProblemState; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 text-sm", className)}>
      <p role="alert" className="flex items-start gap-1.5 text-danger-ink">
        <Icon name="warning" className="mt-px size-(--ph-icon-size-sm) shrink-0" />
        {problem.text}
      </p>
      {problem.detail && (
        <Details className="ms-[calc(var(--ph-icon-size-sm)+var(--ph-space)*1.5)]">
          <p className="font-mono wrap-anywhere text-ink">{problem.detail}</p>
        </Details>
      )}
    </div>
  );
}
