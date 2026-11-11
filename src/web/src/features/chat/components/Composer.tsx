import { ChalkboardTeacher } from "@phosphor-icons/react";
import { ArrowUpIcon, CheckIcon, FileIcon, FileImageIcon, FileTextIcon, PaperclipIcon, PencilIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SpaceView } from "@/app/api";
import { useNav } from "@/app/store";
import { ConnectionLost, FieldError } from "@/components/errors";
import { toast } from "@/components/toast";
import { MiddleTruncate } from "@/components/ui/middle-truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { useCoreStatus } from "@/hooks/use-core-status";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { tutorModeSet, tutorModesList, type ModelPick, type TutorMode, type Upload } from "../api";
import { groupIdOf, useCatalog } from "../catalog";
import { admit, formatBytes, MAX_FILES, mediaTypeOf, toBase64 } from "../lib/attachments";
import type { Attachment } from "../lib/timeline";
import { useChats, useSpaceChat } from "../store";
import { ATTACH_EVENT } from "./ChatActions";
import { EffortPicker, ModelPicker } from "./ModelPicker";

type Pending = { id: string; file: File; previewUrl?: string };
export type EditTarget = { index: number; text: string; attachments: Attachment[] };

const drafts = new Map<string, string>();

const TUTOR: { id: TutorMode; label: string; hint: string }[] = [
  { id: "normal", label: "Normal", hint: "Answers and explains" },
  { id: "quiz", label: "Quiz me", hint: "Asks questions to check you" },
  { id: "explain", label: "Explain it back", hint: "You teach it, it corrects you" },
  { id: "socratic", label: "Socratic", hint: "Leads with questions, never the answer" },
  { id: "cram", label: "Exam cram", hint: "Fast review of what’s on the exam" },
];

function TutorPicker({ space, disabled }: { space: string; disabled: boolean }) {
  const [mode, setMode] = useState<TutorMode>("normal");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void tutorModesList().then((m) => setMode(m[space] ?? "normal"), () => {});
  }, [space]);
  const current = TUTOR.find((t) => t.id === mode) ?? TUTOR[0]!;
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger disabled={disabled} className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent", mode === "normal" ? "text-foreground/70" : "text-primary")}>
        <ChalkboardTeacher className="size-3.5" />
        <span className="max-[700px]:hidden">{current.label}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="none" className="w-60">
        <div className="p-1">
          <div className="px-2 pt-1 pb-1.5 font-medium text-2xs text-muted-foreground">Teaching mode</div>
          {TUTOR.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                const prev = mode;
                setMode(t.id);
                setOpen(false);
                tutorModeSet(space, t.id).catch((e) => {
                  setMode(prev);
                  toast.error("Couldn’t change the teaching mode", errorText(e));
                });
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-sm">{t.label}</span>
                <span className="truncate text-muted-foreground text-xs">{t.hint}</span>
              </span>
              <CheckIcon className={cn("size-3.5 shrink-0", t.id === mode ? "opacity-100" : "opacity-0")} strokeWidth={2.25} />
            </button>
          ))}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PendingChip({ p, onRemove }: { p: Pending; onRemove: () => void }) {
  const type = mediaTypeOf(p.file);
  const Icon = type.startsWith("image/") ? FileImageIcon : type === "application/pdf" || type.startsWith("text/") ? FileTextIcon : FileIcon;
  return (
    <div className="group/chip relative flex h-9 max-w-52 items-center gap-2 rounded-lg border bg-background pr-7 pl-1.5 text-xs">
      {p.previewUrl ? <img src={p.previewUrl} alt="" className="size-6 shrink-0 rounded object-cover" /> : <Icon className="ml-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
      <span className="flex min-w-0 flex-col leading-tight">
        <MiddleTruncate value={p.file.name} className="min-w-0 font-medium" />
        <span className="text-2xs text-muted-foreground tabular-nums">{formatBytes(p.file.size)}</span>
      </span>
      <button type="button" aria-label={`Remove ${p.file.name}`} onClick={onRemove} className="absolute top-1/2 right-1 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground">
        <XIcon className="size-3" strokeWidth={2.25} />
      </button>
    </div>
  );
}

export function Composer({ space, edit, onEditDone, hero = false }: { space: SpaceView; edit: EditTarget | null; onEditDone: () => void; hero?: boolean }) {
  const chat = useSpaceChat(space.id);
  const chats = useChats.getState;
  const status = useCoreStatus();
  const groups = useCatalog((s) => s.groups);
  const openSettings = useNav((s) => s.openSettings);
  const [text, setText] = useState(() => drafts.get(space.id) ?? "");
  const [files, setFiles] = useState<Pending[]>([]);
  const [kept, setKept] = useState<Attachment[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    drafts.set(space.id, text);
  }, [space.id, text]);

  useEffect(() => {
    if (!edit) return;
    setText(edit.text);
    setKept(edit.attachments);
    setFiles([]);
    area.current?.focus();
  }, [edit]);

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 224)}px`;
  }, [text]);

  useEffect(() => {
    const open = () => picker.current?.click();
    window.addEventListener(ATTACH_EVENT, open);
    return () => window.removeEventListener(ATTACH_EVENT, open);
  }, []);

  useEffect(() => () => files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl)), [files]);

  const add = useCallback(
    (list: File[]) => {
      const { ok, problems } = admit(list, MAX_FILES - files.length - kept.length);
      setProblem(problems[0] ?? null);
      setFiles((cur) => [...cur, ...ok.map((file) => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined }))]);
    },
    [files.length, kept.length],
  );

  const pick = chat.pick?.pick;
  const setPick = (p: ModelPick) => void chats().setPick(space.id, p).catch((e) => toast.error("Couldn’t change the model", errorText(e)));
  const group = pick ? groups.find((g) => g.id === groupIdOf(pick)) : undefined;
  const loadModels = useCatalog((s) => s.loadModels);
  // The current model's reasoning levels come from its provider's list, so load that one now.
  useEffect(() => {
    if (group && !group.need) void loadModels(group.id);
  }, [group, loadModels]);
  const busy = chat.running;
  const canSend = !busy && status === "open" && (text.trim().length > 0 || files.length > 0 || kept.length > 0);

  const send = async () => {
    if (!canSend) return;
    let uploads: Upload[];
    try {
      uploads = await Promise.all(files.map(async (f) => ({ name: f.file.name, mediaType: mediaTypeOf(f.file), data: await toBase64(f.file) })));
    } catch (e) {
      setProblem(`An attachment couldn’t be read: ${errorText(e)}`);
      return;
    }
    const shown: Attachment[] = [...kept, ...files.map((f) => ({ name: f.file.name, mediaType: mediaTypeOf(f.file), previewUrl: f.previewUrl, size: f.file.size }))];
    const prompt = text;
    // The hero composer unmounts as the timeline appears, so clear the draft now, not in an effect.
    drafts.set(space.id, "");
    setText("");
    setFiles([]);
    setKept([]);
    setProblem(null);
    const replaceFrom = edit?.index;
    const keepAttachments = edit ? kept.map((k) => k.path!).filter(Boolean) : undefined;
    onEditDone();
    await chats().send(space.id, { prompt, uploads, shown, replaceFrom, keepAttachments });
  };

  return (
    <div className={cn("mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-1.5", !hero && "px-4 pb-4")}>
      {status === "lost" ? <ConnectionLost /> : null}
      {edit ? (
        <div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
          <PencilIcon className="size-3" />
          <span className="flex-1">Editing a message · the conversation continues from here</span>
          <button
            type="button"
            className="font-medium text-foreground hover:underline"
            onClick={() => {
              onEditDone();
              setText("");
              setKept([]);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div
        className={cn("relative rounded-xl border bg-card shadow-xs/5 transition-colors focus-within:border-ring/40 dark:shadow-none", dragging && "border-primary/60 ring-2 ring-primary/15")}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget as Node) || setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          add([...e.dataTransfer.files]);
        }}
      >
        {dragging ? <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-card/90 font-medium text-primary text-sm">Drop to attach</div> : null}
        {files.length || kept.length ? (
          <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
            {kept.map((k, i) => (
              <PendingChip key={`k${i}`} p={{ id: `k${i}`, file: new File([], k.name, { type: k.mediaType }) }} onRemove={() => setKept((c) => c.filter((_, j) => j !== i))} />
            ))}
            {files.map((f) => (
              <PendingChip key={f.id} p={f} onRemove={() => setFiles((c) => c.filter((x) => x.id !== f.id))} />
            ))}
          </div>
        ) : null}
        <textarea
          ref={area}
          value={text}
          rows={hero ? 2 : 1}
          aria-label="Message"
          placeholder={edit ? "Edit your message" : `Message ${space.name}`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) {
              e.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
            if (e.key === "Escape" && edit) onEditDone();
          }}
          className="block max-h-56 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base outline-none placeholder:text-placeholder [overflow-wrap:anywhere]"
        />
        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <Tooltip>
            <TooltipTrigger render={<button type="button" aria-label="Attach files" onClick={() => picker.current?.click()} disabled={busy} className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60" />}>
              <PaperclipIcon className="size-4" strokeWidth={1.75} />
            </TooltipTrigger>
            <TooltipPopup>Attach files · images, PDFs, Word, text</TooltipPopup>
          </Tooltip>
          <input ref={picker} type="file" multiple hidden onChange={(e) => (add([...(e.target.files ?? [])]), (e.target.value = ""))} />
          {pick ? (
            <>
              <ModelPicker pick={pick} onPick={setPick} disabled={busy} />
              <EffortPicker pick={pick} onPick={setPick} disabled={busy} />
            </>
          ) : (
            <span className="h-7 w-28 animate-skeleton rounded-md bg-muted" />
          )}
          {space.educationEnabled ? <TutorPicker space={space.id} disabled={busy} /> : null}
          <div className="ml-auto flex items-center gap-1.5">
            {busy ? (
              <Tooltip>
                <TooltipTrigger render={<button type="button" aria-label="Stop" onClick={() => void chats().stop(space.id)} className="inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85" />}>
                  <span className="size-2.5 rounded-[2px] bg-current" />
                </TooltipTrigger>
                <TooltipPopup>Stop</TooltipPopup>
              </Tooltip>
            ) : (
              <button type="button" aria-label="Send" disabled={!canSend} onClick={() => void send()} className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-[opacity,background-color] hover:bg-primary/90 disabled:bg-muted disabled:text-subtle-foreground">
                <ArrowUpIcon className="size-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
      {problem ? <FieldError className="px-1">{problem}</FieldError> : null}
      {group?.need && !problem ? (
        <p className="flex items-center gap-1.5 px-1 text-warning-foreground text-xs">
          <span className="size-1.5 rounded-full bg-warning" />
          <span className="min-w-0 truncate">
            {group.name}: {group.need.toLowerCase()}
          </span>
          <button type="button" className="shrink-0 font-medium underline-offset-2 hover:underline" onClick={() => openSettings(group.needAction ?? "providers")}>
            Set up
          </button>
        </p>
      ) : null}
      {chat.pickError ? <FieldError className="px-1">{chat.pickError}</FieldError> : null}
    </div>
  );
}
