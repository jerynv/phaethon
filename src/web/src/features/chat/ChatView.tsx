import { AnimatePresence } from "motion/react";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api, type SpaceView } from "@/app/api";
import { Header, useViewActive } from "@/app/Header";
import { chatKey, DRAFT, NO_SPACES, useNav, useOpenThread } from "@/app/store";
import { SurfaceError } from "@/components/errors";
import { BrandMark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { SkeletonTurns } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useChatCourseUpdate } from "@/features/courses/components/ChatCourseUpdate";
import { useDelayed } from "@/hooks/use-delayed";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { useCatalog } from "./catalog";
import { Composer, type EditTarget } from "./components/Composer";
import { HistoryRail, type RailItem } from "./components/HistoryRail";
import { AssistantMessage, UserMessage } from "./components/Messages";
import { warmMermaid } from "./components/MermaidBlock";
import { Welcome } from "./components/Welcome";
import { isLimit, LimitCard } from "./components/LimitCard";
import { firstMounted, type Mounted, mountedAll, widen } from "./lib/scroll";
import { replyText, type UserMessage as UserMessageData } from "./lib/timeline";
import { heldPlace, useTimelineScroll } from "./timeline-scroll";
import { useChats, useConv } from "./store";

/** A callback that keeps one identity across renders and always runs the latest `fn` (props of memoized messages). */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback((...args: A) => ref.current(...args), []);
}

function HeaderActions({ space, thread }: { space: SpaceView; thread: string }) {
  const deleteThread = useNav((s) => s.deleteThread);
  const newChat = useNav((s) => s.newChat);
  const running = useConv(space.id, thread).running;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost-muted" size="icon-sm" aria-label="Conversation actions" />}>
        <Icon icon={icons.more} className="size-4.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void newChat(space.id)}>
          <Icon icon={icons.newChat} />
          New chat
        </MenuItem>
        <MenuItem onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
          <Icon icon={icons.folderOpen} />
          Show space folder
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          variant="destructive"
          disabled={thread === DRAFT || running}
          onClick={() =>
            void deleteThread(space.id, thread).then(
              () => toast.success("Conversation deleted"),
              (e) => toast.error("Couldn’t delete the conversation", errorText(e)),
            )
          }
        >
          <Icon icon={icons.delete} />
          Delete conversation
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ChatView({ space }: { space: SpaceView }) {
  const canvas = useChatCourseUpdate(space);
  const thread = useOpenThread(space.id);
  const key = chatKey(space.id, thread);
  const chat = useConv(space.id, thread);
  const load = useChats((s) => s.load);
  const edit = useChats((s) => s.edits[key] ?? null);
  const setEdit = (e: EditTarget | null) => useChats.getState().setEdit(space.id, thread, e);
  const spaces = useNav((s) => s.spaces.data) ?? NO_SPACES;
  const loadCatalog = useCatalog((s) => s.load);
  const openSettings = useNav((s) => s.openSettings);
  const [closedLimit, setClosedLimit] = useState<string | null>(null);

  // Opening a conversation shows what was there at once and refreshes it quietly.
  useEffect(() => {
    void load(space.id, thread);
  }, [space.id, thread, load]);
  useEffect(() => void loadCatalog(), [loadCatalog]);
  // The diagram library loads while idle, so a chat opening on a diagram draws it before it is shown.
  useEffect(() => warmMermaid(), []);

  const last = chat.messages[chat.messages.length - 1];
  const empty = chat.messages.length === 0 && (thread === DRAFT || chat.status === "ready");
  const failed = chat.status === "error" && chat.messages.length === 0;
  // A message sent from this window (it has no saved index yet) takes the view to the end.
  const lastUser = chat.messages.findLast((m) => m.role === "user");
  const sentKey = lastUser && lastUser.index === undefined ? lastUser.key : null;

  // A long conversation mounts its newest messages (or those around where it was left) first, then the
  // rest a step per frame (after LibreChat's progressive row mount), so opening one never stalls on
  // rendering all of it. Sending a message mounts through the newest.
  const count = chat.messages.length;
  const [mount, setMount] = useState<{ key: string; win: Mounted | null }>({ key, win: null });
  let win = mount.key === key ? mount.win : null;
  if (win === null && count > 0) {
    const held = heldPlace(key);
    win = firstMounted(count, held ? chat.messages.findIndex((m) => m.key === held.key) : -1);
  }
  if (win && sentKey && win.to !== null) win = { ...win, to: null };
  if (mount.key !== key || mount.win !== win) setMount({ key, win });
  const from = Math.min(win?.from ?? 0, count);
  const to = win?.to == null ? count : Math.min(win.to, count);
  const complete = !win || mountedAll(win);
  const scroll = useTimelineScroll(key, !empty && !failed && chat.messages.length > 0, sentKey);
  // A hidden page waits: the rest mounts when it is shown again. So does a first open whose last screen
  // is still drawing (a diagram): it gets the frames first, and is shown once it has landed.
  const onScreen = useViewActive();
  useEffect(() => {
    if (complete || !onScreen || scroll.revealing) return;
    const id = requestAnimationFrame(() => startTransition(() => setMount((m) => (m.key === key && m.win ? { key, win: widen(m.win, count) } : m))));
    return () => cancelAnimationFrame(id);
  }, [key, from, to, complete, onScreen, count, scroll.revealing]);
  const mountAll = () => {
    if (!complete) flushSync(() => setMount({ key, win: { from: 0, to: null } }));
  };

  const showSkeleton = useDelayed(chat.status === "loading" && chat.messages.length === 0);
  const spaceName = useCallback((id: string) => spaces.find((s) => s.id === id)?.name ?? id, [spaces]);
  const lastUserIndex = [...chat.messages].reverse().find((m) => m.role === "user")?.index;

  // The composer is keyed by its conversation, except when a new chat has just been sent and taken its id:
  // it is the same composer, so focus stays in it for the next message.
  const composer = useRef({ thread, key });
  if (composer.current.thread !== thread) {
    const adopted = composer.current.thread === DRAFT && chat.running && chat.messages.length === 2;
    // A kept key may equal the next conversation's (the next new chat): that one still needs its own composer.
    const next = adopted ? composer.current.key : key === composer.current.key ? `${key}#${Date.now()}` : key;
    composer.current = { thread, key: next };
  }

  const limit = last?.role === "assistant" && last.error && isLimit(last.error.code) && !chat.running && closedLimit !== last.key ? last : null;
  // One rail item per message you sent, with the reply's words for its preview.
  const rail = useMemo<RailItem[]>(() => {
    const out: RailItem[] = [];
    chat.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      let assistantText: string | null = null;
      for (let j = i + 1; j < chat.messages.length; j++) {
        const r = chat.messages[j]!;
        if (r.role === "user") break;
        assistantText = replyText(r) || assistantText;
      }
      out.push({ id: m.key, userText: m.text, assistantText });
    });
    return out;
  }, [chat.messages]);

  const retry = useStable(() => {
    const u = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!u || u.role !== "user") return;
    void useChats.getState().send(space.id, { prompt: u.text, uploads: [], shown: u.attachments, replaceFrom: u.index, keepAttachments: u.attachments.map((a) => a.path!).filter(Boolean) }, thread);
  });
  const editMessage = useStable((m: UserMessageData) => {
    if (m.index !== undefined) setEdit({ index: m.index, text: m.text, attachments: m.attachments.filter((a) => a.path) });
  });

  return (
    <div className="@container/chat relative flex min-h-0 flex-1 flex-col">
      <Header actions={<HeaderActions space={space} thread={thread} />} />
      {canvas?.panel}
      {/* One composer per conversation, keyed by it, so each keeps its own draft, files and edit. */}
      {failed ? (
        <div className="mx-auto w-full max-w-(--chat-max-width) flex-1 px-4 pt-8">
          <SurfaceError title="Couldn’t open this conversation" message={chat.error} onRetry={() => void load(space.id, thread)} />
        </div>
      ) : empty ? (
        // The welcome (refs a163, a6e6): the mark, the question and the composer are one group a little above
        // centre, a row of starter chips under it. No art behind it; the page's dot matrix is enough.
        <div className="flex grow-2 flex-col items-center justify-end px-8">
          <div className="mb-5 flex flex-col items-center gap-3 text-center">
            <BrandMark className="size-5" />
            <h1 className="type-display">Where should we begin?</h1>
          </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scroll.box} data-slot="chat-scroll" className="scroll-quiet scroll-fade-top relative min-h-0 flex-1 overflow-x-hidden">
          {showSkeleton ? (
            <div className="[overflow-anchor:none]">
              <SkeletonTurns />
            </div>
          ) : null}
          {/* Messages never anchor the browser's scroll anchoring; the end marker below does (see timeline-scroll.ts). */}
          <div ref={scroll.content} className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-4 px-4 pt-6 pb-8 [overflow-anchor:none]">
            {(complete ? chat.messages : chat.messages.slice(from, to)).map((m, j) =>
              m.role === "user" ? (
                <UserMessage key={m.key} m={m} space={space.id} canEdit={!chat.running && m.index !== undefined && m.index === lastUserIndex} onEdit={editMessage} />
              ) : (complete ? j : from + j) === count - 1 ? (
                <AssistantMessage key={m.key} m={m} space={space.id} last running={chat.running} startedAt={chat.startedAt} spaceName={spaceName} onRetry={retry} />
              ) : (
                // Older replies don't depend on the run, so a streaming reply re-renders only itself.
                <AssistantMessage key={m.key} m={m} space={space.id} last={false} running={false} spaceName={spaceName} onRetry={retry} />
              ),
            )}
          </div>
          <div aria-hidden data-slot="chat-end" className="h-px [overflow-anchor:auto]" />
          </div>
          <HistoryRail box={scroll.boxRef} items={rail} onJump={(turn, offset) => scroll.jumpTo(turn, offset)} onWheel={scroll.wheel} reveal={mountAll} />
        </div>
      )}
      <div className={cn("relative", empty && "px-8")}>
        {empty ? null : (
          <button
            type="button"
            onClick={() => {
              mountAll();
              scroll.toEnd();
            }}
            aria-label="Jump to latest"
            className={cn(
              "absolute -top-11 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-3 text-muted-foreground text-sm transition-[opacity,transform] hover:text-foreground",
              scroll.away ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0",
            )}
          >
            <Icon icon={icons.arrowDown} className="size-3.5" />
            {chat.running ? "Following reply" : "Latest"}
          </button>
        )}
        <AnimatePresence initial={false}>
          {limit && limit.role === "assistant" && limit.error ? (
            <div key={limit.key} className="mx-auto w-full max-w-(--chat-max-width) px-4">
              <LimitCard
                code={limit.error.code}
                message={limit.error.message}
                retryAfterSecs={limit.error.retryAfterSecs}
                onRetry={retry}
                onSettings={() => openSettings("providers")}
                onClose={() => setClosedLimit(limit.key)}
              />
            </div>
          ) : null}
        </AnimatePresence>
        {/* Above the limit card, whose bottom edge tucks under the composer (ref fd96). */}
        <div className="relative z-10">
          <Composer key={composer.current.key} draftKey={key} space={space} edit={edit} onEditDone={() => setEdit(null)} hero={empty} dataControls={canvas?.control} />
        </div>
      </div>
      {empty ? <Welcome space={space} draftKey={key} /> : null}
    </div>
  );
}
