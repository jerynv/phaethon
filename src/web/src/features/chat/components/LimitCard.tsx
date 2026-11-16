import { motion } from "motion/react";
import { LiveFigures } from "@/components/live-figures";
import { useState } from "react";
import type { ErrorCode } from "#shared/agent.ts";
import { ClampedText } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { usePrefs } from "@/features/settings/prefs";
import { describeAgentError } from "../lib/agent-error";
import { useNow } from "./WorkGroup";

/** Failures that are about limits, not about the reply: they sit above the composer (ref fd96), not in the timeline. */
const LIMITS = new Set<ErrorCode | "ipc">(["rateLimit", "billing", "unavailable"]);
export const isLimit = (code: ErrorCode | "ipc") => LIMITS.has(code);

const SENTENCE: Partial<Record<ErrorCode, string>> = {
  rateLimit: "The provider is limiting requests to this model. Retry, or pick another model below.",
  billing: "Add credit with the provider, then send again.",
  unavailable: "It usually comes back within a minute.",
};

/**
 * "You've hit the rate limit on this model." A grey card tucked under the
 * composer's top edge (ref fd96): the reason in one line, one sentence on what
 * to do, Close and the action. A rate limit with a wait counts it down and
 * holds Retry until it is over. The provider's raw message shows only with
 * Settings › Show technical details.
 */
export function LimitCard({
  code,
  message,
  retryAfterSecs,
  onRetry,
  onSettings,
  onClose,
}: {
  code: ErrorCode | "ipc";
  message: string;
  retryAfterSecs?: number;
  onRetry?: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  // The card mounts when the error arrives, so the wait counts from then.
  const [since] = useState(() => Date.now());
  const waiting = !!retryAfterSecs && Date.now() - since < retryAfterSecs * 1000;
  const now = useNow(waiting);
  const remaining = retryAfterSecs ? Math.max(0, Math.ceil(retryAfterSecs - (now - since) / 1000)) : 0;
  const technical = usePrefs((s) => s.technicalDetails);
  const view = describeAgentError(code, remaining || undefined);
  const title = code === "rateLimit" && retryAfterSecs && !remaining ? "Rate limited · you can retry now" : view.title;
  const retry = view.action?.kind === "retry";
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 460, damping: 38 }}
      className="-mb-4 flex w-full flex-col gap-1 rounded-card rounded-b-none border border-border/70 border-b-0 bg-well px-4 pt-3.5 pb-7"
      data-slot="limit-card"
    >
      <div className="flex items-center gap-2 text-base">
        <Icon icon={code === "rateLimit" ? icons.time : icons.warning} className="size-4.5 text-foreground" />
        <span className="min-w-0 truncate" aria-live="polite">
          <LiveFigures text={title} />
        </span>
      </div>
      <p className="text-muted-foreground text-sm">{SENTENCE[code as ErrorCode] ?? "Try again in a moment."}</p>
      {technical ? <ClampedText text={message} className="font-mono text-subtle-foreground text-xs" /> : null}
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button size="xs" shape="rect" variant="outline" onClick={onClose}>
          Close
        </Button>
        {retry ? (
          onRetry ? (
            <Button size="xs" shape="rect" disabled={remaining > 0} onClick={onRetry}>
              <Icon icon={icons.retry} />
              Retry
            </Button>
          ) : null
        ) : view.action ? (
          <Button size="xs" shape="rect" onClick={onSettings}>
            {view.action.label}
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}
