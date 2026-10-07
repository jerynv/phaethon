import type { ReactNode } from "react";

import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

/**
 * A folded "Details" section: technical text people may want, kept out of the
 * headline. Native <details>, so it is keyboard and screen-reader operable
 * without script; the chevron turns when open, and the summary is a full
 * target (never under --ph-target-min).
 */
export function Details({
  summary = "Details",
  children,
  className,
}: {
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group/details text-sm text-ink-secondary", className)}>
      <summary className="inline-flex min-h-(--ph-target-min) cursor-default items-center gap-1 rounded-sm pe-1 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
        <Icon name="chevron-right" className="size-(--ph-icon-size-sm) transition-transform duration-(--ph-duration-fast) group-open/details:rotate-90" />
        {summary}
      </summary>
      <div className="mt-1 flex flex-col items-start gap-1.5">{children}</div>
    </details>
  );
}
