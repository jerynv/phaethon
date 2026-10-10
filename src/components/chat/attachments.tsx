import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

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

export type AttachmentTray = ReturnType<typeof useAttachmentTray>;

/**
 * The files waiting to go with the message: shared by the tray above the text
 * field and its fold button in the toolbar (Composer). The files show in the
 * tray only while every chip fits whole; otherwise (many files, a short
 * window, large text or Larger click targets, a long message taking the
 * room) they fold into one "3 files attached" button in the toolbar, which
 * takes no row of its own, so the text field keeps its whole lines.
 *
 * Whether they fit is measured, not guessed: on any change that could matter
 * (files added or removed, the window, the text size or target size, the text
 * field's height) the list is laid out in the tray once and checked for
 * overflow before the browser paints, so nothing flickers and the button
 * (and focus on it) stays while the check runs.
 */
export function useAttachmentTray(inputRef: RefObject<HTMLTextAreaElement | null>) {
  const count = useAuiState((s) => s.composer.attachments.length);
  const list = useRef<HTMLUListElement>(null);
  const foldRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const [folded, setFolded] = useState(false);
  const [open, setOpen] = useState(false);
  // Bumped to lay the list out in the tray and check it again; `measured` catches up once checked.
  const [tick, setTick] = useState(0);
  const [measured, setMeasured] = useState(-1);
  const measuring = tick !== measured;
  const remeasure = useCallback(() => setTick((t) => t + 1), []);

  useLayoutEffect(remeasure, [count, remeasure]);
  useLayoutEffect(() => {
    if (!measuring) return;
    const ul = list.current;
    const over = !!ul && count > 0 && ul.scrollHeight > ul.clientHeight + 1;
    setFolded(over);
    if (!over) setOpen(false);
    setMeasured(tick);
  });
  useEffect(() => {
    window.addEventListener("resize", remeasure);
    // The text size and Larger click targets are set on the root element, without a resize.
    const watch = new MutationObserver(remeasure);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    // The text field growing or shrinking as a message is written; the problems line coming and going.
    const sizes = new ResizeObserver(remeasure);
    const input = inputRef.current;
    if (input) {
      sizes.observe(input);
      const wrap = input.closest("[data-composer-wrap]");
      if (wrap) sizes.observe(wrap);
    }
    return () => {
      window.removeEventListener("resize", remeasure);
      watch.disconnect();
      sizes.disconnect();
    };
  }, [inputRef, remeasure]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) requestAnimationFrame(() => foldRef.current?.focus());
  }, []);
  /** Focus left both the button and the opened list (for the text field, the conversation…): fold the list away. */
  const onBlurOut = useCallback((e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (list.current?.contains(next) || foldRef.current?.contains(next))) return;
    setOpen(false);
  }, []);

  return {
    count,
    list,
    foldRef,
    listId,
    /** The files are behind the toolbar button (the list shows only while `open`). */
    folded: folded && !measuring,
    /** The button stays while a check runs, so focus on it is never lost. */
    showButton: folded && count > 0,
    open: open && folded && !measuring,
    setOpen,
    close,
    onBlurOut,
  };
}

/**
 * The toolbar's "3 files attached" button, while the files are folded. It
 * opens them in a panel just above the message box; Escape (on the button or
 * in the panel) closes it, and so does focus moving anywhere else.
 */
export function AttachmentFold({ tray }: { tray: AttachmentTray }) {
  if (!tray.showButton) return null;
  return (
    <Button
      ref={tray.foldRef}
      type="button"
      variant="outline"
      size="xs"
      className="min-w-0 shrink-0"
      aria-expanded={tray.open}
      aria-controls={tray.listId}
      data-attachment-count=""
      data-attachment-fold=""
      onClick={() => tray.setOpen(!tray.open)}
      onBlur={tray.onBlurOut}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !tray.open) return;
        e.preventDefault();
        e.stopPropagation();
        tray.close(false);
      }}
    >
      <Icon name="attach" />
      {tray.count} file{tray.count === 1 ? "" : "s"} attached
      <Icon name={tray.open ? "chevron-up" : "chevron-down"} />
    </Button>
  );
}

/**
 * Files waiting to go with the message being written: a count, then the
 * files, each chip whole (useAttachmentTray says when they fold away).
 *
 * Removing a file keeps focus in the tray (on the next file's Remove, or on
 * Undo when none is left), says "Removed notes.md", and offers Undo.
 */
export function ComposerAttachments({ tray }: { tray: AttachmentTray }) {
  const aui = useAui();
  const announce = useAnnounce();
  const { count, list, listId, folded, open } = tray;
  const running = useAuiState((s) => s.thread.isRunning);
  const undoRef = useRef<HTMLButtonElement>(null);
  const [removed, setRemoved] = useState<Removed | null>(null);
  const focusAfter = useRef<number | null>(null);

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
  // Folded with nothing to undo: the tray takes no room (its button is in the toolbar).
  const bare = folded && !removed;
  return (
    // Gives way when the message box is at its height cap (the files then fold), never below its count line.
    <div
      className={cn(
        "relative flex shrink flex-col gap-1 px-1.5",
        !bare && "mb-1 min-h-[calc(var(--ph-control-height-sm)+var(--ph-space)*2)] pt-1",
      )}
      data-attachment-tray=""
      data-folded={folded ? "" : undefined}
    >
      {!bare && (
      <div className="flex min-h-(--ph-control-height-sm) shrink-0 flex-wrap items-center gap-x-2 text-xs text-ink-secondary">
        {!folded && <span data-attachment-count="">{countText}</span>}
        {removed && (
          <span className="flex min-w-0 items-center gap-1" data-attachment-undo="">
            {!folded && <span aria-hidden="true">·</span>}
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
      )}
      <ul
        ref={list}
        id={listId}
        aria-label="Attached files"
        hidden={folded && !open}
        data-attachment-list=""
        className={cn(
          "flex min-h-0 flex-wrap gap-2 p-1.5 empty:hidden",
          // Opened from the folded button: a panel over the conversation, just above the message box,
          // so showing the files never makes the message box taller. In the tray every chip shows
          // whole (else the files fold), so the list never scrolls there.
          folded
            ? "absolute start-0 bottom-full z-20 mb-2 max-h-[min(20rem,40dvh)] w-full overflow-y-auto rounded-lg border border-line bg-raised shadow-lg"
            // Room for two rows of chips (with Larger click targets too) where the window allows it.
            : "max-h-[min(12rem,20dvh)] overflow-hidden",
        )}
        onBlur={folded ? tray.onBlurOut : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !folded) return;
          e.preventDefault();
          e.stopPropagation();
          tray.close(true);
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
