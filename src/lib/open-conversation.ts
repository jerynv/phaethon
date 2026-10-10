import { useEffect, useRef, useState, type RefObject } from "react";

import { announce } from "@/components/shell/announcer";
import { openThread } from "@/lib/backend";

/**
 * Show one message of a saved conversation (from Search conversations): the
 * space's pane opens that conversation (as its conversations menu would) and
 * then scrolls to the message, focuses it and marks it for a moment.
 *
 * A request waits here until the space's pane takes it, so a space not opened
 * yet in this session gets it as soon as it mounts.
 */
export type OpenRequest = {
  space: string;
  /** "current" or an archive id, as threads_list gives it. */
  thread: string;
  /** The message's position in the conversation as shown (search's `message`). */
  message: number;
  title: string;
};

const EVENT = "phaethon:open-conversation";
const pending = new Map<string, OpenRequest>();
/** How long a found message stays marked. */
const MARK_MS = 2400;

export function requestOpenConversation(r: OpenRequest): void {
  pending.set(r.space, r);
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: r.space }));
}

/** The shown messages of a conversation log, in order. */
const messagesIn = (log: Element) => log.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]');

/** Scroll to the message, focus it (it is an article with its own heading) and mark it briefly. */
function showMessage(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) el.tabIndex = -1;
  // Centred, unless it is taller than the conversation: then its start (and heading) shows.
  const log = el.closest('[role="log"]');
  const tall = !!log && el.getBoundingClientRect().height > log.getBoundingClientRect().height * 0.8;
  const reveal = () => el.scrollIntoView({ block: tall ? "start" : "center" });
  reveal();
  el.focus({ preventScroll: true });
  el.setAttribute("data-found-message", "");
  // The new conversation's log may still settle (code blocks, images): look again once it has.
  setTimeout(reveal, 150);
  setTimeout(() => el.removeAttribute("data-found-message"), MARK_MS);
}

/**
 * Wait for a newly mounted conversation (a log other than `before`) to show
 * message `n`, then show it. Gives up after a few seconds (the composer keeps focus).
 */
function showWhenMounted(pane: RefObject<HTMLElement | null>, before: Element | null, n: number) {
  const started = performance.now();
  const tick = () => {
    const log = pane.current?.querySelector('[role="log"]');
    const el = log && log !== before ? messagesIn(log)[n] : undefined;
    if (el) {
      // After the pane's own focus on mount (the composer).
      requestAnimationFrame(() => showMessage(el));
      return;
    }
    if (performance.now() - started < 5000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/**
 * In a space's pane: take open requests for this space. `onSwitched` remounts
 * the conversation (as a switch from the conversations menu does). Refused
 * while a reply runs there, as switching conversations is. Returns how many
 * have been opened (a key for what must show the newly opened conversation).
 */
export function useOpenRequests(
  spaceId: string,
  running: boolean,
  onSwitched: (message: string) => void,
  pane: RefObject<HTMLElement | null>,
): number {
  const [opened, setOpened] = useState(0);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => {
    let live = true;
    const take = async () => {
      const r = pending.get(spaceId);
      if (!r) return;
      pending.delete(spaceId);
      if (runningRef.current) {
        announce("Phaethon is still replying in this space. Stop the reply or wait for it to finish, then open the conversation again.");
        return;
      }
      const before = pane.current?.querySelector('[role="log"]') ?? null;
      try {
        if (r.thread !== "current") await openThread(spaceId, r.thread);
      } catch (e) {
        announce(String(e));
        return;
      }
      if (!live) return;
      setOpened((n) => n + 1);
      onSwitched(`Opened the conversation “${r.title}”.`);
      showWhenMounted(pane, before, r.message);
    };
    const onRequest = (e: Event) => {
      if ((e as CustomEvent<string>).detail === spaceId) void take();
    };
    window.addEventListener(EVENT, onRequest);
    // A request made before this pane was mounted.
    void take();
    return () => {
      live = false;
      window.removeEventListener(EVENT, onRequest);
    };
  }, [spaceId, onSwitched, pane]);
  return opened;
}
