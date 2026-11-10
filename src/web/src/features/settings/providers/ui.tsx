/**
 * Small layout pieces shared by Settings › Assistant and Settings › Coding
 * agents: a titled section, a bordered group of rows, a row, field messages,
 * external links and a polite live region. Visual reference: T3 Code's
 * SettingsSection / SettingsGroup / SettingsRow.
 */
import { AlertCircleIcon, CheckCircle2Icon, ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function Section({
  title,
  description,
  action,
  children,
  className,
  headingId,
  ...props
}: Omit<ComponentProps<"section">, "title"> & { title: ReactNode; description?: ReactNode; action?: ReactNode; headingId?: string }) {
  return (
    <section aria-labelledby={headingId} className={cn("flex flex-col gap-3", className)} {...props}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={headingId} className="text-base font-semibold text-foreground">
            {title}
          </h3>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A bordered card whose children are divided rows. */
export function Group({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="settings-group"
      className={cn("overflow-hidden rounded-xl border bg-card text-card-foreground [&>*+*]:border-t", className)}
      {...props}
    />
  );
}

/** A label/description on the start side and a control on the end side; stacks on narrow widths. */
export function Row({
  title,
  description,
  control,
  children,
  className,
  titleId,
  descriptionId,
}: {
  title: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
  titleId?: string;
  descriptionId?: string;
}) {
  return (
    <div className={cn("@container/row px-4 py-3.5", className)}>
      <div className="flex flex-col gap-3 @min-[34rem]/row:flex-row @min-[34rem]/row:items-center @min-[34rem]/row:justify-between @min-[34rem]/row:gap-8">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div id={titleId} className="text-[0.9375rem] font-medium text-foreground">
            {title}
          </div>
          {description ? (
            <div id={descriptionId} className="text-sm text-muted-foreground text-pretty">
              {description}
            </div>
          ) : null}
        </div>
        {control ? <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 @min-[34rem]/row:justify-end">{control}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** A message under a field: problem, warning, done, or a plain note. */
export function FieldMessage({
  id,
  tone,
  children,
  className,
}: {
  id?: string;
  tone: "error" | "warning" | "success" | "muted";
  children: ReactNode;
  className?: string;
}) {
  const Icon = tone === "error" ? AlertCircleIcon : tone === "warning" ? TriangleAlertIcon : tone === "success" ? CheckCircle2Icon : null;
  return (
    <p
      id={id}
      className={cn(
        "flex items-start gap-1.5 text-sm",
        tone === "error" && "text-destructive-foreground",
        tone === "warning" && "text-warning-foreground",
        tone === "success" && "text-success-foreground",
        tone === "muted" && "text-muted-foreground",
        className,
      )}
    >
      {Icon ? <Icon aria-hidden className="mt-0.5 size-4 shrink-0" /> : null}
      <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
    </p>
  );
}

/** A link that leaves Phaethon: underlined, marked, and says so to screen readers. */
export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 rounded-sm font-medium text-foreground underline decoration-1 underline-offset-2 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {children}
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}

/** A status dot that never carries meaning alone: the text beside it says the same. */
export function Dot({ tone }: { tone: "ready" | "warning" | "error" | "neutral" | "busy" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-2 shrink-0 rounded-full forced-colors:bg-[CanvasText]",
        tone === "ready" && "bg-success",
        tone === "warning" && "bg-warning",
        tone === "error" && "bg-destructive",
        tone === "neutral" && "bg-muted-foreground/60",
        tone === "busy" && "animate-pulse bg-primary motion-reduce:animate-none",
      )}
    />
  );
}

/** A polite live region: `say(text)` announces once; render `region` anywhere in the component. */
export function useLiveRegion() {
  const [text, setText] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const say = useCallback((next: string) => {
    clearTimeout(timer.current);
    // Clear first so the same sentence twice is still announced.
    setText("");
    timer.current = setTimeout(() => setText(next), 60);
  }, []);
  const region = (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
    </div>
  );
  return { say, region };
}
