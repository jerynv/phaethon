import { createContext, type DependencyList, type ReactNode, use, useCallback, useEffect, useRef, useState } from "react";
import { SkeletonCard } from "@/components/skeletons";
import { SurfaceError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
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
 * The pieces every settings section is built from (docs/UI-REBUILD.md ›
 * Settings, after e0fb and 9e25):
 *
 * - `SettingsCard`: a white card with a 40 px tile, a title and one line,
 *   then the card's fields. `CardBlock` starts a new part of a card under a
 *   full-width hairline ("Triggers" / "Skills").
 * - `Field`: a label above its control, with a hint or an error under it.
 * - `Row`: a setting as a sentence, title and description on the left and
 *   the control on the right (a switch row is `ToggleRow` from the
 *   primitives).
 * - `useLoad` + `Loader`: a skeleton after 150 ms, a surface error with Retry.
 */

/** The 40 px square that leads a card: a hairline, a soft shadow, the glyph or brand mark inside. */

export function SettingsCard({
  icon,
  title,
  description,
  action,
  media,
  children,
  className,
  id,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Top-right: a menu, a badge, an add button. */
  action?: ReactNode;
  /** Art across the top. */
  media?: ReactNode;
  children?: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} data-slot="settings-card" className={cn("overflow-hidden rounded-card border bg-card", className)}>
      {media ? <div className="[--art-veil:var(--art-veil-strip)]">{media}</div> : null}
      <header className="flex items-center gap-4 p-5">
        {icon ? <span aria-hidden className="flex size-6 shrink-0 items-center justify-center text-foreground [&_svg]:size-5 [&_img]:size-6">{icon}</span> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate font-medium text-base tracking-title">{title}</h2>
          {description ? <div className="min-w-0 text-muted-foreground text-sm">{description}</div> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
      </header>
      {children ? <div className="flex flex-col gap-5 px-5 pb-5">{children}</div> : null}
    </section>
  );
}

/** A new part of a card under a full-width hairline, with an optional heading and action. */
export function CardBlock({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("-mx-5 flex flex-col gap-2 border-t px-5 pt-5", className)}>
      {title || action ? (
        <div className="flex min-h-7 items-center justify-between gap-3">
          {title ? <h3 className="font-medium text-sm">{title}</h3> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A label above its control; a hint or an error below. */
export function Field({
  label,
  htmlFor,
  aside,
  hint,
  children,
  className,
}: {
  label: ReactNode;
  htmlFor?: string;
  /** Right of the label: a link ("Get a key"), a status. */
  aside?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <Label htmlFor={htmlFor} className="text-muted-foreground text-sm">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
    </div>
  );
}

/** A section's lead-in above its cards: one muted line and an action on the right. */
export function Intro({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 px-1">
      <p className="min-w-0 text-muted-foreground text-sm">{children}</p>
      {action}
    </div>
  );
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
    <div data-slot="settings-row" className={cn("flex min-h-11 flex-col justify-center gap-2 py-1", className)}>
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label htmlFor={htmlFor} className="text-foreground text-sm">
            {label}
          </Label>
          {description ? <div className="min-w-0 text-muted-foreground text-sm">{description}</div> : null}
        </div>
        {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
      </div>
      {below}
    </div>
  );
}

/** A grey inset line holding a value and its actions: a saved key, a path, a command. */
export function Well({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex min-h-9 min-w-0 items-center gap-2 rounded-lg border bg-well py-1 pr-1 pl-3 text-sm", className)}>{children}</div>;
}

/** A status dot and its word. */
export function Status({ tone, children, className }: { tone: "ready" | "warning" | "neutral" | "error" | "busy"; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground text-sm", className)}>
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

/** What each loader last returned, so a section comes back as it was and only refreshes quietly. */
const remembered = new Map<string, unknown>();

/**
 * Runs `fn` on mount (and when deps change); keeps the last data while
 * reloading, and across visits: the same loader shows its last answer at once
 * and refreshes it in the background.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: DependencyList = []): Loaded<T> {
  const key = `${fn.toString()}|${JSON.stringify(deps)}`;
  const [data, setDataState] = useState<T | undefined>(() => remembered.get(key) as T | undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!remembered.has(key));
  const seq = useRef(0);
  const setData = useCallback(
    (d: T) => {
      remembered.set(key, d);
      setDataState(d);
    },
    [key],
  );
  const reload = useCallback(async () => {
    const n = ++seq.current;
    if (!remembered.has(key)) setLoading(true);
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
        {done ? <Icon icon={icons.check} className="text-success" /> : <Icon icon={icons.copy} />}
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
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-2">
            {children}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="px-5 py-3">
          <AlertDialogClose render={<Button size="sm" variant="outline" />}>Cancel</AlertDialogClose>
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

