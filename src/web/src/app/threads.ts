import { useEffect, useState } from "react";
import { errorText } from "@/lib/core";
import { announce } from "@/lib/announce";
import { requestWorkspaceFocus } from "@/lib/workspaceFocus";
import { api, type ThreadSummary } from "./api";
import { useNav } from "./nav";

/**
 * Conversation actions shared by the sidebar, search and shortcuts. Each one
 * calls the core, then tells the chat (bumpThread) and the list
 * (bumpThreadList) to reload.
 */

export async function newConversation(spaceId: string): Promise<string | null> {
  try {
    await api.newThread(spaceId);
  } catch (e) {
    return errorText(e);
  }
  const nav = useNav.getState();
  nav.go({ kind: "chat" }, spaceId);
  nav.bumpThread();
  nav.bumpThreadList();
  announce("New conversation");
  requestWorkspaceFocus("main");
  return null;
}

export async function openConversation(spaceId: string, id: string): Promise<string | null> {
  try {
    if (id !== "current") await api.openThread(spaceId, id);
  } catch (e) {
    return errorText(e);
  }
  const nav = useNav.getState();
  nav.go({ kind: "chat", conversation: "current" }, spaceId);
  nav.bumpThread();
  nav.bumpThreadList();
  return null;
}

export async function deleteConversation(spaceId: string, id: string): Promise<string | null> {
  try {
    await api.deleteThread(spaceId, id);
  } catch (e) {
    return errorText(e);
  }
  const nav = useNav.getState();
  if (id === "current") nav.bumpThread();
  nav.bumpThreadList();
  announce("Conversation deleted");
  return null;
}

export type ThreadList = {
  threads: ThreadSummary[] | null;
  error: string | null;
  reload(): void;
};

/** The space's conversations, reloaded whenever navigation says the list may have changed. */
export function useThreadList(spaceId: string): ThreadList {
  const version = useNav((s) => s.threadListVersion);
  const [state, setState] = useState<{ spaceId: string; threads: ThreadSummary[] | null; error: string | null }>({
    spaceId,
    threads: null,
    error: null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.threads(spaceId).then(
      (threads) => live && setState({ spaceId, threads, error: null }),
      (e) => live && setState((s) => ({ spaceId, threads: s.spaceId === spaceId ? s.threads : null, error: errorText(e) })),
    );
    return () => {
      live = false;
    };
  }, [spaceId, version, tick]);

  const sameSpace = state.spaceId === spaceId;
  return {
    threads: sameSpace ? state.threads : null,
    error: sameSpace ? state.error : null,
    reload: () => setTick((t) => t + 1),
  };
}

/** Shown in place of an empty conversation's title. */
export const UNTITLED = "New conversation";

/** A conversation is worth listing once it has messages, or when it's the one open. */
export function visibleThreads(threads: ThreadSummary[]): ThreadSummary[] {
  return threads.filter((t) => t.messages > 0 || t.current);
}
