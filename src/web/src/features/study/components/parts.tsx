import type { ReactNode } from "react";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/features/chat/components/Markdown";
import { cn } from "@/lib/utils";

/**
 * Pieces every study screen shares: the header breadcrumb, the 2 px job bar
 * with its step line, and card/question text drawn through the chat's
 * Markdown (KaTeX, citations).
 */

/** "Study / Sets and functions": the first part goes back. */
export function Crumbs({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <button type="button" className="app-no-drag shrink-0 text-muted-foreground transition-colors hover:text-foreground" onClick={onBack}>
        Study
      </button>
      <span className="shrink-0 font-normal text-subtle-foreground">/</span>
      <Truncate className="min-w-0">{children}</Truncate>
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
        <Button size="xs" variant="ghost-muted" onClick={onCancel}>
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
    <div className={cn("flex items-center gap-1.5 px-2 font-medium text-2xs text-muted-foreground", className)}>
      <span>{children}</span>
      {count != null ? <span className="text-subtle-foreground tabular-nums">{count}</span> : null}
    </div>
  );
}
