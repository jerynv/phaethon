/**
 * Citations in a reply: `[source: courses/<folder>/<file> "words copied from it"]`.
 * Found in the text outside code and carried to the renderer as a link whose
 * address is the citation itself, so a chip can check it. Pure.
 */

/** A citation as written: the path, then the quote in straight or curly double quotes. */
const CITE = /\[source:\s*([^\]"“”\n]+?)\s*["“]([^"”\n]{1,1200})["”]\s*\]/g;

/** The address a citation is carried in: a fragment, so markdown keeps it and nothing follows it. */
const PREFIX = "#phaethon-cite:";

export type Citation = { path: string; quote: string };

/** The file's name, for the chip. */
export const citeName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

const escapeLinkText = (s: string) => s.replace(/[\\[\]*_`$<>]/g, (c) => `\\${c}`);

function link(c: Citation): string {
  const enc = encodeURIComponent(JSON.stringify([c.path, c.quote])).replace(
    /[()!*~']/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `[${escapeLinkText(citeName(c.path))}](${PREFIX}${enc})`;
}

/** The citation a link's address carries, or null for any other address. */
export function citationOf(href: string | undefined): Citation | null {
  if (!href?.startsWith(PREFIX)) return null;
  try {
    const v: unknown = JSON.parse(decodeURIComponent(href.slice(PREFIX.length)));
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return { path: v[0], quote: v[1] };
  } catch {
    // Not one of ours.
  }
  return null;
}

/**
 * The text with each citation outside code made a link to it. Fenced blocks
 * (```, ~~~) and inline code are left as written; a citation still being
 * written (no closing `"]` yet) stays text until it is whole.
 */
export function markCitations(text: string): string {
  if (!text.includes("[source:")) return text;
  const out: string[] = [];
  let fence: string | null = null;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) out.push(markProse(prose.join("\n")));
    prose = [];
  };
  for (const line of text.split("\n")) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      out.push(line);
      if (open && line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") fence = null;
      continue;
    }
    if (open) {
      flush();
      fence = open[1]!;
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n");
}

function markProse(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const tick = text.indexOf("`", i);
    const end = tick < 0 ? text.length : tick;
    out += text.slice(i, end).replace(CITE, (_, path: string, quote: string) => link({ path: path.trim(), quote: quote.trim() }));
    if (tick < 0) break;
    const run = /^`+/.exec(text.slice(tick))![0];
    const close = text.indexOf(run, tick + run.length);
    if (close < 0) {
      out += text.slice(tick);
      break;
    }
    out += text.slice(tick, close + run.length);
    i = close + run.length;
  }
  return out;
}

/** Every citation in `text` outside code, in order. */
export function citationsIn(text: string): Citation[] {
  const found: Citation[] = [];
  for (const m of markCitations(text).matchAll(/\(#phaethon-cite:([^)]+)\)/g)) {
    const c = citationOf(`${PREFIX}${m[1]}`);
    if (c) found.push(c);
  }
  return found;
}
