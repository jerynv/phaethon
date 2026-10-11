import { useEffect, useRef } from "react";

/**
 * Put words in a space's message box from elsewhere ("Ask about this
 * course"), for the person to read, change and send. Nothing is sent. A
 * request waits here until that space's conversation takes it, so a space not
 * opened yet in this session gets it once it mounts.
 */
const EVENT = "phaethon:compose";
const pending = new Map<string, string>();

export function requestCompose(space: string, text: string): void {
  pending.set(space, text);
  window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: space }));
}

/** In a space's conversation: take the words asked for, now and whenever more come. */
export function useComposeRequests(space: string, put: (text: string) => void): void {
  const putRef = useRef(put);
  putRef.current = put;
  useEffect(() => {
    const take = () => {
      const text = pending.get(space);
      if (text === undefined) return;
      pending.delete(space);
      putRef.current(text);
    };
    take();
    const on = (e: Event) => (e as CustomEvent<string>).detail === space && take();
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, [space]);
}
