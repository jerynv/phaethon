import { ArrowUpIcon, CircleAlertIcon, FileTextIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import { useEffect, useId, useImperativeHandle, useRef, useState, type ClipboardEvent, type Ref } from "react";

import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MAX_FILES, admit, formatBytes, mediaTypeOf, typeLabel } from "../lib/attachments";
import type { Draft } from "../store";
import { ATTACH_FILES_EVENT } from "./ActionButtons";
import { ModelPicker } from "./ModelPicker";
import { TutorPicker } from "./TutorPicker";

// Drafts survive a space switch for the whole session.
const drafts = new Map<string, { text: string; files: Draft[] }>();
let draftSeq = 0;

export type ComposerHandle = { addFiles(files: File[]): void; focus(): void; setText(text: string): void };

function DraftChip({ d, onRemove }: { d: Draft; onRemove: () => void }) {
  return (
    <li className="group/chip relative flex max-w-56 items-center gap-2 rounded-xl border bg-background p-1.5 pe-8">
      {d.previewUrl ? (
        <img src={d.previewUrl} alt="" className="size-9 shrink-0 rounded-md object-cover" />
      ) : (
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <FileTextIcon className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium">{d.name}</span>
        <span className="text-xs text-muted-foreground">
          {typeLabel(d.name, d.mediaType)} · {formatBytes(d.size)}
        </span>
      </span>
      <Button variant="ghost-muted" size="icon-xs" className="absolute end-1 top-1/2 -translate-y-1/2" aria-label={`Remove ${d.name}`} onClick={onRemove}>
        <XIcon aria-hidden className="size-3.5" />
      </Button>
    </li>
  );
}

/**
 * Where the person writes: a growing text box, attached files (button, drag
 * and drop, paste), Send or Stop, and the space's model and tutor mode.
 * Enter sends, Shift+Enter starts a new line, Escape stops a reply.
 */
export function Composer({
  ref,
  space,
  spaceName,
  education,
  running,
  focusSignal,
  onSend,
  onStop,
  announce,
}: {
  ref?: Ref<ComposerHandle>;
  space: string;
  spaceName: string;
  education: boolean;
  running: boolean;
  focusSignal: number;
  onSend: (text: string, files: Draft[]) => void;
  onStop: () => void;
  announce: (t: string) => void;
}) {
  const saved = drafts.get(space);
  const [text, setText] = useState(saved?.text ?? "");
  const [files, setFiles] = useState<Draft[]>(saved?.files ?? []);
  const [problems, setProblems] = useState<string[]>([]);
  const input = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const problemId = useId();

  useEffect(() => {
    const d = drafts.get(space);
    setText(d?.text ?? "");
    setFiles(d?.files ?? []);
    setProblems([]);
  }, [space]);
  useEffect(() => {
    drafts.set(space, { text, files });
  }, [space, text, files]);

  // Grow with the text up to 40% of the window, then scroll.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.max(120, window.innerHeight * 0.4))}px`;
  }, [text]);

  useEffect(() => {
    if (focusSignal) input.current?.focus({ preventScroll: true });
  }, [focusSignal]);

  const addFiles = (list: File[]) => {
    if (!list.length) return;
    const { ok, problems: why } = admit(list, MAX_FILES - files.length);
    const added = ok.map(
      (f): Draft => ({
        id: `d${draftSeq++}`,
        file: f,
        name: f.name,
        mediaType: mediaTypeOf(f),
        size: f.size,
        previewUrl: mediaTypeOf(f).startsWith("image/") && !/hei[cf]$/.test(mediaTypeOf(f)) ? URL.createObjectURL(f) : undefined,
      }),
    );
    setFiles((cur) => [...cur, ...added]);
    setProblems(why);
    if (added.length) announce(`${added.length === 1 ? added[0].name : `${added.length} files`} attached.`);
  };

  useImperativeHandle(ref, () => ({
    addFiles,
    focus: () => input.current?.focus(),
    setText: (t: string) => {
      setText(t);
      requestAnimationFrame(() => {
        const el = input.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      });
    },
  }));

  useEffect(() => {
    const on = (e: Event) => (e as CustomEvent<{ space: string }>).detail?.space === space && picker.current?.click();
    window.addEventListener(ATTACH_FILES_EVENT, on);
    return () => window.removeEventListener(ATTACH_FILES_EVENT, on);
  }, [space]);

  const canSend = !running && (text.trim() !== "" || files.length > 0);
  const send = () => {
    if (!canSend) return;
    onSend(text, files);
    setText("");
    setFiles([]);
    setProblems([]);
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (!pasted.length) return;
    e.preventDefault();
    addFiles(pasted);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {problems.length > 0 && (
        <div id={problemId} role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/6 px-3 py-2 text-sm">
          <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <ul className="min-w-0 flex-1">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <Button variant="ghost-muted" size="icon-xs" aria-label="Dismiss" onClick={() => setProblems([])}>
            <XIcon aria-hidden className="size-3.5" />
          </Button>
        </div>
      )}
      <div
        className="relative rounded-2xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.05),0_8px_24px_-16px_rgb(0_0_0/0.25)] transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/15 dark:shadow-none"
        data-composer-surface=""
      >
        {files.length > 0 && (
          <ul aria-label="Attached files" className="flex flex-wrap gap-1.5 px-3 pt-3">
            {files.map((d) => (
              <DraftChip
                key={d.id}
                d={d}
                onRemove={() => {
                  if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
                  setFiles((cur) => cur.filter((x) => x.id !== d.id));
                  announce(`${d.name} removed.`);
                  input.current?.focus();
                }}
              />
            ))}
          </ul>
        )}
        <textarea
          ref={input}
          data-composer=""
          rows={1}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && running) {
              e.preventDefault();
              onStop();
            }
          }}
          aria-label={`Message ${spaceName}`}
          aria-describedby={problems.length ? `${hintId} ${problemId}` : hintId}
          placeholder={`Message ${spaceName}`}
          className="block max-h-[40dvh] min-h-[3.25rem] w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[0.9375rem] leading-relaxed outline-none placeholder:text-muted-foreground/75"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost-muted" size="icon-sm" aria-label="Attach files" onClick={() => picker.current?.click()} />}
            >
              <PaperclipIcon aria-hidden className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Attach files (images, PDFs, Word, text)</TooltipPopup>
          </Tooltip>
          <ModelPicker space={space} />
          {education && <TutorPicker space={space} onChanged={announce} />}
          <span id={hintId} className="ms-auto hidden items-center gap-1 pe-1 text-xs text-muted-foreground md:inline-flex">
            {running ? (
              <>
                <Kbd>Esc</Kbd> to stop
              </>
            ) : (
              <>
                <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>
                <Kbd>Enter</Kbd> for a new line
              </>
            )}
          </span>
          {running ? (
            <Button size="icon-sm" variant="default" className="ms-auto rounded-full md:ms-0" aria-label="Stop the reply" onClick={onStop}>
              <SquareIcon aria-hidden className="size-3 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              className={cn("ms-auto rounded-full md:ms-0", !canSend && "opacity-40")}
              aria-label="Send"
              aria-disabled={!canSend || undefined}
              onClick={send}
            >
              <ArrowUpIcon aria-hidden className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
