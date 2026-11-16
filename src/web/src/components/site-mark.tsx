import canvas from "@/assets/sites/canvas.svg";
import moodle from "@/assets/sites/moodle.svg";
import { lmsSiteIcon } from "@/features/courses/api";
import type { LmsConnection, LmsKind } from "@/features/courses/lib/types";
import { useLoad } from "@/features/study/use-load";
import { cn } from "@/lib/utils";

/**
 * A course site's mark, never in a box: the school's own icon when the site
 * serves one (fetched once by the core and remembered), else the site's brand
 * mark (Canvas, Moodle) or a plain monogram (D2L, Bb). Sized with `size-*`.
 */
const BRAND: Partial<Record<LmsKind, string>> = { canvas, moodle };
const MONOGRAM: Partial<Record<LmsKind, string>> = { brightspace: "D2L", blackboard: "Bb" };

export function LmsMark({ kind, className }: { kind: LmsKind; className?: string }) {
  const src = BRAND[kind];
  if (src) return <img alt="" aria-hidden src={src} className={cn("size-4 shrink-0 dark:invert", className)} draggable={false} />;
  return (
    <span aria-hidden className={cn("inline-flex size-4 shrink-0 items-center justify-center font-semibold text-2xs leading-none tracking-tight", className)}>
      {MONOGRAM[kind] ?? kind.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SiteMark({ connection, className }: { connection: Pick<LmsConnection, "id" | "kind">; className?: string }) {
  const icon = useLoad(() => lmsSiteIcon(connection.id).catch(() => ({ dataUrl: null })), [connection.id], "lms:icon");
  if (icon.data?.dataUrl) return <img alt="" aria-hidden src={icon.data.dataUrl} className={cn("size-4 shrink-0 rounded-[22%] object-cover", className)} draggable={false} />;
  return <LmsMark kind={connection.kind} className={className} />;
}
