import { ChalkboardTeacher } from "@phosphor-icons/react";
import { ArrowUpIcon, CheckIcon, FileIcon, FileImageIcon, FileTextIcon, PaperclipIcon, PencilIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
import { mentionText, rankCommands, rankFiles, replaceTrigger, triggerAt } from "../lib/composer-menu";
import { ATTACH_EVENT } from "./ChatActions";
import { ComposerMenu, type MenuItem, useSpaceFiles } from "./ComposerMenu";
import { EffortPicker, ModelPicker, OPEN_MODEL_PICKER } from "./ModelPicker";

type Pending = { id: string; file: File; previewUrl?: string };
export type EditTarget = { index: number; text: string; attachments: Attachment[] };

const drafts = new Map<string, string>();
/** Files picked but not sent yet, per conversation (`draftKey`), kept while another conversation is shown. */
const stashes = new Map<string, { files: File[]; kept: Attachment[] }>();
const pending = (file: File): Pending => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined });

const TUTOR: { id: TutorMode; label: string; hint: string }[] = [
  { id: "normal", label: "Normal", hint: "Answers and explains" },
  { id: "quiz", label: "Quiz me", hint: "Asks questions to check you" },
  { id: "explain", label: "Explain it back", hint: "You teach it, it corrects you" },
  { id: "socratic", label: "Socratic", hint: "Leads with questions, never the answer" },
  { id: "cram", label: "Exam cram", hint: "Fast review of what’s on the exam" },
];

/** The space's teaching mode, shared by the picker and the `/quiz`-style commands. */
function useTutorMode(space: string) {
  const [mode, setModeState] = useState<TutorMode>("normal");
  useEffect(() => {
    void tutorModesList().then((m) => setModeState(m[space] ?? "normal"), () => {});
  }, [space]);
  const setMode = (next: TutorMode, announce = false) => {
    const prev = mode;
    setModeState(next);
    tutorModeSet(space, next).then(
      () => announce && toast.success(`Teaching mode: ${TUTOR.find((t) => t.id === next)?.label ?? next}`),
      (e) => {
        setModeState(prev);
        toast.error("Couldn’t change the teaching mode", errorText(e));
      },
    );
  };
  return { mode, setMode };
}

function TutorPicker({ mode, setMode, disabled }: { mode: TutorMode; setMode: (m: TutorMode) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const current = TUTOR.find((t) => t.id === mode) ?? TUTOR[0]!;
  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger disabled={disabled} className={cn("inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 data-popup-open:bg-accent", mode === "normal" ? "text-foreground/70" : "text-primary")}>
        <ChalkboardTeacher className="size-3.5" />
        <span className="@max-lg/composer:hidden">{current.label}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" padding="none" className="w-60">
        <div className="p-1">
          <div className="px-2 pt-1 pb-1.5 font-medium text-2xs text-muted-foreground">Teaching mode</div>
          {TUTOR.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setMode(t.id);
                setOpen(false);
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

export function Composer({ space, draftKey = space.id, edit, onEditDone, hero = false }: { space: SpaceView; draftKey?: string; edit: EditTarget | null; onEditDone: () => void; hero?: boolean }) {
  const chat = useSpaceChat(space.id);
  const chats = useChats.getState;
  const status = useCoreStatus();
  const groups = useCatalog((s) => s.groups);
  const openSettings = useNav((s) => s.openSettings);
  const [text, setText] = useState(() => drafts.get(draftKey) ?? "");
  const [files, setFiles] = useState<Pending[]>(() => stashes.get(draftKey)?.files.map(pending) ?? []);
  const [kept, setKept] = useState<Attachment[]>(() => stashes.get(draftKey)?.kept ?? []);
  // Coming back to a conversation with an edit under way keeps what was typed rather than starting the edit over.
  const restored = useRef(drafts.has(draftKey) || stashes.has(draftKey));
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const tutor = useTutorMode(space.id);
  const newChat = useNav((s) => s.newChat);

  // `@` and `/` autocomplete: the trigger under the caret, unless Esc dismissed that one.
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const found = triggerAt(text, caret);
  const trigger = found && found.start !== dismissed ? found : null;
  const spaceFiles = useSpaceFiles(space.id, trigger?.kind === "mention");
  const items: MenuItem[] =
    trigger?.kind === "mention"
      ? rankFiles(spaceFiles.files, trigger.query).map((f) => ({ id: `f:${f.path}`, kind: "file", path: f.path }))
      : trigger?.kind === "command"
        ? rankCommands(trigger.query, space.educationEnabled).map((c) => ({ id: `c:${c.id}`, kind: "command", command: c }))
        : [];
  const menuKey = trigger ? `${trigger.kind}:${trigger.start}:${trigger.query}` : "";
  useEffect(() => setActive(0), [menuKey]);
  const syncCaret = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length);

  const putText = (next: string, at: number) => {
    setText(next);
    setCaret(at);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(at, at);
    });
  };

  const pickItem = (item: MenuItem) => {
    if (!trigger) return;
    if (item.kind === "file") {
      const r = replaceTrigger(text, trigger, mentionText(item.path));
      putText(r.text, r.caret);
      return;
    }
    const r = replaceTrigger(text, trigger, "");
    putText(r.text.trimStart() === r.text ? r.text : r.text.replace(/^ /, ""), Math.max(0, r.caret));
    switch (item.command.id) {
      case "quiz":
      case "explain":
      case "socratic":
      case "cram":
      case "normal":
        tutor.setMode(item.command.id, true);
        break;
      case "new":
        void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)));
        break;
      case "model":
        window.dispatchEvent(new Event(OPEN_MODEL_PICKER));
        break;
      case "attach":
        picker.current?.click();
        break;
    }
  };

  useEffect(() => {
    drafts.set(draftKey, text);
  }, [draftKey, text]);

  useEffect(() => {
    if (files.length || kept.length) stashes.set(draftKey, { files: files.map((f) => f.file), kept });
    else stashes.delete(draftKey);
  }, [draftKey, files, kept]);

  useEffect(() => {
    const skip = restored.current;
    restored.current = false;
    if (!edit || skip) return;
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
      setFiles((cur) => [...cur, ...ok.map(pending)]);
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
    drafts.set(draftKey, "");
    stashes.delete(draftKey);
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
    <div className={cn("@container/composer mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-1.5", !hero && "px-4 pb-4")}>
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
        <AnimatePresence>
          {trigger ? (
            <ComposerMenu key={trigger.kind} trigger={trigger} items={items} active={active} loading={spaceFiles.loading} error={spaceFiles.error} onActive={setActive} onPick={pickItem} />
          ) : null}
        </AnimatePresence>
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
          rows={2}
          aria-label="Message"
          placeholder={edit ? "Edit your message" : `Message ${space.name}`}
          onChange={(e) => {
            setText(e.target.value);
            syncCaret(e.target);
            if (dismissed !== null && !triggerAt(e.target.value, e.target.selectionStart ?? 0)) setDismissed(null);
          }}
          onSelect={(e) => syncCaret(e.currentTarget)}
          aria-autocomplete="list"
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files];
            if (pasted.length) {
              e.preventDefault();
              add(pasted);
            }
          }}
          onKeyDown={(e) => {
            if (trigger && !e.nativeEvent.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                if (items.length) {
                  e.preventDefault();
                  setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
                }
                return;
              }
              if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && items[active]) {
                e.preventDefault();
                pickItem(items[active]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDismissed(trigger.start);
                return;
              }
            }
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
          {space.educationEnabled ? <TutorPicker mode={tutor.mode} setMode={(m) => tutor.setMode(m)} disabled={busy} /> : null}
          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            {pick ? (
              <>
                <ModelPicker pick={pick} onPick={setPick} disabled={busy} />
                <EffortPicker pick={pick} onPick={setPick} disabled={busy} />
              </>
            ) : (
              <span className="h-7 w-28 animate-skeleton rounded-md bg-muted" />
            )}
            <span className="w-1" />
            <AnimatePresence mode="popLayout" initial={false}>
              {busy ? (
                <motion.span key="stop" initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }} transition={{ type: "spring", duration: 0.25, bounce: 0.3 }} className="inline-flex">
                  <Tooltip>
                    <TooltipTrigger render={<button type="button" aria-label="Stop" onClick={() => void chats().stop(space.id)} className="relative inline-flex size-7 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85" />}>
                      <span className="absolute inset-0 animate-ping rounded-full bg-foreground/20 [animation-duration:2s]" aria-hidden />
                      <span className="size-2.5 rounded-xs bg-current" />
                    </TooltipTrigger>
                    <TooltipPopup>Stop</TooltipPopup>
                  </Tooltip>
                </motion.span>
              ) : (
                <motion.button
                  key="send"
                  type="button"
                  aria-label="Send"
                  disabled={!canSend}
                  onClick={() => void send()}
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.6, opacity: 0, y: -6 }}
                  whileTap={canSend ? { scale: 0.88 } : undefined}
                  transition={{ type: "spring", duration: 0.25, bounce: 0.3 }}
                  className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-muted disabled:text-subtle-foreground"
                >
                  <ArrowUpIcon className="size-4" />
                </motion.button>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
      {problem ? <FieldError className="px-1">{problem}</FieldError> : null}
      {group?.need && !problem ? (
        <p className="flex items-center gap-1.5 px-1 text-warning-foreground text-xs">
          <span className="size-1.5 rounded-full bg-warning" />
          <span className="min-w-0 truncate">
            {group.name} · {group.need}
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
