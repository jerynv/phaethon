import { CopyIcon, ExternalLinkIcon, EyeIcon, FolderOpenIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNav } from "@/app/store";
import { toast } from "@/components/toast";
import { ContextMenu, ContextMenuItem, ContextMenuPopup, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { FileIcon } from "@/features/viewer/FileIcon";
import { fileOpen } from "@/features/viewer/api";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

/**
 * A file in the space, wherever it is mentioned (a link or path in a reply, a
 * tool step, an attachment): click opens it in the viewer, right-click offers
 * open, open in the default app, show in folder and copy path.
 */

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
  } catch (e) {
    toast.error("Couldn’t copy", errorText(e));
  }
}

/** The right-click menu every file reference shares. `extra` goes above the copy item. */
export function FileMenu({ space, path, children, extra }: { space: string; path: string; children: ReactNode; extra?: ReactNode }) {
  const openFile = useNav((s) => s.openFile);
  const native = (reveal: boolean) =>
    void fileOpen(space, path, reveal).catch((e) => toast.error(reveal ? "Couldn’t show the file" : "Couldn’t open the file", errorText(e)));
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuPopup>
        <ContextMenuItem onClick={() => openFile(space, path)}>
          <EyeIcon />
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => native(false)}>
          <ExternalLinkIcon />
          Open in default app
        </ContextMenuItem>
        <ContextMenuItem onClick={() => native(true)}>
          <FolderOpenIcon />
          Show in folder
        </ContextMenuItem>
        <ContextMenuSeparator />
        {extra}
        <ContextMenuItem onClick={() => void copyText(path, "Path copied")}>
          <CopyIcon />
          Copy path
        </ContextMenuItem>
      </ContextMenuPopup>
    </ContextMenu>
  );
}

/**
 * `chip`: a bordered pill (attachments, tool steps). `inline`: sits in prose
 * like a link, with the file's glyph in front.
 */
export function FileChip({
  space,
  path,
  label,
  variant = "chip",
  className,
  onOpen,
}: {
  space: string;
  path: string;
  /** Shown instead of the file name (a link's own words). */
  label?: ReactNode;
  variant?: "chip" | "inline";
  className?: string;
  /** Instead of the viewer (an attachment that isn't saved yet). */
  onOpen?: () => void;
}) {
  const openFile = useNav((s) => s.openFile);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const open = onOpen ?? (() => openFile(space, path));
  return (
    <FileMenu space={space} path={path}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-slot="file-chip"
              data-path={path}
              onClick={open}
              className={cn(
                variant === "chip"
                  ? "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg border bg-background px-2 text-xs transition-colors hover:border-input hover:bg-accent"
                  : "md-file mx-0.5 inline-flex max-w-64 -translate-y-px items-baseline gap-1 rounded-sm px-0.5 align-baseline text-primary decoration-primary/35 underline-offset-2 transition-colors hover:bg-primary/8 hover:underline",
                className,
              )}
            />
          }
        >
          <FileIcon name={name} className={cn(variant === "chip" ? "size-3.5" : "size-3.5 translate-y-0.5 text-current")} />
          {label === undefined ? <MiddleTruncate value={name} className="min-w-0" /> : <span className="min-w-0 truncate">{label}</span>}
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="font-mono text-2xs">{path}</span>
        </TooltipPopup>
      </Tooltip>
    </FileMenu>
  );
}
