import { useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { answerApproval, type AgentMessageCustom } from "@/runtime/agent-adapter";

/** The space this thread belongs to, for answering approvals. */
export const SpaceIdContext = createContext("");

/** Put focus back in the composer (after an approval, or when Stop disappears). */
export function focusComposer() {
  document.querySelector<HTMLTextAreaElement>("[data-composer-input]")?.focus();
}

/**
 * A write the agent wants to make, waiting for the user. It is an inline,
 * non-modal alertdialog: it takes focus when it appears (it is the direct
 * result of the user's own request, like a dialog), it is not also announced by
 * the status region, and focus goes back to the composer once it is answered.
 *
 * Keyboard: Tab moves through the preview (scrollable with arrow keys),
 * Don't allow and Allow.
 */
export function ApprovalCard() {
  const spaceId = useContext(SpaceIdContext);
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
  const [problem, setProblem] = useState("");

  useEffect(() => {
    if (!approval) return;
    setBusy(false);
    setProblem("");
    ref.current?.focus();
  }, [approval?.id]);

  if (!approval) return null;

  async function answer(allow: boolean) {
    if (!approval) return;
    setBusy(true);
    try {
      const ok = await answerApproval(spaceId, approval.id, allow);
      if (!ok) setProblem("This request is no longer waiting for an answer.");
    } catch (e) {
      setProblem(String(e));
      setBusy(false);
      return;
    }
    focusComposer();
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="flex w-full max-w-(--st-measure) flex-col rounded-lg border border-line-strong bg-raised shadow"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-soft-ink"
        >
          <Icon name="edit" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={titleId} className="text-md font-semibold text-ink">
            steward wants to change a file
          </h3>
          <p id={descId} className="text-base text-ink-secondary">
            {approval.summary} Nothing changes unless you allow it.
          </p>
        </div>
      </div>
      {approval.detail && (
        <div className="flex flex-col gap-1.5 px-4 pb-1">
          <p id={previewId} className="text-sm font-medium text-ink-secondary">
            New contents
          </p>
          <pre
            tabIndex={0}
            aria-labelledby={previewId}
            className="max-h-(--st-preview-max-height) overflow-auto rounded-md border border-line bg-surface-sunken p-3 font-mono text-sm leading-normal whitespace-pre-wrap text-ink"
          >
            {approval.detail}
          </pre>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 px-4 pt-3 pb-4">
        {problem && (
          <p role="alert" className="me-auto flex items-center gap-1.5 text-sm text-danger-ink">
            <Icon name="warning" className="size-(--st-icon-size-sm)" />
            {problem}
          </p>
        )}
        <Button disabled={busy} variant="outline" size="sm" onClick={() => void answer(false)}>
          Don&rsquo;t allow
        </Button>
        <Button disabled={busy} size="sm" onClick={() => void answer(true)}>
          <Icon name="check" className="size-(--st-icon-size-sm)" />
          Allow
        </Button>
      </div>
    </div>
  );
}
