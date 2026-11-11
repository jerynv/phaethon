import { ArrowDownIcon, EllipsisIcon, FolderOpenIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { Header } from "@/app/Header";
import { NO_SPACES, useNav } from "@/app/store";
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
import { useChats, useSpaceChat } from "./store";

/** Follows the bottom while new content arrives, unless the user scrolled up to read. */
function useFollow(dep: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    pinned.current = near;
    setAway(!near);
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const toBottom = () => {
    const el = box.current;
    if (!el) return;
    pinned.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };
  return { box, onScroll, away, toBottom, pin: () => (pinned.current = true) };
}

function HeaderActions({ space, empty }: { space: SpaceView; empty: boolean }) {
  const deleteThread = useNav((s) => s.deleteThread);
  const newChat = useNav((s) => s.newChat);
  return (
    <Menu>
      <MenuTrigger render={<button type="button" aria-label="Conversation actions" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" />}>
        <EllipsisIcon className="size-4" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void newChat(space.id).catch((e) => toast.error("Couldn’t start a new chat", errorText(e)))}>
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
          disabled={empty}
          onClick={() =>
            void deleteThread(space.id, "current").then(
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
  const chat = useSpaceChat(space.id);
  const load = useChats((s) => s.load);
  const epoch = useNav((s) => s.threadEpoch[space.id] ?? 0);
  const title = useNav((s) => s.threads[space.id]?.data?.find((t) => t.current)?.title);
  const spaces = useNav((s) => s.spaces.data) ?? NO_SPACES;
  const loadCatalog = useCatalog((s) => s.load);
  const [edit, setEdit] = useState<EditTarget | null>(null);

  useEffect(() => {
    void load(space.id);
    setEdit(null);
  }, [space.id, epoch, load]);
  useEffect(() => void loadCatalog(), [loadCatalog]);

  const last = chat.messages[chat.messages.length - 1];
  const followKey = last ? `${chat.messages.length}:${last.role === "assistant" ? last.parts.length + (last.parts.at(-1)?.type === "text" ? (last.parts.at(-1) as { text: string }).text.length : 0) : 0}` : "0";
  const { box, onScroll, away, toBottom, pin } = useFollow(followKey);
  const showSkeleton = useDelayed(chat.status === "loading" && chat.messages.length === 0);
  const spaceName = (id: string) => spaces.find((s) => s.id === id)?.name ?? id;
  const empty = chat.status === "ready" && chat.messages.length === 0;
  const lastUserIndex = [...chat.messages].reverse().find((m) => m.role === "user")?.index;

  const retry = () => {
    const u = [...chat.messages].reverse().find((m) => m.role === "user");
    if (!u || u.role !== "user") return;
    pin();
    void useChats.getState().send(space.id, { prompt: u.text, uploads: [], shown: u.attachments, replaceFrom: u.index, keepAttachments: u.attachments.map((a) => a.path!).filter(Boolean) });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={empty || chat.status === "loading" ? "New chat" : (title ?? "Conversation")} actions={<HeaderActions space={space} empty={empty} />} />
      {chat.status === "error" && chat.messages.length === 0 ? (
        <div className="mx-auto w-full max-w-(--chat-max-width) px-4 pt-8">
          <SurfaceError title="Couldn’t open this conversation" message={chat.error} onRetry={() => void load(space.id)} />
        </div>
      ) : empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 pb-[12vh]">
          <div className="mb-5 flex flex-col items-center gap-3 text-center">
            <SpaceAvatar name={space.name} hue={space.hue} className="size-8 rounded-lg text-sm" />
            <h1 className="font-semibold text-xl tracking-[-0.015em]">What are we working on?</h1>
            <p className="max-w-sm text-muted-foreground text-sm">
              {space.educationEnabled ? "Ask about your courses, get a concept taught step by step, or make a practice quiz." : `Phaethon works inside ${space.name}: its files, its memory, nothing else.`}
            </p>
          </div>
          <div className="w-full max-w-(--chat-max-width)">
            <Composer space={space} edit={edit} onEditDone={() => setEdit(null)} hero />
          </div>
        </div>
      ) : (
        <>
          <div ref={box} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto [overflow-anchor:none]">
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
          <div className="relative">
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
            <Composer space={space} edit={edit} onEditDone={() => setEdit(null)} />
          </div>
        </>
      )}
    </div>
  );
}
