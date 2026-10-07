import { useEffect, useState } from "react";

/**
 * One polite status region for the shell: space switches ("Work, 12
 * messages"), a background space that needs you, grant revokes. Anything in
 * the shell calls announce(); the region lives in the title bar.
 */
const listeners = new Set<(message: string) => void>();

/** Say `message` politely. The same words twice are said twice. */
export function announce(message: string): void {
  listeners.forEach((l) => l(message));
}

export function ShellAnnouncer() {
  const [text, setText] = useState("");
  useEffect(() => {
    let frame = 0;
    const on = (m: string) => {
      // Clear first, then set on the next frame, so a repeat is a change.
      cancelAnimationFrame(frame);
      setText("");
      frame = requestAnimationFrame(() => setText(m));
    };
    listeners.add(on);
    return () => {
      cancelAnimationFrame(frame);
      listeners.delete(on);
    };
  }, []);
  return (
    <p role="status" className="sr-only" data-shell-status="">
      {text}
    </p>
  );
}
