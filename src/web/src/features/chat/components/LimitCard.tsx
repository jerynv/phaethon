import { motion } from "motion/react";
import type { ErrorCode } from "#shared/agent.ts";
import { ClampedText } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { describeAgentError } from "../lib/agent-error";

/** Failures that are about limits, not about the reply: they sit above the composer (ref fd96), not in the timeline. */
const LIMITS = new Set<ErrorCode | "ipc">(["rateLimit", "billing", "unavailable"]);
export const isLimit = (code: ErrorCode | "ipc") => LIMITS.has(code);

const SENTENCE: Partial<Record<ErrorCode, string>> = {
  rateLimit: "The provider is limiting requests to this model. Retry, or pick another model below.",
  billing: "Add credit with the provider, then send again.",
  unavailable: "It usually comes back within a minute.",
};

/**
 * "You've hit the rate limit on this model." A grey card over the composer:
 * the reason in one line, one sentence on what to do, Close and the action.
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
  const view = describeAgentError(code, retryAfterSecs);
  const retry = view.action?.kind === "retry";
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 460, damping: 38 }}
      className="mb-2 flex w-full flex-col gap-1 rounded-card border border-border/70 bg-well px-4 pt-3.5 pb-3"
      data-slot="limit-card"
    >
      <div className="flex items-center gap-2 font-medium text-base">
        <Icon icon={code === "rateLimit" ? icons.time : icons.warning} className="size-4.5 text-warning" />
        <span className="min-w-0 truncate">{view.title}</span>
      </div>
      <p className="text-muted-foreground text-sm">{SENTENCE[code as ErrorCode] ?? "Try again in a moment."}</p>
      <ClampedText text={message} className="text-subtle-foreground text-xs" />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
        {retry ? (
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              <Icon icon={icons.retry} />
              Retry
            </Button>
          ) : null
        ) : view.action ? (
          <Button size="sm" onClick={onSettings}>
            {view.action.label}
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}
