import { createContext, useContext } from "react";

/**
 * Say something once through the thread's single polite status region
 * ("Reply copied."). Provided by Thread; a no-op outside it.
 */
export const AnnounceContext = createContext<(text: string) => void>(() => {});

export const useAnnounce = () => useContext(AnnounceContext);

/**
 * Text from the backend with `inline code` in backticks, rendered with the
 * backticks turned into code spans ("run `claude` once" shows claude as code).
 */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/`([^`]+)`/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <code key={i} className="rounded-xs border border-line bg-surface px-1 py-px font-mono text-sm">
            {p}
          </code>
        ) : (
          p
        ),
      )}
    </>
  );
}
