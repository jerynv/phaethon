import { CircleAlertIcon } from "lucide-react";
import { useEffect, type KeyboardEvent, type RefObject } from "react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { modKey } from "./keys";

/** True while the person is writing in the composer (focus there, with text). */
function writing(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.dataset.composer !== undefined && el.value.trim() !== "";
}

/**
 * When a card arrives (a new `id`): bring it into view, and take focus unless
 * the person is writing a message. Then the live region says it's there.
 */
export function useCardArrival(ref: RefObject<HTMLElement | null>, id: string | undefined, announce: (t: string) => void, describe: string) {
  useEffect(() => {
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      const card = ref.current;
      if (!card) return;
      card.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      if (writing()) announce(`${describe} It’s waiting in the conversation.`);
      else card.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
    // Only when a different card arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
}

/** Keys on a waiting card: Mod+Enter says yes, Mod+Backspace says no. */
export function cardKeys(yes: () => void, no: () => void, busy: boolean) {
  return (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || (e.key !== "Enter" && e.key !== "Backspace")) return;
    if ((e.target as HTMLElement).tagName === "TEXTAREA" && e.key === "Backspace") return;
    e.preventDefault();
    if (busy) return;
    if (e.key === "Enter") yes();
    else no();
  };
}

export function KeyHint({ keyName }: { keyName: string }) {
  return (
    <KbdGroup aria-hidden className="ms-1 hidden @md/card:inline-flex">
      <Kbd className="bg-current/10 text-current">{modKey()}</Kbd>
      <Kbd className="bg-current/10 text-current">{keyName}</Kbd>
    </KbdGroup>
  );
}

export function CardProblem({ text }: { text: string }) {
  return (
    <p role="alert" className="me-auto flex min-w-0 items-start gap-1.5 text-sm">
      <CircleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <span>{text}</span>
    </p>
  );
}

export const cardShell =
  "@container/card ph-block flex w-full flex-col overflow-clip rounded-xl border bg-card text-card-foreground shadow-[0_6px_24px_-14px_rgb(0_0_0/0.3)] outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The answer row: sticks to the bottom of the conversation while the card runs past it. */
export const cardActions = "sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t bg-card px-4 py-3";
