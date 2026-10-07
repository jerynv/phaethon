import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useThreadViewportStore,
  type TextMessagePartComponent,
} from "@assistant-ui/react";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type RefObject,
} from "react";

// Built from the assistant-ui registry thread (MIT), cut down to what Phaethon's
// backend can honour and restyled with Phaethon tokens. Hidden on purpose: edit,
// regenerate, branch picker, feedback, dictation, suggestions and export. The
// backend thread is append-only, so edit and regenerate would not be true.
// (A failed reply's "Send again" re-sends the same message; see MessageError.)

import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { SpaceMark } from "@/components/shell/space-mark";
import { findSpace } from "@/lib/spaces";
import { ACCESS_RECEIPT_PART, type AccessReceipt, type AgentMessageCustom } from "@/runtime/agent-adapter";

import { AccessReceiptLine, AccessRequestCard, receiptText } from "./access-request-card";
import { AnnounceContext, useAnnounce } from "./announce";
import { ApprovalCard, SpaceIdContext, focusComposer } from "./approval-card";
import { MessageAttachments } from "./attachments";
import { Composer, useAddFiles } from "./composer";
import { MessageError } from "./message-error";

const PlainText: TextMessagePartComponent = ({ text }) => <>{text}</>;
const Nothing = () => null;
const ASSISTANT_PARTS = {
  Text: MarkdownText,
  data: { by_name: { [ACCESS_RECEIPT_PART]: AccessReceiptLine } },
};

/** The card that speaks for itself while a run waits on the user, if any. */
const waitingCard = (custom: AgentMessageCustom | undefined) => custom?.approval ?? custom?.accessRequest;

/**
 * Tool activity as the user reads it. Activity in another space names that
 * space first, by its display name: the backend's "Reading work/calendar/oct.md"
 * becomes "Reading Work / calendar/oct.md", and that space comes back for its mark.
 */
function activityText(label: string, current: string) {
  const m = /^(Reading|Listing|Searching) ([^/\s]+)(\/|\s|$)([\s\S]*)$/.exec(label);
  if (!m || m[2] === current) return { text: label };
  const other = findSpace(m[2]);
  if (!other) return { text: label };
  const rest = m[4] ? (m[3] === "/" ? ` / ${m[4]}` : ` ${m[4]}`) : "";
  return { text: `${m[1]} ${other.name}${rest}`, other };
}

function UserMessage() {
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  return (
    <MessagePrimitive.Root data-role="user" className="flex flex-col items-end gap-2">
      <span className="sr-only">You said: </span>
      <MessageAttachments />
      {hasText && (
        // A transparent border: forced-colours mode draws it, so the bubble keeps its boundary.
        <div className="max-w-(--ph-message-max-width) rounded-xl rounded-ee-sm border border-transparent bg-bubble px-4 py-2.5 text-md whitespace-pre-wrap text-ink wrap-break-word">
          <MessagePrimitive.Parts components={{ Text: PlainText, File: Nothing, Image: Nothing }} />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}

/**
 * What the agent is doing right now, as a quiet line under the reply:
 * "Reading file notes.md" while a tool runs, "Thinking" before the first word.
 * Spoken through ReplyAnnouncer (tool activity only), not from here.
 */
function ActivityLine() {
  // Selectors must return stable values (a fresh object each time would re-render forever).
  const toolStatus = useAuiState((s) => {
    if (s.message.status?.type !== "running") return undefined;
    const custom = s.message.metadata.custom as AgentMessageCustom | undefined;
    if (waitingCard(custom)) return undefined; // the approval or access card says it
    return custom?.toolStatus;
  });
  const spaceId = useContext(SpaceIdContext);
  const thinking = useAuiState(
    (s) =>
      s.message.status?.type === "running" &&
      !waitingCard(s.message.metadata.custom as AgentMessageCustom | undefined) &&
      !s.message.content.some((p) => p.type === "text" && p.text !== ""),
  );
  if (!toolStatus && !thinking) return null;
  const { text, other } = toolStatus ? activityText(toolStatus, spaceId) : { text: "Thinking…", other: undefined };
  return (
    <p className="flex min-w-0 max-w-full items-center gap-2 text-sm text-ink-secondary" data-activity>
      {/* One mark: the other space's own dot when the work is there, else a softly pulsing dot. */}
      {other ? (
        <span data-activity-space={other.id} className="contents" title={`In ${other.name}`}>
          <SpaceMark hue={other.hue} className="animate-pulse" />
        </span>
      ) : (
        <span
          aria-hidden="true"
          className="size-(--ph-space-mark-size) shrink-0 animate-pulse rounded-full bg-accent-fill"
        />
      )}
      {toolStatus && <span className="sr-only">Status: </span>}
      <span className="truncate">{text}</span>
    </p>
  );
}

function CopyReply() {
  const isLast = useAuiState((s) => s.message.isLast);
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  const copied = useAuiState((s) => s.message.isCopied);
  const announce = useAnnounce();
  const was = useRef(false);
  useEffect(() => {
    if (copied && !was.current) announce("Reply copied.");
    was.current = copied;
  }, [copied, announce]);
  if (!hasText) return null;
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      // Older replies keep their Copy button in the tab order; it fades in when
      // hovered or focused, and sits in the gap below the reply (the gap is sized
      // for it), so a hidden button reserves no space of its own.
      className={
        isLast
          ? "flex gap-1"
          : "absolute start-0 top-full mt-1 flex gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100"
      }
    >
      <ActionBarPrimitive.Copy asChild>
        {/* The name is the visible label plus context ("Copy reply", "Copied reply"), so voice control matches it. */}
        <Button type="button" variant="ghost" size="xs" className="-ms-2 text-ink-secondary hover:text-ink" data-copy-reply="">
          <Icon name={copied ? "check" : "copy"} className="size-(--ph-icon-size-sm)" />
          {copied ? "Copied" : "Copy"}
          <span className="sr-only"> reply</span>
        </Button>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function AssistantMessage() {
  // Nothing to show until the first word or receipt: an empty running reply
  // would otherwise render only the streaming cursor, above "Thinking…".
  const hasContent = useAuiState((s) =>
    s.message.content.some((p) => (p.type === "text" && p.text !== "") || p.type === "data"),
  );
  // While the activity line or a card speaks for the reply, the streaming
  // cursor is hidden: one progress indicator at a time.
  const quiet = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const custom = s.message.metadata.custom as AgentMessageCustom | undefined;
    return !!(waitingCard(custom) || custom?.toolStatus);
  });
  return (
    <MessagePrimitive.Root data-role="assistant" className="group/msg relative flex flex-col items-start gap-3">
      <span className="sr-only">Phaethon said: </span>
      {hasContent && (
        <div data-cursor={quiet ? "off" : undefined} className="w-full min-w-0">
          <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
        </div>
      )}
      <ActivityLine />
      <ApprovalCard />
      <AccessRequestCard />
      <MessageError />
      <AuiIf condition={(s) => s.message.status?.type === "incomplete" && s.message.status.reason === "cancelled"}>
        <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
          <Icon name="stop" className="size-(--ph-icon-size-sm)" />
          Reply stopped.
        </p>
      </AuiIf>
      <CopyReply />
    </MessagePrimitive.Root>
  );
}

const TOOL_ANNOUNCE_DELAY_MS = 300;

function messageText(m: { content: readonly { type: string; text?: string }[] }) {
  return m.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
    .trim();
}

/**
 * The thread's single polite live region. Streaming text is NOT spoken token by
 * token (the log has aria-live="off"); instead this announces tool activity and
 * the whole reply once it completes. Errors are announced by their role="alert".
 * Other parts of the thread speak through it with useAnnounce ("Reply copied.").
 */
function ReplyAnnouncer({ text, setText }: { text: string; setText: (t: string) => void }) {
  const last = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]);
  const spaceId = useContext(SpaceIdContext);
  const done = useRef<string | null>(null);
  const lastTool = useRef<string | undefined>(undefined);
  // Only a reply seen streaming here is announced; a saved one loaded with the
  // thread (after a restart or space switch) is not news.
  const streamed = useRef<string | null>(null);
  // Tool activity is spoken after a short pause: the backend sends "Waiting for
  // you to allow: ..." just before the approval itself, and that must not be
  // spoken on top of the card (which takes focus and speaks for itself).
  const pendingTool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Access answers already spoken, so each receipt is said once.
  const saidReceipts = useRef(new Set<string>());
  const holdTool = () => {
    clearTimeout(pendingTool.current);
    pendingTool.current = undefined;
  };
  useEffect(() => holdTool, []);

  useEffect(() => {
    if (!last || last.role !== "assistant" || done.current === last.id) return;
    const status = last.status;
    if (status?.type !== "running" && streamed.current !== last.id) return;
    if (status?.type === "running") {
      streamed.current = last.id;
      const custom = last.metadata.custom as AgentMessageCustom | undefined;
      // A newly answered access request: confirm the choice once ("Allowed
      // once: Work / calendar"), since focus has just moved to the composer.
      const receipts = last.content.filter(
        (p): p is typeof p & { type: "data"; data: AccessReceipt } =>
          p.type === "data" && p.name === ACCESS_RECEIPT_PART,
      );
      const fresh = receipts.filter((p) => !saidReceipts.current.has(p.data.id));
      fresh.forEach((p) => saidReceipts.current.add(p.data.id));
      if (fresh.length) {
        holdTool();
        setText(`${receiptText(fresh[fresh.length - 1].data)}.`);
      }
      // An approval or access card takes focus and is read as an alertdialog;
      // announcing it here as well would say it twice.
      if (waitingCard(custom)) holdTool();
      else if (custom?.toolStatus && custom.toolStatus !== lastTool.current) {
        // Said as shown: "Reading Work / calendar/oct.md".
        const say = activityText(custom.toolStatus, spaceId).text;
        holdTool();
        pendingTool.current = setTimeout(() => setText(say), TOOL_ANNOUNCE_DELAY_MS);
      }
      lastTool.current = custom?.toolStatus;
      return;
    }
    holdTool();
    if (status?.type === "complete") {
      done.current = last.id;
      const reply = messageText(last);
      setText(reply ? `Phaethon replied: ${reply}` : "Phaethon finished without a reply.");
    } else if (status?.type === "incomplete" && status.reason === "cancelled") {
      done.current = last.id;
      setText("Reply stopped.");
    } else if (status?.type === "incomplete") {
      done.current = last.id; // the alert inside the message speaks for itself
    }
    lastTool.current = undefined;
  }, [last, setText, spaceId]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="reply-status">
      {text}
    </div>
  );
}

/** Shown in a space with no conversation yet: where you are and what Phaethon can see. */
function EmptyState({ spaceName }: { spaceName: string }) {
  return (
    // Centred by its parent with safe centring: in a short window (640x480 with attachments) it
    // starts at the top and scrolls, never clipped above the log.
    <div data-empty-state="" className="mx-auto flex max-w-(--ph-measure) flex-col items-center gap-2 px-4 py-4 text-center">
      <span
        aria-hidden="true"
        className="mb-2 flex size-[calc(var(--ph-icon-size-lg)*2)] items-center justify-center rounded-full bg-space-tint text-ink-secondary"
      >
        <Icon name="space" className="size-(--ph-icon-size-lg)" />
      </span>
      <h2 className="text-xl font-semibold text-ink">Start a conversation in {spaceName}</h2>
      <p className="max-w-md text-md text-ink-secondary">
        Phaethon can read and search the files in {spaceName}, and nothing outside it. It asks before it changes
        anything.
      </p>
    </div>
  );
}

type ViewportStore = ReturnType<typeof useThreadViewportStore>;

/** Hands the conversation's scroll state out of the viewport, so its button can live outside it. */
function ViewportBridge({ onStore }: { onStore: (s: ViewportStore) => void }) {
  const store = useThreadViewportStore();
  useEffect(() => onStore(store), [store, onStore]);
  return null;
}

const noSubscribe = () => () => {};

/**
 * "Jump to latest": shown only while the conversation is scrolled up, and never
 * while an approval or access card waits (the card needs the attention, and in
 * a small window the button would sit on its answers). It floats over the foot
 * of the log rather than taking a row, so showing it never resizes the
 * conversation. While it shows, the log's bottom scroll padding is the
 * button's row (measured, so it holds at any text size), so a focused message
 * or button scrolls clear of it (WCAG 2.4.11); at the very bottom it is gone.
 */
function JumpToLatest({ store, logRef }: { store: ViewportStore | null; logRef: RefObject<HTMLDivElement | null> }) {
  const atBottom = useSyncExternalStore(
    store ? store.subscribe : noSubscribe,
    () => (store ? store.getState().isAtBottom : true),
  );
  const waiting = useAuiState((s) => {
    const last = s.thread.messages[s.thread.messages.length - 1];
    return last?.status?.type === "running" && !!waitingCard(last.metadata.custom as AgentMessageCustom | undefined);
  });
  // An empty thread has no "latest" (a short window may still scroll the empty state).
  const empty = useAuiState((s) => s.thread.isEmpty);
  if (!store || atBottom || waiting || empty) return null;
  return <JumpRow store={store} logRef={logRef} />;
}

function JumpRow({ store, logRef }: { store: NonNullable<ViewportStore>; logRef: RefObject<HTMLDivElement | null> }) {
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const log = logRef.current;
    if (!row || !log) return;
    const keepClear = () => (log.style.scrollPaddingBottom = `${row.getBoundingClientRect().height}px`);
    keepClear();
    const watch = new ResizeObserver(keepClear);
    watch.observe(row);
    return () => {
      watch.disconnect();
      log.style.scrollPaddingBottom = "";
    };
  }, [logRef]);
  return (
    <div
      ref={rowRef}
      className="absolute bottom-0 left-1/2 z-10 w-max max-w-full -translate-x-1/2 py-2"
      data-jump-row=""
    >
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="rounded-full bg-raised whitespace-nowrap shadow"
        onClick={() => {
          store.getState().scrollToBottom();
          // This button goes away at the bottom; keep focus in the conversation.
          logRef.current?.focus();
        }}
      >
        <Icon name="arrow-down" />
        Jump to latest
      </Button>
    </div>
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function Thread({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const stopFocused = useRef(false);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const { addFiles, problems, clearProblems } = useAddFiles();
  const [dragging, setDragging] = useState(false);
  const [viewport, setViewport] = useState<ViewportStore | null>(null);
  // The store is a function (zustand's bound hook): set it through an updater, or React would call it.
  const keepViewport = useCallback((s: ViewportStore) => setViewport(() => s), []);
  const [spoken, setSpoken] = useState("");
  // Said once even when the same words repeat (copying twice says it twice).
  const announce = useCallback((text: string) => {
    setSpoken("");
    requestAnimationFrame(() => setSpoken(text));
  }, []);

  // When a reply ends while the Stop button has focus, Stop unmounts: put focus
  // back in the composer instead of dropping it to the document body.
  const wasRunning = useRef(false);
  useEffect(() => {
    const ended = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!ended) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if (stopFocused.current || lost) focusComposer();
    stopFocused.current = false;
  }, [isRunning]);

  return (
    <SpaceIdContext.Provider value={spaceId}>
      <AnnounceContext.Provider value={announce}>
        <ThreadPrimitive.Root
          // Not positioned: the drop overlay below fills the whole pane (#main), the
          // conversations bar above the thread included.
          className="flex min-h-0 flex-1 flex-col"
          // Files can be dropped anywhere on the conversation; the + menu is the
          // single-pointer alternative (WCAG 2.5.7).
          onDragEnter={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragOver={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(e) => {
            const next = e.relatedTarget as Node | null;
            if (!next || !e.currentTarget.contains(next)) setDragging(false);
          }}
          onDrop={(e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {/* The log, and Jump to latest floating over its foot. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <ThreadPrimitive.Viewport
              ref={logRef}
              role="log"
              aria-label={`Conversation in ${spaceName}`}
              // role="log" is implicitly polite; turn that off so streaming text is not read token by token.
              aria-live="off"
              tabIndex={0}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <ViewportBridge onStore={keepViewport} />
              <div className="mx-auto flex w-full max-w-(--ph-thread-width) flex-1 flex-col px-6 pt-8 pb-6 has-[[data-empty-state]]:justify-center-safe">
                <AuiIf condition={(s) => s.thread.isEmpty}>
                  <EmptyState spaceName={spaceName} />
                </AuiIf>
                {/* The gap holds an older reply's Copy button (shown on hover or focus) and grows with the text size. */}
                <div className="flex flex-col gap-[calc(var(--ph-control-height-sm)+var(--ph-space)*3)] empty:hidden">
                  <ThreadPrimitive.Messages>
                    {({ message }) => (message.role === "user" ? <UserMessage /> : <AssistantMessage />)}
                  </ThreadPrimitive.Messages>
                </div>
              </div>
            </ThreadPrimitive.Viewport>
            <JumpToLatest store={viewport} logRef={logRef} />
          </div>
          <ReplyAnnouncer text={spoken} setText={setSpoken} />
          <Composer
            spaceName={spaceName}
            inputRef={inputRef}
            stopFocused={stopFocused}
            addFiles={addFiles}
            problems={problems}
            clearProblems={clearProblems}
            dragging={dragging}
          />
          {dragging && (
            <div
              aria-hidden="true"
              data-drop-overlay=""
              // Opaque and edge to edge, so no slice of the conversation shows around the
              // drop zone; the dashed box sits inside it.
              className="pointer-events-none absolute inset-0 z-20 flex bg-bg p-3"
            >
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-focus text-ink">
                <span className="mb-2 flex size-[calc(var(--ph-icon-size-lg)*2)] items-center justify-center rounded-full bg-accent-soft text-accent-soft-ink">
                  <Icon name="attach" className="size-(--ph-icon-size-lg)" />
                </span>
                <p className="text-lg font-semibold">Drop files to attach them</p>
                <p className="text-base text-ink-secondary">Images, PDFs and text files, saved in {spaceName}</p>
              </div>
            </div>
          )}
        </ThreadPrimitive.Root>
      </AnnounceContext.Provider>
    </SpaceIdContext.Provider>
  );
}
