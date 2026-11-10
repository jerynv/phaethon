import { ArrowDownIcon, CircleAlertIcon, PaperclipIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AssistantRow } from "./components/AssistantRow";
import { Composer, type ComposerHandle } from "./components/Composer";
import { EmptyState } from "./components/EmptyState";
import { QuestionCard } from "./components/QuestionCard";
import { UserRow } from "./components/UserRow";
import { SpaceContext, useSettings, useSpaces } from "./context";
import type { AssistantMessage } from "./lib/timeline";
import { chatStore } from "./store";

/** The thread's one polite live region: replies once complete (never token by token), answers, attachments. */
function Announcer({ announcement }: { announcement: { text: string; n: number } }) {
  const [text, setText] = useState("");
  useEffect(() => {
    setText("");
    const f = requestAnimationFrame(() => setText(announcement.text));
    return () => cancelAnimationFrame(f);
  }, [announcement]);
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="chat-status">
      {text}
    </div>
  );
}

function LoadingThread() {
  return (
    <div className="flex flex-col gap-8 py-2" aria-hidden>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-2/5 rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-10 w-1/3 rounded-2xl" />
      </div>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

/**
 * A space's conversation: the timeline (a log, announced politely once each
 * reply completes) and the composer, or a question card in its place while
 * the lesson waits on an answer.
 */
export function ChatView({ spaceId }: { spaceId: string }) {
  const useStore = chatStore(spaceId);
  const messages = useStore((s) => s.messages);
  const status = useStore((s) => s.status);
  const loadError = useStore((s) => s.loadError);
  const running = useStore((s) => s.running);
  const announcement = useStore((s) => s.announcement);
  const focusSignal = useStore((s) => s.focusComposer);
  const actions = useStore.getState();
  const threadVersion = useNav((s) => s.threadVersion);
  const spaces = useSpaces();
  const settings = useSettings();
  const space = spaces.find((s) => s.id === spaceId);
  const spaceName = space?.name ?? (spaceId ? spaceId[0].toUpperCase() + spaceId.slice(1) : "this space");
  const education = !!space?.educationEnabled;

  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (useStore.getState().loadedVersion !== threadVersion || useStore.getState().status === "idle") void actions.load(threadVersion);
  }, [spaceId, threadVersion, useStore, actions]);

  const toBottom = useCallback((smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
  }, []);

  // Follow the end while the person is there; leave them where they are when they scrolled up.
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
  }, [messages, toBottom]);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const watch = new ResizeObserver(() => atBottom.current && toBottom());
    watch.observe(el);
    return () => watch.disconnect();
  }, [toBottom]);
  // A space switch or a new message starts at the end.
  useLayoutEffect(() => {
    atBottom.current = true;
    toBottom();
  }, [spaceId, focusSignal, toBottom]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    atBottom.current = near;
    setShowJump(!near);
  };

  const last = messages[messages.length - 1];
  const lastReply = last?.role === "assistant" ? (last as AssistantMessage) : undefined;
  const pending = lastReply?.question;
  const prevUser = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
    return undefined;
  })();
  const canRegenerate = !running && prevUser?.index !== undefined;

  return (
    <SpaceContext value={spaceId}>
      <div
        className="relative flex h-full min-h-0 flex-col bg-background"
        onDragEnter={(e) => {
          if (!hasFiles(e) || pending) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e) || pending) return;
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
          composer.current?.addFiles(Array.from(e.dataTransfer.files));
        }}
        data-chat-view={spaceId}
      >
        <div
          ref={scroller}
          role="log"
          aria-label={`Conversation in ${spaceName}`}
          aria-live="off"
          aria-busy={running}
          tabIndex={0}
          onScroll={onScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <div ref={content} className="mx-auto flex min-h-full w-full max-w-[46rem] flex-col px-4 pt-6 pb-8 sm:px-6">
            {status === "loading" && messages.length === 0 && <LoadingThread />}
            {status === "error" && (
              <div role="alert" className="my-auto flex flex-col items-center gap-3 py-10 text-center">
                <CircleAlertIcon aria-hidden className="size-6 text-destructive" />
                <p className="font-semibold">This conversation couldn’t be opened</p>
                <p className="max-w-md text-sm text-muted-foreground">{loadError}</p>
                <Button variant="outline" size="sm" onClick={() => void actions.load(threadVersion)}>
                  <RotateCcwIcon aria-hidden />
                  Try again
                </Button>
              </div>
            )}
            {status === "ready" && messages.length === 0 && (
              <EmptyState
                spaceName={spaceName}
                hue={space?.hue}
                description={space?.description}
                education={education}
                onStart={(p) => composer.current?.setText(p)}
              />
            )}
            {messages.length > 0 && (
              <div className="flex flex-col gap-6">
                {messages.map((m, i) =>
                  m.role === "user" ? (
                    <UserRow key={m.key} message={m} canEdit={!running && m.index !== undefined} onEdit={(t) => void actions.edit(m.key, t)} />
                  ) : (
                    <AssistantRow
                      key={m.key}
                      message={m}
                      question={(() => {
                        for (let j = i - 1; j >= 0; j--) {
                          const u = messages[j];
                          if (u.role === "user") return u.text;
                        }
                        return "";
                      })()}
                      isLast={i === messages.length - 1}
                      running={running}
                      space={spaceId}
                      settings={settings}
                      canRegenerate={canRegenerate}
                      onRegenerate={() => void actions.regenerate()}
                      onRetry={() => void actions.retry()}
                      onContinue={() => void actions.continueLast()}
                      onStop={() => void actions.stop()}
                      onApprove={actions.answerApproval}
                      onAccess={actions.answerAccess}
                      announce={actions.announce}
                    />
                  ),
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative shrink-0 px-3 pt-1 pb-3 sm:px-6 sm:pb-4">
          {showJump && messages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 -top-11 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                className="pointer-events-auto rounded-full shadow-sm"
                onClick={() => {
                  atBottom.current = true;
                  toBottom(true);
                  scroller.current?.focus({ preventScroll: true });
                }}
              >
                <ArrowDownIcon aria-hidden />
                Jump to latest
              </Button>
            </div>
          )}
          <div className="mx-auto w-full max-w-[46rem]">
            {pending ? (
              <QuestionCard pending={pending} onAnswer={(a) => actions.answerQuestion(pending.question.id, a)} />
            ) : (
              <Composer
                ref={composer}
                space={spaceId}
                spaceName={spaceName}
                education={education}
                running={running}
                focusSignal={focusSignal}
                onSend={(t, f) => void actions.send(t, f)}
                onStop={() => void actions.stop()}
                announce={actions.announce}
              />
            )}
          </div>
        </div>

        <Announcer announcement={announcement} />

        {dragging && (
          <div aria-hidden className="pointer-events-none absolute inset-0 z-20 flex bg-background/95 p-3">
            <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ring/60">
              <span className="mb-1 flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <PaperclipIcon className="size-5" />
              </span>
              <p className="text-lg font-semibold">Drop files to attach them</p>
              <p className="text-sm text-muted-foreground">Images, PDFs, Word documents and text files, saved in {spaceName}</p>
            </div>
          </div>
        )}
      </div>
    </SpaceContext>
  );
}
