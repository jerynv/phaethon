/**
 * Release notes as the update dialogs show them. The core hands over plain
 * text (GitHub's HTML with tags removed, list items as "- " lines); this
 * splits it into paragraphs and bullets and drops what only makes sense on
 * the releases web page (download links, file names, Gatekeeper steps).
 * Pure; tested in notes.test.ts.
 */

export type NoteBlock = { kind: "text"; text: string } | { kind: "list"; items: { lead: string | null; text: string }[] };

/** Lines about downloading or installing by hand: true on the web page, noise inside the app that updates itself. */
const WEB_ONLY = [
  /download (the )?installer/i,
  /assets below/i,
  /\.(dmg|exe|appimage|deb|zip)\b/i,
  /xattr\b/i,
  /open anyway/i,
  /smartscreen/i,
  /can(’|')?t update itself/i,
  /can also update from inside the app/i,
  /signed with an apple developer/i,
  /^\*\*?(macos|windows|linux):/i,
];

/** A release's own heading ("New in 0.3.0", "What’s new in 0.3.1"): the dialog's title already says it. */
const HEADING = /^(new|what[’']s new|changes|changelog|highlights)( in (phaethon )?v?\d+(\.\d+)*)?:?$/i;

const strip = (s: string) =>
  s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

/** A bullet's short first sentence becomes its lead ("Figures are drawn again."), the rest its body. */
function splitLead(raw: string): { lead: string | null; text: string } {
  const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(raw.trim());
  if (bold) return { lead: strip(bold[1]!), text: strip(bold[2]!) };
  const text = strip(raw);
  const m = /^(.{3,72}?[.:])\s+(\S.*)$/.exec(text);
  if (m && !/\b(e\.g|i\.e|etc|vs)\.$/i.test(m[1]!)) return { lead: m[1]!, text: m[2]! };
  return { lead: null, text };
}

export function parseNotes(notes: string | null | undefined): NoteBlock[] {
  if (!notes) return [];
  const blocks: NoteBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    const text = strip(para.join(" "));
    if (text && !HEADING.test(text) && !WEB_ONLY.some((r) => r.test(text))) blocks.push({ kind: "text", text });
    para = [];
  };
  // A dash alone on its line (a list item whose text GitHub put on the next line) joins that next line.
  const text = notes.replace(/\r\n?/g, "\n").replace(/^([ \t]*[-*•])[ \t]*\n[ \t]*(?=\S)/gm, "$1 ");
  for (const line of text.split("\n")) {
    const t = line.trim();
    const bullet = /^[-*•]\s+(.*)$/.exec(t);
    if (!t) {
      flush();
      continue;
    }
    if (/^#{1,6}\s/.test(t) || /^\*\*[^*]+\*\*$/.test(t)) {
      // Headings like "New in 0.3.0" repeat the dialog's own title.
      flush();
      continue;
    }
    if (bullet) {
      flush();
      if (WEB_ONLY.some((r) => r.test(bullet[1]!))) continue;
      const last = blocks.at(-1);
      const item = splitLead(bullet[1]!);
      if (!item.text && !item.lead) continue;
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", items: [item] });
      continue;
    }
    para.push(t);
  }
  flush();
  // "Pre-alpha desktop build…" style preambles stay; a lone paragraph that was all download text is gone already.
  return blocks;
}

/** Whether a version string is newer than another (numeric x.y.z; anything unparsable is not newer). */
export function isNewer(version: string, than: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(than);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}
