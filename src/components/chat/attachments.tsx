import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useAttachmentSrc } from "@/hooks/use-attachment-src";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";
import { formatBytes, typeLabel } from "@/runtime/attachments";

import { useAnnounce } from "./announce";

function iconFor(type: string, mediaType: string | undefined): IconName {
  if (type === "image" || mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("text/") || mediaType === "application/json") return "file-text";
  return "file";
}

/**
 * A long file name shortened in the middle, so the end (where the version,
 * the date and the extension are) stays: "syllabus-c241-fa…ll-2026-v3.pdf".
 */
export function middleEllipsis(name: string, max = 32): string {
  const chars = [...name];
  if (chars.length <= max) return name;
  const tail = Math.ceil((max - 1) * 0.6);
  const head = max - 1 - tail;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

/** A square preview: the image itself while we have its bytes, otherwise its type's icon. */
function Thumb({ icon }: { icon: IconName }) {
  const src = useAttachmentSrc();
  const [broken, setBroken] = useState(false);
  return (
    <span
      aria-hidden="true"
      className="flex size-[calc(var(--ph-icon-size)*2.25)] shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-surface-sunken text-ink-secondary"
    >
      {src && !broken ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <Icon name={icon} />
      )}
    </span>
  );
}

type Removed = { file: File; name: string };

/**
 * One attached file: a thumbnail or type icon, its name (shortened in the
 * middle; the full name is its accessible name and tooltip), its type and
 * size. In the composer it also has a Remove button. Read as
 * "notes.md, Markdown, 2 KB".
 */
function AttachmentChip({ onRemoved }: { onRemoved?: (r: Removed, index: number) => void }) {
  const aui = useAui();
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
  const short = middleEllipsis(name);
  const removable = !!onRemoved;

  async function remove(e: React.MouseEvent<HTMLButtonElement>) {
    const li = e.currentTarget.closest("li");
    const index = li ? [...(li.parentElement?.children ?? [])].indexOf(li) : 0;
    const file = aui.attachment().getState().file;
    await aui.attachment().remove();
    if (file) onRemoved?.({ file, name }, index);
  }

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
          <span className="text-sm font-medium whitespace-nowrap text-ink" title={name}>
            <span aria-hidden="true">{short}</span>
            <span className="sr-only">{name}</span>
          </span>
          <span className={cn("text-xs", failed ? "text-danger-ink" : "text-ink-secondary")}>
            <span className="sr-only">, </span>
            {failed ?? meta}
          </span>
        </span>
        {removable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="ms-0.5 rounded-full text-ink-secondary hover:text-ink"
            aria-label={`Remove ${name}`}
            title={`Remove ${name}`}
            data-remove-attachment=""
            onClick={(e) => void remove(e)}
          >
            <Icon name="close" className="size-(--ph-icon-size-sm)" />
          </Button>
        )}
      </AttachmentPrimitive.Root>
    </li>
  );
}

/** The window is short for its text size (under 28 lines of text tall): a 760x560 window at 200%. */
const SHORT_LINES = 28;

function isShortWindow(): boolean {
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  return window.innerHeight / rem < SHORT_LINES;
}

/** Whether the window is short for its text size, kept current as the window or the text size changes. */
function useShortWindow(): boolean {
  const [short, setShort] = useState(isShortWindow);
  useEffect(() => {
    const update = () => setShort(isShortWindow());
    window.addEventListener("resize", update);
    // The text size is set on the root element (Settings › Appearance) without a resize.
    const watch = new MutationObserver(update);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      window.removeEventListener("resize", update);
      watch.disconnect();
    };
  }, []);
  return short;
}

/**
 * Files waiting to go with the message being written: a count, then the
 * files. Capped in height so many files never squeeze the conversation away
 * (the list scrolls, with room around each chip for its focus ring). In a
 * window that is short for its text size, two or more files fold into one
 * "3 files attached" button that shows them on demand, and the tray always
 * keeps a gap above the text field.
 *
 * Removing a file keeps focus in the tray (on the next file's Remove, or on
 * Undo when none is left), says "Removed notes.md", and offers Undo.
 */
export function ComposerAttachments() {
  const aui = useAui();
  const announce = useAnnounce();
  const count = useAuiState((s) => s.composer.attachments.length);
  const running = useAuiState((s) => s.thread.isRunning);
  const list = useRef<HTMLUListElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const focusAfter = useRef<number | null>(null);
  const short = useShortWindow();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const folded = short && count > 1 && !open;

  // Sent: the undo is about a message that's gone.
  useEffect(() => {
    if (running) setRemoved(null);
  }, [running]);

  // After a removal, once the list has re-rendered: the next file's Remove, else Undo.
  useEffect(() => {
    const at = focusAfter.current;
    if (at === null) return;
    focusAfter.current = null;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>("[data-remove-attachment]") ?? [];
    const next = buttons[Math.min(at, buttons.length - 1)];
    (next ?? undoRef.current)?.focus();
  });

  const onRemoved = (r: Removed, index: number) => {
    setRemoved(r);
    focusAfter.current = index;
    announce(`Removed ${r.name}. Undo is next to the files.`);
  };

  async function undo() {
    if (!removed) return;
    const r = removed;
    setRemoved(null);
    try {
      await aui.composer().addAttachment(r.file);
      announce(`${r.name} is attached again.`);
    } catch {
      announce(`${r.name} couldn’t be attached again.`);
    }
    focusAfter.current = Number.MAX_SAFE_INTEGER;
  }

  if (count === 0 && !removed) return null;
  const countText = count === 0 ? "No files attached" : `${count} file${count === 1 ? "" : "s"} attached`;
  return (
    // Gives way (its list scrolls) when the message box is at its height cap, never below its count line.
    <div
      className="relative mb-1 flex min-h-[calc(var(--ph-control-height-sm)+var(--ph-space)*2)] shrink flex-col gap-1 px-1.5 pt-1"
      data-attachment-tray="" data-folded={folded ? "" : undefined}>
      <div className="flex min-h-(--ph-control-height-sm) shrink-0 flex-wrap items-center gap-x-2 text-xs text-ink-secondary">
        {short && count > 1 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            aria-expanded={open}
            aria-controls={listId}
            data-attachment-count=""
            data-attachment-fold=""
            onClick={() => setOpen(!open)}
          >
            <Icon name="attach" />
            {countText}
            <Icon name={open ? "chevron-up" : "chevron-down"} />
          </Button>
        ) : (
          <span data-attachment-count="">{countText}</span>
        )}
        {removed && (
          <span className="flex min-w-0 items-center gap-1" data-attachment-undo="">
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" title={removed.name}>
              Removed {middleEllipsis(removed.name, 24)}
            </span>
            <Button
              ref={undoRef}
              type="button"
              variant="outline"
              size="xs"
              aria-label={`Undo: attach ${removed.name} again`}
              onClick={() => void undo()}
            >
              <Icon name="retry" />
              Undo
            </Button>
          </span>
        )}
      </div>
      <ul
        ref={list}
        id={listId}
        aria-label="Attached files"
        hidden={folded}
        data-attachment-list=""
        className={cn(
          "flex min-h-0 flex-wrap gap-2 overflow-y-auto p-1.5 empty:hidden",
          // Opened from the folded button in a short window: a panel over the conversation, just above
          // the message box, so showing the files never makes the message box taller.
          short && count > 1
            ? "absolute start-0 bottom-full z-20 mb-2 max-h-[min(20rem,40dvh)] w-full rounded-lg border border-line bg-raised shadow-lg"
            : "max-h-[min(9rem,20dvh)]",
        )}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !(short && count > 1)) return;
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          requestAnimationFrame(() => list.current?.parentElement?.querySelector<HTMLElement>("[data-attachment-fold]")?.focus());
        }}
      >
        <ComposerPrimitive.Attachments>{() => <AttachmentChip onRemoved={onRemoved} />}</ComposerPrimitive.Attachments>
      </ul>
    </div>
  );
}

/** Files sent with a user message (after a reload only names and types are known). */
export function MessageAttachments() {
  return (
    <ul aria-label="Files sent" className="flex max-w-(--ph-message-max-width) flex-wrap justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentChip />}</MessagePrimitive.Attachments>
    </ul>
  );
}
