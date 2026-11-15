import { CircleAlertIcon, RotateCwIcon, TriangleAlertIcon, WifiOffIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

/**
 * The four error sizes (docs/UI-REBUILD.md › Errors): a field error under an
 * input, a row error inside a list row, a surface alert at the top of a panel
 * or where a reply failed, and toasts (toast.tsx) for background work.
 */

/** A message from the core, unwrapped if a provider sent JSON (`{"error":{"message":…}}`). */
export function cleanMessage(e: unknown): string {
  const text = errorText(e).trim();
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
      const m = typeof o.error === "object" ? o.error?.message : (o.error ?? o.message);
      if (typeof m === "string" && m.trim()) return m.trim();
    } catch {
      // not JSON after all
    }
  }
  return text || "Something went wrong.";
}

/** Text that clamps to `lines` and offers "Show more" only when it was actually cut. */
export function ClampedText({ text, lines = 2, className }: { text: string; lines?: 2 | 3 | 12; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setCut(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  const clamp = lines === 2 ? "line-clamp-2" : lines === 3 ? "line-clamp-3" : "line-clamp-[12]";
  return (
    <div className={className}>
      <div ref={ref} className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", !open && clamp)}>
        {text}
      </div>
      {cut || open ? (
        <button type="button" className="mt-0.5 font-medium text-xs underline-offset-2 opacity-80 hover:underline hover:opacity-100" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  );
}

export function FieldError({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p className={cn("flex items-start gap-1.5 text-destructive-foreground text-xs", className)} role="alert">
      <CircleAlertIcon className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/** Inside a list row or a small block: what failed, and a retry link. Keeps the row's height. */
export function RowError({ message, onRetry, className }: { message: string; onRetry?: () => void; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-muted-foreground text-xs", className)}>
      <CircleAlertIcon className="size-3.5 shrink-0 text-error" strokeWidth={2} />
      <span className="min-w-0 truncate" title={message}>
        {message}
      </span>
      {onRetry ? (
        <button type="button" className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

export type AlertActionSpec = { label: string; onClick: () => void; primary?: boolean };

/** A panel-level failure: one-line title, the message clamped to two lines, actions on the right. */
export function SurfaceError({
  title,
  message,
  actions = [],
  onRetry,
  tone = "error",
  icon,
  className,
}: {
  title: string;
  message?: string;
  actions?: AlertActionSpec[];
  onRetry?: () => void;
  tone?: "error" | "warning";
  icon?: ReactNode;
  className?: string;
}) {
  const all = onRetry ? [...actions, { label: "Retry", onClick: onRetry }] : actions;
  return (
    <Alert variant={tone} controlAlignment="first-line" className={className}>
      {icon ?? (tone === "warning" ? <TriangleAlertIcon /> : <CircleAlertIcon />)}
      <AlertTitle className="truncate">{title}</AlertTitle>
      {message ? (
        <AlertDescription>
          <ClampedText text={message} />
        </AlertDescription>
      ) : null}
      {all.length ? (
        <AlertAction>
          {all.map((a) => (
            <Button key={a.label} size="xs" variant={a.primary ? "default" : "outline"} onClick={a.onClick}>
              {a.label === "Retry" ? <RotateCwIcon /> : null}
              {a.label}
            </Button>
          ))}
        </AlertAction>
      ) : null}
    </Alert>
  );
}

export function ConnectionLost({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border border-warning/30 bg-warning-surface px-3 py-2 text-warning-foreground text-xs", className)} role="status">
      <WifiOffIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Reconnecting to Phaethon’s core…</span>
      <span className="size-1.5 shrink-0 animate-status-pulse rounded-full bg-warning" />
    </div>
  );
}
