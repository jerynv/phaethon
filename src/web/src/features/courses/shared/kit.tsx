/**
 * The education screens' layout pieces: a bounded page with a header, titled
 * sections, bordered lists of rows, a quiet meter, and the loading, error and
 * empty states every screen needs. Built on the shared ui primitives.
 */
import { AlertTriangleIcon, ArrowLeftIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** A page with a bounded measure. `narrow` for one-thing-at-a-time screens (review, quiz). */
export function EduPage({ children, narrow, className, label }: { children: ReactNode; narrow?: boolean; className?: string; label?: string }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto" data-edu-page="">
      <div
        role={label ? "region" : undefined}
        aria-label={label}
        className={cn("mx-auto flex w-full flex-col gap-8 px-4 pt-6 pb-16 sm:px-8 sm:pt-8", narrow ? "max-w-[46rem]" : "max-w-[58rem]", className)}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The page's title and its actions. The heading takes focus when `focusKey`
 * changes (arriving on a screen), so screen readers start at the top.
 */
export function PageHeader({
  title,
  meta,
  actions,
  back,
  focusKey,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  back?: { label: string; onClick: () => void };
  focusKey?: unknown;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusKey !== undefined) ref.current?.focus({ preventScroll: true });
  }, [focusKey]);
  return (
    <header className="flex flex-col gap-3">
      {back && (
        <div>
          <Button variant="ghost-muted" size="sm" className="-ms-2" onClick={back.onClick}>
            <ArrowLeftIcon aria-hidden />
            {back.label}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 ref={ref} tabIndex={-1} className="text-2xl font-semibold tracking-tight text-balance text-foreground outline-none" data-view-focus="">
            {title}
          </h1>
          {meta && <div className="text-sm text-muted-foreground">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A titled part of a page. */
export function Section({
  title,
  actions,
  children,
  className,
  description,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 id={id} className="text-base font-semibold text-foreground">
            {title}
          </h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** A bordered list; each child is a row. */
export function RowList({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={cn("divide-y divide-border overflow-hidden rounded-xl border bg-card", className)}>
      {children}
    </ul>
  );
}

/** One row: what it is on the left, its state and actions on the right; actions wrap under it on a phone. */
export function Row({ children, actions, className, ...rest }: { children: ReactNode; actions?: ReactNode; className?: string } & Record<`data-${string}`, string>) {
  return (
    <li className={cn("flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3", className)} {...rest}>
      <div className="flex min-w-0 flex-1 basis-60 flex-col gap-0.5">{children}</div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </li>
  );
}

/** A thin bar for a share (0..1). Decorative: the number beside it carries the meaning. */
export function Meter({ value, className, tone = "primary" }: { value: number; className?: string; tone?: "primary" | "success" | "warning" }) {
  const fill = tone === "success" ? "bg-success" : tone === "warning" ? "bg-warning" : "bg-primary";
  return (
    <span aria-hidden className={cn("relative block h-1.5 w-full overflow-hidden rounded-full bg-muted forced-colors:border forced-colors:border-[CanvasText]", className)}>
      <span
        className={cn("absolute inset-y-0 start-0 rounded-full forced-colors:bg-[Highlight]", fill)}
        style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
      />
    </span>
  );
}

/** A progress bar with its value in words, for runs whose progress is known. */
export function Progress({ value, label, valueText }: { value: number | null; label: string; valueText?: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value == null ? undefined : Math.round(value * 100)}
      aria-valuetext={valueText}
      className="relative h-2 w-full overflow-hidden rounded-full bg-muted forced-colors:border forced-colors:border-[CanvasText]"
    >
      {value == null ? (
        <span className="absolute inset-y-0 start-0 w-1/3 rounded-full bg-primary motion-safe:animate-[edu-indeterminate_1.4s_ease-in-out_infinite] forced-colors:bg-[Highlight]" />
      ) : (
        <span
          className="absolute inset-y-0 start-0 rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none forced-colors:bg-[Highlight]"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }}
        />
      )}
    </div>
  );
}

/** Placeholder rows while a list loads (not a spinner: the layout stays where it will be). */
export function LoadingRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div role="status" aria-label={label} className="overflow-hidden rounded-xl border bg-card">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-b-0">
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-8 w-20" />
        </div>
      ))}
    </div>
  );
}

/** What went wrong and what to do: a message with Try again. */
export function ErrorState({ title, message, onRetry }: { title: string; message?: string; onRetry?: () => void }) {
  return (
    <Alert variant="error" data-edu-error="">
      <AlertTriangleIcon aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      {message && <AlertDescription>{message}</AlertDescription>}
      {onRetry && (
        <AlertAction>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RotateCwIcon aria-hidden />
            Try again
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/** An empty state inside a page: what the emptiness means and the next step. */
export function EmptyState({ icon, title, description, children }: { icon?: ReactNode; title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <Empty size="compact" className="rounded-xl border border-dashed bg-card/40">
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

/** A small label with an icon and words (never colour alone). */
export function Flag({ icon, children, tone = "muted" }: { icon?: ReactNode; children: ReactNode; tone?: "muted" | "warning" | "error" | "success" | "info" }) {
  const color = {
    muted: "text-muted-foreground",
    warning: "text-warning-foreground",
    error: "text-destructive-foreground",
    success: "text-success-foreground",
    info: "text-info-foreground",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 text-sm [&_svg]:size-3.5 [&_svg]:shrink-0", color)}>{icon}{children}</span>;
}

/** A visually hidden live region whose text is read when it changes. */
export function LiveText({ children, assertive }: { children: ReactNode; assertive?: boolean }) {
  return (
    <div className="sr-only" role={assertive ? "alert" : "status"} aria-live={assertive ? "assertive" : "polite"} aria-atomic="true">
      {children}
    </div>
  );
}
