import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/features/chat/components/Markdown";
import { cn } from "@/lib/utils";

/**
 * Pieces every study screen shares: the page column, the header breadcrumb,
 * the 2 px job bar with its step line, the tick discs of a summary list, and
 * card/question text drawn through the chat's Markdown (KaTeX, citations).
 */

/**
 * The scrolling page under the title bar: a centred column (`--page-max-width`,
 * or `narrow` for one-thing-at-a-time screens), `pt-10` so the dot matrix
 * shows above the first block, and the `page` container for its grids.
 */
export function Page({ children, narrow = false, className }: { children: ReactNode; narrow?: boolean; className?: string }) {
  return (
    <div className="@container/page relative min-h-0 flex-1 overflow-y-auto">
      <div className={cn("mx-auto flex w-full flex-col gap-10 px-6 pt-10 pb-16 @3xl/page:px-8", narrow ? "max-w-(--chat-max-width)" : "max-w-(--page-max-width)", className)}>{children}</div>
    </div>
  );
}

/** The filled disc in front of a summary row (c06d's blue ticks): done, partly, missed, a neutral note (a dash), or nothing to say. */
export function Disc({ tone = "done", className }: { tone?: "done" | "partial" | "wrong" | "info" | "muted"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full text-white",
        tone === "done" ? "bg-primary" : tone === "partial" ? "bg-warning" : tone === "wrong" ? "bg-destructive" : "bg-subtle-foreground/60",
        className,
      )}
    >
      <Icon icon={tone === "wrong" ? icons.close : tone === "partial" || tone === "info" ? icons.remove : icons.check} className="size-2.5 [--icon-stroke-small:2.25]" />
    </span>
  );
}

/**
 * "← Sets and functions" in the title bar: Study is already the selected tab,
 * so the arrow goes back to it and the name truncates. While crumbs show, the
 * bar folds the other tabs to their icons so the crumb always has room
 * (`data-slot="crumbs"`, see app/Header.tsx).
 */
export function Crumbs({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <span data-slot="crumbs" className="flex min-w-0 items-center gap-1 overflow-hidden text-sm">
      <button
        type="button"
        aria-label="Back to study"
        className="app-no-drag flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={onBack}
      >
        <Icon icon={icons.arrowLeft} className="size-4" />
      </button>
      <Truncate className="min-w-0 font-medium text-foreground">{children}</Truncate>
    </span>
  );
}

/** A determinate 2 px bar, drawn along the top edge of the box it sits in (which needs `relative overflow-hidden`). */
export function JobBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("absolute inset-x-0 top-0 h-0.5 bg-primary/12", className)} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

/** One line under a job's bar: what it is doing, done/total, and a way to stop. */
export function JobLine({ label, count, onCancel, cancelLabel = "Cancel" }: { label: string; count?: string; onCancel?: () => void; cancelLabel?: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs [overflow-wrap:anywhere]">{label}</p>
      {count ? <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">{count}</span> : null}
      {onCancel ? (
        <Button size="xs" variant="ghost-muted" shape="pill" onClick={onCancel}>
          {cancelLabel}
        </Button>
      ) : null}
    </div>
  );
}

const BLANK = "\\_\\_\\_\\_\\_";

/**
 * Text from a card or question: math, citations and light markdown. Cloze
 * blanks (`{{answer}}`, `{{ }}`) read as a gap, or with `reveal` as the
 * answer in bold.
 */
export function StudyText({ text, space, id, reveal = false, className }: { text: string; space: string; id: string; reveal?: boolean; className?: string }) {
  const shown = text.replace(/\{\{(.*?)\}\}/gs, (_, inner: string) => {
    const answer = inner.replace(/^[cC]\d+::/, "").split("::")[0]!.trim();
    return reveal && answer ? `**${answer}**` : BLANK;
  });
  return (
    <div className={cn("min-w-0", className)}>
      <Markdown text={shown} space={space} messageKey={id} />
    </div>
  );
}

/** A small group heading with an optional trailing count. */
export function GroupLabel({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <div className={cn("flex items-center gap-1.5 text-muted-foreground text-xs", className)}>
      <span>{children}</span>
      {count != null ? <span className="text-subtle-foreground tabular-nums">{count}</span> : null}
    </div>
  );
}
