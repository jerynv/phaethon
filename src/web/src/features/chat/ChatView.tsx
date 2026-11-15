import { ArrowDownIcon, EllipsisIcon, FolderOpenIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { chatKey, DRAFT, NO_SPACES, useNav, useOpenThread } from "@/app/store";
import { SurfaceError } from "@/components/errors";
import { SpaceAvatar } from "@/components/space-avatar";
import { SkeletonTurns } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { useDelayed } from "@/hooks/use-delayed";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";
import { useCatalog } from "./catalog";
import { Composer, type EditTarget } from "./components/Composer";
import { AssistantMessage, UserMessage } from "./components/Messages";
import { useChats, useConv } from "./store";

type Scroll = { top: number; pinned: boolean };
/** Where each conversation was scrolled to, so coming back finds it as it was left. */
const scrolls = new Map<string, Scroll>();

/**
 * Follows the bottom while new content arrives, unless the user scrolled up
 * to read; remembers the position per conversation (`key`).
 */
function useFollow(key: string, dep: unknown, mounted: boolean) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = near;
    scrolls.set(key, { top: el.scrollTop, pinned: near });
    setAway(!near);
  }, [key]);
  // A conversation opens where it was left (the bottom the first time).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const saved = scrolls.get(key);
    pinned.current = !saved || saved.pinned;
    el.scrollTop = pinned.current ? el.scrollHeight : saved!.top;
    setAway(!pinned.current);
  }, [key, mounted]);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const toBottom = () => {
    const el = box.current;
    if (!el) return;
    pinned.current = true;
    scrolls.set(key, { top: el.scrollHeight, pinned: true });
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return { box, onScroll, away, toBottom, pin: () => (pinned.current = true) };
}

function HeaderActions({ space, thread }: { space: SpaceView; thread: string }) {
  const deleteThread = useNav((s) => s.deleteThread);
  const newChat = useNav((s) => s.newChat);
  const running = useConv(space.id, thread).running;
  return (
    <Menu>
      <MenuTrigger render={<button type="button" aria-label="Conversation actions" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />}>
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void newChat(space.id)}>
          <SquarePenIcon />
          New chat
        </MenuItem>
        <MenuItem onClick={() => void api.showSpace(space.id).catch((e) => toast.error("Couldn’t show the folder", errorText(e)))}>
          <FolderOpenIcon />
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
          <Trash2Icon />
          Delete conversation
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function ChatView({ space }: { space: SpaceView }) {
  const thread = useOpenThread(space.id);
  const key = chatKey(space.id, thread);
  const chat = useConv(space.id, thread);
  const load = useChats((s) => s.load);
  const edit = useChats((s) => s.edits[key] ?? null);
  const setEdit = (e: EditTarget | null) => useChats.getState().setEdit(space.id, thread, e);
  const listedTitle = useNav((s) => (thread === DRAFT ? undefined : s.threads[space.id]?.data?.find((t) => t.id === thread)?.title));
  const spaces = useNav((s) => s.spaces.data) ?? NO_SPACES;
  const loadCatalog = useCatalog((s) => s.load);

  // Opening a conversation shows what was there at once and refreshes it quietly.
  useEffect(() => {
    void load(space.id, thread);
  }, [space.id, thread, load]);
  useEffect(() => void loadCatalog(), [loadCatalog]);

  const last = chat.messages[chat.messages.length - 1];
  const followKey = last ? `${chat.messages.length}:${last.role === "assistant" ? last.parts.length + (last.parts.at(-1)?.type === "text" ? (last.parts.at(-1) as { text: string }).text.length : 0) : 0}` : "0";
  const empty = chat.messages.length === 0 && (thread === DRAFT || chat.status === "ready");
  const failed = chat.status === "error" && chat.messages.length === 0;
  const { box, onScroll, away, toBottom, pin } = useFollow(key, followKey, !empty && !failed);
  const showSkeleton = useDelayed(chat.status === "loading" && chat.messages.length === 0);
  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  const lastUserIndex = [...chat.messages].reverse().find((m) => m.role === "user")?.index;
  // A conversation never shows "New chat" while it loads: its listed title, else its first message.
  const firstUser = chat.messages.find((m) => m.role === "user");
  const title = thread === DRAFT ? "New chat" : (listedTitle ?? (firstUser?.role === "user" ? firstUser.text.split(/\s+/).join(" ").slice(0, 60) : undefined) ?? "Conversation");

  const retry = () => {
    const u = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!u || u.role !== "user") return;
    pin();
    void useChats.getState().send(space.id, { prompt: u.text, uploads: [], shown: u.attachments, replaceFrom: u.index, keepAttachments: u.attachments.map((a) => a.path!).filter(Boolean) }, thread);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={title} actions={<HeaderActions space={space} thread={thread} />} />
      {/* One composer per conversation, keyed by it, so each keeps its own draft, files and edit. */}
      {failed ? (
        <div className="mx-auto w-full max-w-(--chat-max-width) flex-1 px-4 pt-8">
          <SurfaceError title="Couldn’t open this conversation" message={chat.error} onRetry={() => void load(space.id, thread)} />
        </div>
      ) : empty ? (
        <div className="flex flex-1 flex-col items-center justify-end px-4">
          <div className="mb-5 flex flex-col items-center gap-3 text-center">
            <SpaceAvatar name={space.name} hue={space.hue} className="size-8 rounded-lg text-sm" />
            <h1 className="font-semibold text-xl tracking-[-0.015em]">What are we working on?</h1>
            <p className="max-w-sm text-muted-foreground text-sm">
              {space.educationEnabled ? "Ask about your courses, get a concept taught step by step, or make a practice quiz." : `Phaethon works inside ${space.name}: its files, its memory, nothing else.`}
            </p>
          </div>
        </div>
      ) : (
        <div ref={box} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]">
          {showSkeleton ? <SkeletonTurns /> : null}
          <div className="mx-auto flex w-full max-w-(--chat-max-width) flex-col gap-5 px-4 pt-6 pb-8">
            {chat.messages.map((m, i) =>
              m.role === "user" ? (
                <UserMessage
                  key={m.key}
                  m={m}
                  space={space.id}
                  canEdit={!chat.running && m.index !== undefined && m.index === lastUserIndex}
                  onEdit={() => m.index !== undefined && setEdit({ index: m.index, text: m.text, attachments: m.attachments.filter((a) => a.path) })}
                />
              ) : (
                <AssistantMessage key={m.key} m={m} space={space.id} last={i === chat.messages.length - 1} running={chat.running} startedAt={chat.startedAt} spaceName={spaceName} onRetry={retry} />
              ),
            )}
          </div>
        </div>
      )}
      <div className={cn("relative", empty && "px-4")}>
        {empty ? null : (
          <button
            type="button"
            onClick={toBottom}
            aria-label="Jump to latest"
            className={cn(
              "absolute -top-10 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-popover px-2.5 text-muted-foreground text-xs shadow-sm/5 transition-[opacity,transform] hover:text-foreground",
              away ? "opacity-100" : "pointer-events-none translate-y-1 opacity-0",
            )}
          >
            <ArrowDownIcon className="size-3" strokeWidth={2.25} />
            {chat.running ? "Following reply" : "Latest"}
          </button>
        )}
        <Composer key={key} draftKey={key} space={space} edit={edit} onEditDone={() => setEdit(null)} hero={empty} />
      </div>
      {empty ? <div className="flex-1 pb-[12vh]" /> : null}
    </div>
  );
}
