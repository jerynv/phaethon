import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";
import { formatBytes, typeLabel } from "@/runtime/attachments";

function iconFor(type: string, mediaType: string | undefined): IconName {
  if (type === "image" || mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("text/") || mediaType === "application/json") return "file-text";
  return "file";
}

/** A square preview: the image itself while we have its bytes, otherwise its type's icon. */
function Thumb({ icon }: { icon: IconName }) {
  const src = useAttachmentSrc();
  const [broken, setBroken] = useState(false);
  return (
    <span
      aria-hidden="true"
      className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-sunken text-ink-secondary"
    >
      {src && !broken ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <Icon name={icon} />
      )}
    </span>
  );
}

/**
 * One attached file: a thumbnail or type icon, its name, its type and size. In
 * the composer it also has a Remove button. Read as "notes.md, Markdown, 2 KB".
 */
function AttachmentChip({ removable }: { removable: boolean }) {
  const name = useAuiState((s) => s.attachment.name);
  const type = useAuiState((s) => s.attachment.type);
  const mediaType = useAuiState((s) => s.attachment.contentType);
  const size = useAuiState((s) => s.attachment.file?.size);
  const failed = useAuiState((s) =>
    s.attachment.status.type === "incomplete" && s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "This file could not be added.")
      : undefined,
  );
  const meta = [typeLabel(name, mediaType), size !== undefined ? formatBytes(size) : null].filter(Boolean).join(" · ");

  return (
    <li className="min-w-0">
      <AttachmentPrimitive.Root
        className={cn(
          "flex h-full min-w-0 items-center gap-2.5 rounded-lg border bg-raised py-1 ps-1",
          removable ? "pe-1" : "pe-3",
          failed ? "border-danger" : "border-line",
        )}
      >
        <Thumb icon={iconFor(type, mediaType)} />
        <span className="flex min-w-0 flex-col">
          <span className="max-w-(--ph-chip-name-width) truncate text-sm font-medium text-ink" title={name}>
            {name}
          </span>
          <span className={cn("text-xs", failed ? "text-danger-ink" : "text-ink-secondary")}>
            <span className="sr-only">, </span>
            {failed ?? meta}
          </span>
        </span>
        {removable && (
          <AttachmentPrimitive.Remove asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ms-0.5 rounded-full text-ink-secondary hover:text-ink"
              aria-label={`Remove ${name}`}
              title={`Remove ${name}`}
            >
              <Icon name="close" className="size-(--ph-icon-size-sm)" />
            </Button>
          </AttachmentPrimitive.Remove>
        )}
      </AttachmentPrimitive.Root>
    </li>
  );
}

/** Files waiting to go with the message being written. */
export function ComposerAttachments() {
  return (
    <ul aria-label="Attached files" className="flex flex-wrap gap-2 px-1 pt-1 empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentChip removable />}</ComposerPrimitive.Attachments>
    </ul>
  );
}

/** Files sent with a user message (after a reload only names and types are known). */
export function MessageAttachments() {
  return (
    <ul aria-label="Files sent" className="flex max-w-(--ph-message-max-width) flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentChip removable={false} />}</MessagePrimitive.Attachments>
    </ul>
  );
}
