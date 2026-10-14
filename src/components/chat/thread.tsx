import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  useThreadViewportStore,
  type DataMessagePartComponent,
} from "@assistant-ui/react";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type ReactNode,
  type RefObject,
} from "react";

// Built from the assistant-ui registry thread (MIT), cut down to what Phaethon's
// backend can honour and restyled with Phaethon tokens. Edit (your messages) and
// Regenerate (the last reply) fork the saved thread through agent_send's
// replaceFrom, so they are offered only where the saved position is known.
// Hidden on purpose: branch picker, feedback, dictation, suggestions and export.

import { MarkdownText, UserMarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { CoursesSuggestion } from "@/components/lms/courses-suggestion";
import { SpaceMark } from "@/components/shell/space-mark";
import { Button } from "@/components/ui/button";
import { Icon } from "@/icons";
import { useComposeRequests } from "@/lib/compose";
import { grantLabel, isFileGrant, useGrants } from "@/lib/grants";
import { findSpace } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import type { AgentMessageCustom, ContinueRun } from "@/runtime/agent-adapter";
import { RECORD_PART, type RecordPartData } from "@/runtime/records";
import { useKnownIndex } from "@/runtime/thread-index";

import { AccessRequestCard } from "./access-request-card";
import { AnnounceContext, spokenReply, useAnnounce } from "./announce";
import { ApprovalCard, SpaceIdContext } from "./approval-card";
import { MessageAttachments } from "./attachments";
import { Composer, useAddFiles } from "./composer";
import { MessageError, SetupBelowContext } from "./message-error";
import { MessageTime } from "./message-time";
import { focusPaneComposer, paneShown, usePane } from "./pane";
import { RecordPart, announcesRecord, recordText } from "./receipts";

const Nothing = () => null;
const ASSISTANT_PARTS = {
  Text: MarkdownText,
  data: { by_name: { [RECORD_PART]: RecordPart as DataMessagePartComponent } },
};
const USER_PARTS = { Text: UserMarkdownText, File: Nothing, Image: Nothing };

/** The card that speaks for itself while a run waits on the user, if any. */
const waitingCard = (custom: AgentMessageCustom | undefined) => custom?.approval ?? custom?.accessRequest;

/** "Waiting for you to allow: ..." is said by the card itself, never as activity. */
const isWaitingLine = (label: string | undefined) => !!label?.startsWith("Waiting for you");

const isRecord = (p: { type: string; name?: string }): p is { type: "data"; name: string; data: RecordPartData } =>
  p.type === "data" && p.name === RECORD_PART;

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

/** The message's own heading, for screen-reader heading and landmark navigation (C6). */
function MessageHeading({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="sr-only">
      {children}
    </h2>
  );
}

/** Edit, under one of your messages: only where the backend can replace from that point. */
function EditAction() {
  const pane = usePane();
  const id = useAuiState((s) => s.message.id);
  const known = useKnownIndex(pane?.threadIndex ?? null, id);
  if (!known) return null;
  return (
    <ActionBarPrimitive.Root hideWhenRunning className="flex justify-end">
      <ActionBarPrimitive.Edit asChild>
        <Button type="button" variant="ghost" size="xs" className="text-ink-secondary hover:text-ink" data-edit-message={id}>
          <Icon name="edit" />
          Edit
          <span className="sr-only"> your message</span>
        </Button>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
  );
}

function UserMessage() {
  const headingId = useId();
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  return (
    <MessagePrimitive.Root
      role="article"
      aria-labelledby={headingId}
      data-role="user"
      className="flex flex-col items-end gap-2"
    >
      <MessageHeading id={headingId}>You said</MessageHeading>
      <MessageAttachments />
      {hasText && (
        // A transparent border: forced-colours mode draws it, so the bubble keeps its boundary.
        <div className="max-w-(--ph-message-max-width) min-w-0 rounded-xl rounded-ee-sm border border-transparent bg-bubble px-4 py-2.5 text-md text-ink wrap-break-word">
          <MessagePrimitive.Parts components={USER_PARTS} />
        </div>
      )}
      <MessageTime role="user" />
      <EditAction />
    </MessagePrimitive.Root>
  );
}

/**
 * Editing one of your messages, in place (assistant-ui's edit composer).
 * Enter sends the new version, Escape or Cancel keeps the old one. Sending
 * replaces this message and everything after it; the old version is kept in
 * the space's past conversations.
 */
function UserEditComposer() {
  const headingId = useId();
  const hintId = useId();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pane = usePane();
  const messageId = useAuiState((s) => s.message.id);
  // Opened with Arrow Up from the message box: leaving it (Escape, Cancel or Send) goes back there.
  const fromComposer = useRef(!!pane?.editFromComposer.current);
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    if (pane) pane.editFromComposer.current = false;
    return () => {
      // Back to this message's Edit button (Cancel), or the composer when the message was replaced (Send).
      requestAnimationFrame(() => {
        if (fromComposer.current) {
          focusPaneComposer(pane);
          return;
        }
        const edit = pane?.rootRef.current?.querySelector<HTMLElement>(`[data-edit-message="${messageId}"]`);
        if (edit) edit.focus();
        else if (!document.activeElement || document.activeElement === document.body) focusPaneComposer(pane);
      });
    };
  }, [pane, messageId]);
  return (
    <MessagePrimitive.Root role="article" aria-labelledby={headingId} data-role="user" data-editing="" className="flex flex-col items-end">
      <MessageHeading id={headingId}>Editing your message</MessageHeading>
      <ComposerPrimitive.Root
        aria-label="Edit your message"
        className="flex w-full max-w-(--ph-message-max-width) flex-col gap-2 rounded-xl border border-ink-tertiary bg-raised p-2 shadow"
      >
        <ComposerPrimitive.Input
          ref={inputRef}
          aria-label="Your message"
          aria-describedby={hintId}
          submitMode="enter"
          data-edit-input=""
          className="max-h-[calc(min(10lh,40dvh)+var(--ph-space)*3)] min-h-(--ph-control-height-lg) w-full resize-none rounded-md bg-transparent px-2 py-1.5 text-md text-ink"
        />
        <p id={hintId} className="px-2 text-xs text-ink-secondary">
          Enter sends the new version, Escape cancels. Phaethon answers it again; the old version stays in this
          space’s past conversations.
        </p>
        <div className="flex justify-end gap-2">
          <ComposerPrimitive.Cancel asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </ComposerPrimitive.Cancel>
          <ComposerPrimitive.Send asChild>
            <Button type="submit">
              <Icon name="send" />
              Send
            </Button>
          </ComposerPrimitive.Send>
        </div>
      </ComposerPrimitive.Root>
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

/**
 * Under a finished reply, always visible (never only on hover): Copy, and on
 * the last reply Regenerate, or Send again when the reply was stopped (C9).
 * Shown only once the reply has finished, so Copy never takes a half reply.
 */
function ReplyActions() {
  const pane = usePane();
  const isLast = useAuiState((s) => s.message.isLast);
  const parentId = useAuiState((s) => s.message.parentId ?? undefined);
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  const copied = useAuiState((s) => s.message.isCopied);
  const failed = useAuiState((s) => s.message.status?.type === "incomplete" && s.message.status.reason === "error");
  const stopped = useAuiState(
    (s) =>
      (s.message.status?.type === "incomplete" && s.message.status.reason === "cancelled") ||
      s.message.content.some((p) => isRecord(p) && p.data.record.kind === "stopped"),
  );
  const knownParent = useKnownIndex(pane?.threadIndex ?? null, parentId);
  const announce = useAnnounce();
  const was = useRef(false);
  // Regenerate replaces the reply you may be reading, so it asks first (a slip off Copy must not
  // replace anything): "Keep this reply" takes focus, "Replace it" sits at the far end.
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const regenRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (copied && !was.current) announce("Reply copied.");
    was.current = copied;
  }, [copied, announce]);
  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);
  // A stopped reply can always be sent again (the same question, answered afresh); a finished
  // one is regenerated only where the backend can replace it truthfully.
  const again = isLast && !failed && (stopped || knownParent);
  if (!hasText && !again) return null;
  const keep = () => {
    setConfirming(false);
    requestAnimationFrame(() => regenRef.current?.focus());
  };
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      // Copy and Regenerate sit at least a whole target apart (more with Larger click targets).
      className="flex flex-wrap items-center gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*8))] gap-y-2"
      data-reply-actions=""
    >
      {hasText && (
        <ActionBarPrimitive.Copy asChild>
          {/* The visible label says what it copies, so voice control and the spoken name agree. */}
          <Button type="button" variant="ghost" size="xs" className="-ms-2 text-ink-secondary hover:text-ink" data-copy-reply="">
            <Icon name={copied ? "check" : "copy"} className="size-(--ph-icon-size-sm)" />
            {copied ? "Copied reply" : "Copy reply"}
          </Button>
        </ActionBarPrimitive.Copy>
      )}
      {again && stopped && <ContinueAction />}
      {again && stopped && (
        <ActionBarPrimitive.Reload asChild>
          <Button type="button" variant="outline" size="xs" data-reply-again="send-again" onClick={() => focusPaneComposer(pane)}>
            <Icon name="retry" className="size-(--ph-icon-size-sm)" />
            Send again
            <span className="sr-only">: answer your last message again</span>
          </Button>
        </ActionBarPrimitive.Reload>
      )}
      {again && !stopped && !confirming && (
        <Button
          ref={regenRef}
          type="button"
          variant="ghost"
          size="xs"
          className="text-ink-secondary hover:text-ink"
          data-reply-again="regenerate"
          onClick={() => setConfirming(true)}
        >
          <Icon name="retry" className="size-(--ph-icon-size-sm)" />
          Regenerate
          <span className="sr-only"> this reply</span>
        </Button>
      )}
      {again && !stopped && confirming && (
        <div
          role="group"
          aria-labelledby={`${id}-regen-q`}
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
          data-regenerate-confirm=""
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            e.stopPropagation();
            keep();
          }}
        >
          <p id={`${id}-regen-q`} className="text-sm text-ink">
            Replace this reply with a new one? This one is kept in past conversations.
          </p>
          <span className="flex flex-wrap items-center gap-x-[max(var(--ph-target-min),calc(var(--ph-space)*8))] gap-y-2">
            <Button ref={keepRef} type="button" variant="outline" size="xs" data-regenerate-keep="" onClick={keep}>
              Keep this reply
            </Button>
            <ActionBarPrimitive.Reload asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="text-ink-secondary hover:text-ink"
                data-regenerate-replace=""
                onClick={() => {
                  setConfirming(false);
                  focusPaneComposer(pane);
                }}
              >
                <Icon name="retry" className="size-(--ph-icon-size-sm)" />
                Replace it
              </Button>
            </ActionBarPrimitive.Reload>
          </span>
        </div>
      )}
    </ActionBarPrimitive.Root>
  );
}

/**
 * Continue, beside Send again on a stopped reply: the model carries on from
 * where it stopped and the words join this reply. Only where the backend knows
 * the reply's saved position, only with text to go on, and only with
 * Phaethon's own agent (Claude Code can't carry on a stopped reply; Send
 * again is beside it there).
 */
function ContinueAction() {
  const pane = usePane();
  const aui = useAui();
  const id = useAuiState((s) => s.message.id);
  const known = useKnownIndex(pane?.threadIndex ?? null, id);
  const hasText = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  if (!known || !hasText || pane?.cli) return null;
  const go = () => {
    const from = pane?.threadIndex?.indexOf(id);
    if (from === undefined) return;
    const prefix = aui
      .message()
      .getState()
      .content.filter((p) => !(isRecord(p) && p.data.record.kind === "stopped")) as ContinueRun["prefix"];
    const custom: ContinueRun = { continueFrom: from, prefix };
    aui.message().reload({ runConfig: { custom } });
    focusPaneComposer(pane);
  };
  return (
    <Button type="button" variant="outline" size="xs" data-reply-again="continue" onClick={go}>
      <Icon name="play" className="size-(--ph-icon-size-sm)" />
      Continue
      <span className="sr-only"> this reply from where it stopped</span>
    </Button>
  );
}

function AssistantMessage() {
  const headingId = useId();
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
  // A stopped reply says so once: from its saved record, or (when the stop
  // came before the record could arrive) from its status.
  const stoppedLine = useAuiState(
    (s) =>
      s.message.status?.type === "incomplete" &&
      s.message.status.reason === "cancelled" &&
      !s.message.content.some((p) => isRecord(p) && p.data.record.kind === "stopped"),
  );
  return (
    <MessagePrimitive.Root
      role="article"
      aria-labelledby={headingId}
      data-role="assistant"
      className="relative flex flex-col items-start gap-3"
    >
      <MessageHeading id={headingId}>Phaethon replied</MessageHeading>
      {hasContent && (
        <div data-cursor={quiet ? "off" : undefined} className="w-full min-w-0">
          <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
        </div>
      )}
      <ActivityLine />
      <ApprovalCard />
      <AccessRequestCard />
      <MessageError />
      {stoppedLine && (
        <p className="flex items-center gap-1.5 text-sm text-ink-secondary" data-record="stopped">
          <Icon name="stop" className="size-(--ph-icon-size-sm)" />
          Reply stopped.
        </p>
      )}
      <MessageTime role="assistant" />
      <ReplyActions />
    </MessagePrimitive.Root>
  );
}

const TOOL_ANNOUNCE_DELAY_MS = 300;
/** How long an answer just spoken is repeated in front of the line that would replace it. */
const ANSWER_KEEP_MS = 3000;

function messageText(m: { content: readonly { type: string; text?: string }[] }) {
  return m.content
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .join("")
    .trim();
}

/**
 * The thread's single polite live region. Streaming text is NOT spoken token by
 * token (the log has aria-live="off"); instead this says "Phaethon is working"
 * when a reply starts, tool activity as it happens, each answer you gave once
 * ("Allowed: create plans/week6.md"), and the reply once it completes, as plain
 * words (no markdown) and only its first sentences. Errors are announced by
 * their role="alert". Other parts of the thread speak through useAnnounce.
 */
function ReplyAnnouncer({ text, setText, cli }: { text: string; setText: (t: string) => void; cli: boolean }) {
  const last = useAuiState((s) => s.thread.messages[s.thread.messages.length - 1]);
  const spaceId = useContext(SpaceIdContext);
  const done = useRef<string | null>(null);
  const lastTool = useRef<string | undefined>(undefined);
  // Only a reply seen streaming here is announced; a saved one loaded with the
  // thread (after a restart or space switch) is not news.
  const streamed = useRef<string | null>(null);
  const continued = useRef<string | null>(null);
  // Tool activity is spoken after a short pause, so a line that is replaced at
  // once (or a card that takes over) is not read.
  const pendingTool = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Records already spoken, so each answer is said once.
  const said = useRef(new Set<string>());
  // The last answer spoken ("Not allowed: create notes.md."), and when.
  const lastAnswer = useRef<{ text: string; at: number } | null>(null);
  /**
   * A line for the region, after the answer given moments ago, if any: a screen reader
   * reads only the latest text here, so the next line would cut the answer off.
   */
  const withAnswer = (line: string) => {
    const a = lastAnswer.current;
    lastAnswer.current = null;
    return a && Date.now() - a.at < ANSWER_KEEP_MS ? `${a.text} ${line}` : line;
  };
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
      const custom = last.metadata.custom as AgentMessageCustom | undefined;
      if (streamed.current !== last.id) {
        streamed.current = last.id;
        setText("Sent. Phaethon is working on a reply.");
      }
      // A continued reply shows its earlier text with its first update: said as such, and its
      // earlier receipts are not said again.
      if (custom?.continuedAfter !== undefined && continued.current !== last.id) {
        continued.current = last.id;
        last.content.filter(isRecord).forEach((p) => said.current.add(p.data.id));
        setText("Continuing the reply.");
      }
      // A newly answered card: confirm the choice once, since focus has just moved to the composer.
      const fresh = last.content.filter(isRecord).filter((p) => !said.current.has(p.data.id));
      fresh.forEach((p) => said.current.add(p.data.id));
      const news = fresh.filter((p) => announcesRecord(p.data.record));
      if (news.length) {
        holdTool();
        const said = `${recordText(news[news.length - 1].data.record)}.`;
        lastAnswer.current = { text: said, at: Date.now() };
        setText(said);
      }
      // An approval or access card speaks for itself (or is announced by its
      // own arrival); "Waiting for you to ..." is never said on top of it.
      if (waitingCard(custom) || isWaitingLine(custom?.toolStatus)) holdTool();
      else if (custom?.toolStatus && custom.toolStatus !== lastTool.current) {
        // Said as shown: "Reading Work / calendar/oct.md".
        const say = activityText(custom.toolStatus, spaceId).text;
        holdTool();
        pendingTool.current = setTimeout(() => setText(withAnswer(say)), TOOL_ANNOUNCE_DELAY_MS);
      }
      lastTool.current = custom?.toolStatus;
      return;
    }
    holdTool();
    // An answer said moments ago would be cut off by the next line in this same region (a
    // screen reader reads only the latest), so it is said again at the start of that line.
    if (status?.type === "complete") {
      done.current = last.id;
      // A continuation is spoken from where it picked up, not from the start of the reply.
      const after = (last.metadata.custom as AgentMessageCustom | undefined)?.continuedAfter;
      const reply = after === undefined ? messageText(last) : messageText(last).slice(after).trim();
      const lead = after === undefined ? "Phaethon replied" : "Phaethon continued";
      setText(withAnswer(reply ? `${lead}: ${spokenReply(reply)}` : "Phaethon finished without a reply."));
    } else if (status?.type === "incomplete" && status.reason === "cancelled") {
      done.current = last.id;
      const more = !cli && messageText(last) !== "" ? "Continue and Send again are under it." : "Send again is under it.";
      setText(withAnswer(`Reply stopped. ${more}`));
    } else if (status?.type === "incomplete") {
      done.current = last.id;
      // The alert inside the message speaks for itself; what the reply was doing ("Reading
      // file…") is no longer true, so it goes (an answer just given stays, if any).
      setText(withAnswer("").trim());
    }
    lastTool.current = undefined;
  }, [last, setText, spaceId]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="reply-status">
      {text}
    </div>
  );
}

/**
 * What Phaethon may already read outside this space without asking: the
 * standing ("always") grants, as "Work / clients", at most two named.
 */
function standingReads(state: ReturnType<typeof useGrants>["state"], foldersOnly = false): string | null {
  if (state.status !== "ready") return null;
  // Claude Code is given granted folders (and whole spaces) only, never single files.
  const labels = state.grants
    .filter((g) => g.scope === "always" && !(foldersOnly && isFileGrant(g.path)))
    .map(grantLabel);
  if (labels.length === 0) return null;
  const named = labels.slice(0, 2);
  const rest = labels.length - named.length;
  const list = rest > 0 ? `${named.join(", ")} and ${rest} more` : named.join(" and ");
  // "All of Work" reads naturally mid-sentence as "all of Work".
  return list.replace(/^All of /, "all of ");
}

/**
 * Shown in a space with no conversation yet: where you are and what Phaethon
 * can see. True to the grants: when this space may already read part of
 * another, it says so instead of promising to ask.
 */
function EmptyState({ spaceId, spaceName, cli }: { spaceId: string; spaceName: string; cli: boolean }) {
  const { state } = useGrants(spaceId);
  const reads = standingReads(state, cli);
  return (
    // Centred by its parent with safe centring: in a short window (640x480 with attachments) it
    // starts at the top and scrolls, never clipped above the log.
    <div
      data-empty-state=""
      className="group/empty mx-auto flex max-w-(--ph-measure) flex-col items-center gap-2 px-4 py-4 text-center"
    >
      <span
        aria-hidden="true"
        className="mb-2 flex size-[calc(var(--ph-icon-size-lg)*2)] shrink-0 items-center justify-center rounded-full bg-space-tint text-ink-secondary"
      >
        <Icon name="space" className="size-(--ph-icon-size-lg)" />
      </span>
      <h2 className="text-xl font-semibold text-ink">Start a conversation in {spaceName}</h2>
      <p className="max-w-md text-md text-ink-secondary" data-empty-reach="">
        {cli ? (
          // Claude Code here is read-only and has no way to ask (agent.rs): say what it can do, nothing more.
          <>
            Claude Code answers here. It can read and search the files in {spaceName}
            {reads ? `, and ${reads} because you allowed that` : ""}. It can’t change any file, and it can’t ask to read
            anything else.
          </>
        ) : reads ? (
          <>
            Phaethon can read and search the files in {spaceName}, and it can already read {reads}, because you
            allowed that. It asks before it changes anything, or before it reads anything else in another space.
          </>
        ) : (
          <>
            Phaethon can read and search the files in {spaceName}. It asks before it changes anything, or before it
            reads another space.
          </>
        )}
      </p>
      <CoursesSuggestion spaceId={spaceId} />
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
 * "Jump to latest", in the composer's own toolbar (C8): it never covers a
 * message, a table or an open Details, and it takes no room of its own, so
 * showing it never resizes the conversation (and a small window at large
 * text keeps every line it has). It stands in for the composer's hint while
 * shown: only while scrolled up, and never while a card waits (the card
 * needs the attention, and its shortcut is the hint then).
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
  const empty = useAuiState((s) => s.thread.isEmpty);
  if (!store || atBottom || waiting || empty) return null;
  return (
    <Button
      type="button"
      variant="outline"
      className="min-w-0 rounded-full whitespace-nowrap"
      data-jump-latest=""
      onClick={() => {
        store.getState().scrollToBottom();
        // This button goes away at the bottom; keep focus in the conversation.
        logRef.current?.focus();
      }}
    >
      <Icon name="arrow-down" />
      Jump to latest
    </Button>
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export function Thread({
  spaceId,
  spaceName,
  inputRef,
  setup,
  needsKey = false,
  cli = false,
}: {
  spaceId: string;
  spaceName: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Claude Code answers in this space, not Phaethon's own agent. */
  cli?: boolean;
  /** The first-run setup card, when it may show (null otherwise). */
  setup?: ReactNode;
  /** No key is saved yet: the card stays under the conversation too, not only when it is empty. */
  needsKey?: boolean;
}) {
  const pane = usePane();
  const logRef = useRef<HTMLDivElement>(null);
  const stopFocused = useRef(false);
  // Words put in the message box from elsewhere ("Ask about this course"): there to edit, never sent.
  const aui = useAui();
  useComposeRequests(spaceId, (text) => {
    aui.composer().setText(text);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  });
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // The empty state (and first-run setup card) reads from the top; only a conversation follows its end.
  const isEmpty = useAuiState((s) => s.thread.isEmpty);
  // Once the card has shown under a message, it stays there to show what saving did
  // (saved, or one more step: add credit) until the conversation changes.
  const [setupBelow, setSetupBelow] = useState(false);
  const setupShown = !!setup && (isEmpty || needsKey || setupBelow);
  useEffect(() => {
    if (setupShown && !isEmpty) setSetupBelow(true);
  }, [setupShown, isEmpty]);
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
  // back in the composer instead of dropping it to the document body. Not in a
  // space that isn't on screen: focus belongs to the one you are in.
  const wasRunning = useRef(false);
  useEffect(() => {
    const ended = wasRunning.current && !isRunning;
    wasRunning.current = isRunning;
    if (!ended) return;
    const lost = !document.activeElement || document.activeElement === document.body;
    if ((stopFocused.current || lost) && paneShown(pane)) focusPaneComposer(pane);
    stopFocused.current = false;
  }, [isRunning, pane]);

  return (
    <SpaceIdContext.Provider value={spaceId}>
      <AnnounceContext.Provider value={announce}>
        <SetupBelowContext.Provider value={setupShown && !isEmpty}>
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
            <ThreadPrimitive.Viewport
              ref={logRef}
              role="log"
              aria-label={`Conversation in ${spaceName}`}
              // role="log" is implicitly polite; turn that off so streaming text is not read token by token.
              aria-live="off"
              aria-busy={isRunning}
              autoScroll={!isEmpty}
              tabIndex={0}
              className="flex min-h-0 flex-1 flex-col overflow-y-auto"
            >
              <ViewportBridge onStore={keepViewport} />
              <div
                className={cn(
                  "mx-auto flex w-full max-w-(--ph-thread-width) flex-1 flex-col px-6 pb-4 has-[[data-empty-state]]:justify-center-safe",
                  setupShown && isEmpty ? "pt-4" : "pt-8",
                )}
              >
                {/* First run: the setup card leads, in place of the generic empty state. */}
                {!setupShown && (
                  <AuiIf condition={(s) => s.thread.isEmpty}>
                    <EmptyState spaceId={spaceId} spaceName={spaceName} cli={cli} />
                  </AuiIf>
                )}
                <div className="flex flex-col gap-[calc(var(--ph-space)*7)] empty:hidden">
                  <ThreadPrimitive.Messages>
                    {({ message }) =>
                      message.composer.isEditing ? (
                        <UserEditComposer />
                      ) : message.role === "user" ? (
                        <UserMessage />
                      ) : (
                        <AssistantMessage />
                      )
                    }
                  </ThreadPrimitive.Messages>
                </div>
                {/*
                 * First-run setup (no API key yet), the settings team's card. One place for it, so it
                 * stays mounted (with what was typed) when a message is sent before setting up: it then
                 * sits under the error, which points to it.
                 */}
                {setupShown && (
                  <div data-setup-slot="" className={cn("w-full text-start", !isEmpty && "mt-[calc(var(--ph-space)*7)]")}>
                    {setup}
                  </div>
                )}
              </div>
            </ThreadPrimitive.Viewport>
            <ReplyAnnouncer text={spoken} setText={setSpoken} cli={cli} />
            <Composer
              spaceName={spaceName}
              inputRef={inputRef}
              stopFocused={stopFocused}
              addFiles={addFiles}
              problems={problems}
              clearProblems={clearProblems}
              dragging={dragging}
              jump={<JumpToLatest store={viewport} logRef={logRef} />}
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
                  <p className="text-base text-ink-secondary">Images, PDFs, Word documents and text files, saved in {spaceName}</p>
                </div>
              </div>
            )}
          </ThreadPrimitive.Root>
        </SetupBelowContext.Provider>
      </AnnounceContext.Provider>
    </SpaceIdContext.Provider>
  );
}
