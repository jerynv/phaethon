import { useAuiState } from "@assistant-ui/react";

import type { AgentMessageCustom } from "@/runtime/agent-adapter";

/**
 * "2:41 PM" today, "Yesterday 2:41 PM", "Monday 2:41 PM" within the week, "Oct 3, 2:41 PM"
 * (with the year when it isn't this one) before that.
 */
export function shortTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOf = (t: number) => new Date(new Date(t).toDateString()).getTime();
  const days = Math.round((startOf(now) - startOf(ms)) / 86400000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${d.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" })}, ${time}`;
}

/** "Friday, October 10, 2026 at 2:41 PM": the whole date, for the tooltip and screen readers. */
export function fullTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" });
}

/**
 * When a message was sent, or a reply finished: quiet, after the message, so a screen reader
 * reaches it after the text ("Sent Friday, October 10, 2026 at 2:41 PM"), never before.
 * Saved messages carry the saved time (none for ones saved before times were kept); a message
 * sent in this session uses its own. Nothing while a reply is still running.
 */
export function MessageTime({ role }: { role: "user" | "assistant" }) {
  const at = useAuiState((s) => {
    const custom = s.message.metadata.custom as AgentMessageCustom | undefined;
    if (custom?.at) return custom.at;
    // Loaded from disk without a time (it carries a saved index): unknown, not "now".
    if (custom?.index !== undefined || role === "assistant") return undefined;
    return s.message.createdAt?.getTime();
  });
  const running = useAuiState((s) => s.message.status?.type === "running");
  if (!at || running) return null;
  const full = fullTime(at);
  return (
    <p className="text-xs text-ink-secondary" data-message-time="">
      <time dateTime={new Date(at).toISOString()} title={full}>
        <span aria-hidden="true">{shortTime(at)}</span>
        <span className="sr-only">{`${role === "user" ? "Sent" : "Finished"} ${full}`}</span>
      </time>
    </p>
  );
}
