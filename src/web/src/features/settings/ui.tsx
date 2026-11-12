import { CheckIcon, CopyIcon } from "lucide-react";
import { createContext, type DependencyList, type ReactNode, use, useCallback, useEffect, useRef, useState } from "react";
import { SkeletonCard } from "@/components/skeletons";
import { SurfaceError, cleanMessage } from "@/components/errors";
import { toast } from "@/components/toast";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";

/**
 * The pieces every settings section is built from: a group (sentence-case
 * label over a hairline card), rows inside it (label and a one-line
 * description on the left, the control on the right, at least 44 px), and a
 * loader that shows a skeleton after 150 ms and a surface error with Retry.
 */

export function Group({ label, action, children, className }: { label?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {label || action ? (
        <div className="flex min-h-6 items-center justify-between gap-3 px-1">
          {label ? <h2 className="font-medium text-2xs text-muted-foreground">{label}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y overflow-hidden rounded-xl border bg-card", className)}>{children}</div>;
}

export function Row({
  label,
  description,
  children,
  className,
  htmlFor,
  below,
}: {
  label: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  htmlFor?: string;
  /** Full-width content under the row (a field error, a list). */
  below?: ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("flex min-h-11 flex-col justify-center gap-2 px-3.5 py-3", className)}>
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label htmlFor={htmlFor} className="font-medium text-sm">
            {label}
          </Label>
          {description ? <div className="min-w-0 text-muted-foreground text-xs">{description}</div> : null}
        </div>
        {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
      </div>
      {below}
    </div>
  );
}

/** A status dot and its word. */
export function Status({ tone, children, className }: { tone: "ready" | "warning" | "neutral" | "error" | "busy"; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs", className)}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "ready" && "bg-success",
          tone === "warning" && "bg-warning",
          tone === "error" && "bg-destructive",
          tone === "neutral" && "bg-subtle-foreground/70",
          tone === "busy" && "animate-status-pulse bg-primary",
        )}
      />
      {children}
    </span>
  );
}

export type Loaded<T> = { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void>; setData: (d: T) => void };

/** Runs `fn` on mount (and when deps change); keeps the last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList = []): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const d = await fn();
      if (n === seq.current) setData(d);
    } catch (e) {
      if (n === seq.current) setError(cleanMessage(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/**
 * Skeleton while the first load runs (after 150 ms), a surface error with
 * Retry when it failed, the content once there's data.
 */
export function Loader<T>({
  state,
  errorTitle,
  skeleton,
  children,
}: {
  state: Pick<Loaded<T>, "data" | "error" | "loading" | "reload">;
  errorTitle: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const waiting = useDelayed(state.loading && state.data === undefined);
  if (state.data !== undefined) return <>{children(state.data)}</>;
  if (state.error) return <SurfaceError title={errorTitle} message={state.error} onRetry={() => void state.reload()} />;
  if (waiting) return <>{skeleton ?? <SkeletonCard rows={3} />}</>;
  return null;
}

/** An icon button that copies text and confirms with a check. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            className={className}
            onClick={() =>
              void navigator.clipboard.writeText(text).then(
                () => setDone(true),
                () => toast.error("Couldn’t copy", "Select the text and copy it instead."),
              )
            }
          />
        }
      >
        {done ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipPopup side="top">{done ? "Copied" : label}</TooltipPopup>
    </Tooltip>
  );
}

/** A yes/no question before something that can't be undone or that opens things up. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirm,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirm: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup className="max-w-md">
        <AlertDialogHeader className="gap-2 p-5">
          <AlertDialogTitle className="text-lg">{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2">
            {children}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="px-5 py-3">
          <AlertDialogClose render={<Button size="sm" variant="ghost" />}>Cancel</AlertDialogClose>
          <Button
            size="sm"
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Lets a section put a second crumb in the header (Spaces › School) with a way back. */
export type Crumb = { label: string; onBack: () => void } | null;
export const CrumbContext = createContext<(c: Crumb) => void>(() => {});
export function useCrumb(crumb: Crumb) {
  const set = use(CrumbContext);
  const label = crumb?.label;
  const onBack = crumb?.onBack;
  useEffect(() => {
    set(label && onBack ? { label, onBack } : null);
    return () => set(null);
  }, [set, label, onBack]);
}

