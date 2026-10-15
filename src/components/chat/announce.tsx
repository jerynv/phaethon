import { createContext, useContext } from "react";

/**
 * Say something once through the thread's single polite status region
 * ("Reply copied."). Provided by Thread; a no-op outside it.
 */
export const AnnounceContext = createContext<(text: string) => void>(() => {});

export const useAnnounce = () => useContext(AnnounceContext);

/**
 * Markdown as it should be spoken: no #, **, `, > or table pipes; a code
 * block becomes "(code)", a heading ends with a full stop so it doesn't run
 * into the next sentence, and table cells are separated by commas.
 */
export function plainText(md: string): string {
  return md
    .replace(/```phaethon-actions[\s\S]*?(?:```|$)/g, " ") // buttons, said by themselves (chat-actions.tsx)
    .replace(/```[\s\S]*?(?:```|$)/g, " (code) ")
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, "")
    .replace(/^\s*\|/gm, "")
    .replace(/\s*\|\s*$/gm, ".")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+(.*)$/gm, (_, h: string) => (/[.!?:]$/.test(h.trim()) ? h : `${h.trim()}.`))
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
    .replace(/\*\*|__|~~|`|(?<![\w*])\*(?!\s)|(?<!\s)\*(?![\w*])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** About two sentences of a reply, for the completion announcement (C5). */
export const SPOKEN_REPLY_MAX = 200;

export function spokenReply(md: string): string {
  const plain = plainText(md);
  if (plain.length <= SPOKEN_REPLY_MAX) return plain;
  // A full stop inside a word ("syllabus.md") doesn't end a sentence.
  const sentences = plain.match(/.+?[.!?]+(?=\s|$)\s*/g) ?? [];
  let out = "";
  for (const s of sentences) {
    if ((out + s).length > SPOKEN_REPLY_MAX) break;
    out += s;
  }
  if (!out) out = `${plain.slice(0, SPOKEN_REPLY_MAX - 20).replace(/\s+\S*$/, "")}…`;
  return `${out.trim()} The rest is in the conversation.`;
}

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
