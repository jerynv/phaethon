import type * as React from "react";
import { createContext, type DependencyList, type ReactNode, use, useCallback, useEffect, useId, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";

/**
 * The pieces every settings section is built from (docs/UI-REBUILD.md ›
 * Settings): plain and dense, like a desktop app's preferences.
 *
 * - `SettingsGroup`: a small label above one bordered list of rows, with an
 *   optional action on the label's right and a footnote under the list. A
 *   section page is a stack of these; it's the only container in settings.
 * - `Row`: one setting on one line, label on the left and its control on the
 *   right; a short description under the label only when it says something
 *   the user can't see. `SwitchRow` is a `Row` whose control is a switch.
 * - `Field`: a row whose control needs the full width (a key, an address):
 *   the label above it, a hint or an error under it.
 * - `useLoad` + `Loader`: a skeleton after 150 ms, a surface error with Retry.
 */

export function SettingsGroup({
  label,
  action,
  note,
  children,
  className,
  listClassName,
  ...rest
}: {
  label?: ReactNode;
  /** Right of the label: an add button. */
  action?: ReactNode;
  /** Under the list: one line the rows can't say themselves. */
  note?: ReactNode;
  children: ReactNode;
  className?: string;
  listClassName?: string;
} & Omit<React.ComponentProps<"section">, "children">) {
  return (
    <section data-slot="settings-group" className={cn("flex flex-col gap-1.5", className)} {...rest}>
      {label || action ? (
        <div className="flex min-h-6 items-end justify-between gap-3 px-1">
          {label ? <h2 className="min-w-0 truncate text-subtle-foreground text-xs">{label}</h2> : <span />}
          {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
        </div>
      ) : null}
      <div data-slot="settings-list" className={cn("divide-y overflow-hidden rounded-card border bg-card", listClassName)}>
        {children}
      </div>
      {note ? <p className="px-1 text-muted-foreground text-xs">{note}</p> : null}
    </section>
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
    <div data-slot="settings-row" className={cn("flex min-h-10 flex-col justify-center gap-1.5 px-3 py-2", className)}>
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Label htmlFor={htmlFor} className={cn("text-foreground text-sm", htmlFor && "cursor-pointer")}>
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

/** A setting that is on or off; the label flips it too. `pending` holds the new state while it saves. */
export function SwitchRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  pending,
  below,
}: {
  label: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  pending?: boolean;
  below?: ReactNode;
}) {
  const id = useId();
  return (
    <Row label={label} description={description} htmlFor={id} below={below} className={cn(disabled && "opacity-60")}>
      <Switch id={id} checked={checked} onCheckedChange={(v) => onCheckedChange(v)} disabled={disabled || pending} aria-busy={pending || undefined} />
    </Row>
  );
}

/** A label above a full-width control; a hint or an error below. */
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
    <div data-slot="settings-field" className={cn("flex flex-col gap-1.5 px-3 py-2.5", className)}>
      <div className="flex min-h-5 items-center justify-between gap-3">
        <Label htmlFor={htmlFor} className="text-foreground text-sm">
          {label}
        </Label>
        {aside}
      </div>
      {children}
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
    </div>
  );
}

/** A list's only line when it has nothing in it. */
export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="flex min-h-10 items-center px-3 py-2 text-muted-foreground text-sm">{children}</p>;
}

/** What a list row opens: its own rows under a hairline, indented to the row's name. */
export function RowDetail({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("border-t", className)}>
      <div className="ml-7 divide-y">{children}</div>
    </div>
  );
}

/** A status dot and its word. */
export function Status({ tone, children, className }: { tone: "ready" | "warning" | "neutral" | "error" | "busy"; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground text-xs", className)}>
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
  if (waiting) return <>{skeleton ?? <SkeletonCard rows={3} className="rounded-card" />}</>;
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

