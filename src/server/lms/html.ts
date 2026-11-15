import { isRustWhitespace, oneLine, rustTrim, rustTrimEnd } from "./types.ts";

/**
 * Course HTML (syllabus, pages, assignment bodies, announcements) to Markdown,
 * plus a plain-text scan that finds links with the sentence around them. A
 * small hand-rolled tokenizer: course HTML is messy, and this never throws.
 *
 * Differences from the Rust original, on purpose: content after a `<nav>`,
 * `<form>` or `<iframe>` is kept (the skip region ends at its own closing tag),
 * a `<head>` without `</head>` ends at `<body>`, and `<title>` outside the head
 * no longer leaks into the text.
 */

const DROPPED = new Set(["script", "style", "noscript", "template", "head", "title", "svg", "math", "select", "textarea", "button", "object", "canvas"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "wbr", "param"]);

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  times: "×",
  divide: "÷",
  deg: "°",
  plusmn: "±",
  le: "≤",
  ge: "≥",
  ne: "≠",
  rarr: "→",
  larr: "←",
  shy: "",
  zwj: "",
  zwnj: "",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  ccedil: "ç",
};

type Token = { t: "open"; name: string; attrs: [string, string][]; closed: boolean } | { t: "close"; name: string } | { t: "text"; s: string };

const ENTITY_CHAR = /[A-Za-z0-9#]/;

/** Common named entities and numeric references; anything unknown stays as written. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  let out = "";
  let rest = s;
  for (;;) {
    const i = rest.indexOf("&");
    if (i < 0) break;
    out += rest.slice(0, i);
    rest = rest.slice(i);
    let e = 1;
    while (e < rest.length && ENTITY_CHAR.test(rest[e])) e++;
    const ent = rest.slice(1, e);
    let ch: string | null = Object.prototype.hasOwnProperty.call(NAMED, ent) ? NAMED[ent] : null;
    if (ch === null) {
      let cp: number | null = null;
      if (/^#[xX][0-9A-Fa-f]+$/.test(ent)) cp = parseInt(ent.slice(2), 16);
      else if (/^#[0-9]+$/.test(ent)) cp = parseInt(ent.slice(1), 10);
      if (cp !== null && cp <= 0xffffffff && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) ch = String.fromCodePoint(cp);
    }
    if (ch !== null && ent.length > 0) {
      out += ch;
      rest = rest.slice(e);
      if (rest.startsWith(";")) rest = rest.slice(1);
    } else {
      out += "&";
      rest = rest.slice(1);
    }
  }
  return out + rest;
}

const ATTR_WS = /[\t\n\f\r ]/;

function attributes(html: string, start: number): { attrs: [string, string][]; end: number; selfClosed: boolean } {
  const attrs: [string, string][] = [];
  let at = start;
  let selfClosed = false;
  const n = html.length;
  for (;;) {
    while (at < n && ATTR_WS.test(html[at])) at++;
    if (at >= n) return { attrs, end: at, selfClosed };
    if (html[at] === ">") return { attrs, end: at + 1, selfClosed };
    if (html[at] === "/") {
      selfClosed = true;
      at++;
      continue;
    }
    selfClosed = false;
    const nameStart = at;
    while (at < n && !ATTR_WS.test(html[at]) && html[at] !== "=" && html[at] !== ">" && html[at] !== "/") at++;
    const name = asciiLower(html.slice(nameStart, at));
    while (at < n && ATTR_WS.test(html[at])) at++;
    let value = "";
    if (at < n && html[at] === "=") {
      at++;
      while (at < n && ATTR_WS.test(html[at])) at++;
      if (at < n && (html[at] === '"' || html[at] === "'")) {
        const q = html[at];
        let end = html.indexOf(q, at + 1);
        if (end < 0) end = n;
        value = decodeEntities(html.slice(at + 1, end));
        at = Math.min(end + 1, n);
      } else {
        const v = at;
        while (at < n && !ATTR_WS.test(html[at]) && html[at] !== ">") at++;
        value = decodeEntities(html.slice(v, at));
      }
    }
    if (name) attrs.push([name, value]);
    if (at === nameStart) at++;
  }
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function tokens(html: string): Token[] {
  const out: Token[] = [];
  const lower = asciiLower(html);
  const n = html.length;
  let i = 0;
  let textStart = 0;
  const flush = (a: number, b: number) => {
    if (b > a) out.push({ t: "text", s: decodeEntities(html.slice(a, b)) });
  };
  while (i < n) {
    if (html[i] !== "<") {
      i++;
      continue;
    }
    if (lower.startsWith("<!--", i)) {
      flush(textStart, i);
      const e = lower.indexOf("-->", i);
      i = e >= 0 ? e + 3 : n;
      textStart = i;
      continue;
    }
    if (lower.startsWith("<!", i) || lower.startsWith("<?", i)) {
      flush(textStart, i);
      const e = lower.indexOf(">", i);
      i = e >= 0 ? e + 1 : n;
      textStart = i;
      continue;
    }
    const closing = lower.startsWith("</", i);
    const nameAt = i + (closing ? 2 : 1);
    let len = 0;
    while (nameAt + len < n && /[A-Za-z0-9:-]/.test(html[nameAt + len])) len++;
    if (len === 0 || !/[A-Za-z]/.test(html[nameAt])) {
      i++;
      continue;
    }
    flush(textStart, i);
    const name = lower.slice(nameAt, nameAt + len);
    const { attrs, end, selfClosed } = attributes(html, nameAt + len);
    i = end;
    textStart = i;
    if (closing) {
      out.push({ t: "close", name });
      continue;
    }
    if (DROPPED.has(name) && !selfClosed) {
      let e = lower.indexOf(`</${name}`, i);
      if (name === "head") {
        // `</head>` is optional: the head also ends where the body starts.
        const body = lower.indexOf("<body", i);
        if (body >= 0 && (e < 0 || body < e)) {
          i = body;
          textStart = i;
          continue;
        }
      }
      if (e < 0 && (name === "head" || name === "title")) continue;
      i = e >= 0 ? e : n;
      e = lower.indexOf(">", i);
      i = e >= 0 ? e + 1 : n;
      textStart = i;
      continue;
    }
    out.push({ t: "open", name, attrs, closed: selfClosed || VOID.has(name) });
  }
  flush(textStart, n);
  return out;
}

function attr(attrs: [string, string][], name: string): string | null {
  const f = attrs.find((a) => a[0] === name);
  return f ? f[1] : null;
}

/** An http(s) or mailto link, resolved against `base`; fragments-only and other schemes give null. */
export function resolve(base: URL | null, href: string): URL | null {
  const h = rustTrim(href);
  if (!h || h.startsWith("#")) return null;
  let u: URL;
  try {
    u = base ? new URL(h, base) : new URL(h);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:" ? u : null;
}

/** Resource addresses in real HTML attributes (including Canvas's API hints). */
export function resourceUrls(html: string, base: URL): URL[] {
  const found = new Map<string, URL>();
  for (const t of tokens(html)) {
    if (t.t !== "open") continue;
    for (const [name, value] of t.attrs) {
      if (name !== "href" && name !== "src" && name !== "data-api-endpoint") continue;
      const u = resolve(base, value);
      if (u) found.set(u.href, u);
    }
  }
  return [...found.values()];
}

function isControl(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
}

function pushCollapsed(o: string, s: string): string {
  let out = o;
  for (const c of s) {
    if (isRustWhitespace(c)) {
      if (out.length && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
    } else if (!isControl(c)) out += c;
  }
  return out;
}

const SCAN_BLOCK = new Set(["p", "div", "section", "article", "main", "header", "footer", "nav", "aside", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "br", "hr", "dd", "dt", "dl", "figure", "figcaption"]);

export type FoundLink = { url: URL; text: string; context: string };
export type Scan = { text: string; links: FoundLink[]; title: string | null };

/** The page's `<title>`, whitespace collapsed, at most 200 characters. */
export function pageTitle(html: string): string | null {
  const lower = asciiLower(html);
  const o = lower.indexOf("<title");
  if (o < 0) return null;
  const g = lower.indexOf(">", o);
  if (g < 0) return null;
  const e = lower.indexOf("</title", g + 1);
  if (e < 0) return null;
  const t = [...oneLine(decodeEntities(html.slice(g + 1, e)))].slice(0, 200).join("");
  return t || null;
}

function cpTail(s: string, n: number): string {
  const cps = [...s];
  return cps.slice(Math.max(0, cps.length - n)).join("");
}

function cpHead(s: string, n: number): string {
  return [...s].slice(0, n).join("");
}

/** Plain text of a page plus its links, each with the sentence around it. */
export function scan(html: string, base: URL | null): Scan {
  const title = pageTitle(html);
  let text = "";
  let open: [URL, number] | null = null;
  const found: [URL, string, number, number][] = [];
  for (const t of tokens(html)) {
    if (t.t === "text") text = pushCollapsed(text, t.s);
    else if (t.t === "open") {
      if (SCAN_BLOCK.has(t.name) && text && !text.endsWith("\n")) text += "\n";
      if (t.name === "a") {
        const h = attr(t.attrs, "href");
        const u = h !== null ? resolve(base, h) : null;
        open = u ? [u, text.length] : null;
      } else if (t.name === "iframe" || t.name === "embed") {
        const h = attr(t.attrs, "src");
        const u = h !== null ? resolve(base, h) : null;
        if (u) found.push([u, attr(t.attrs, "title") ?? "", text.length, text.length]);
      }
    } else {
      if (t.name === "a" && open) {
        found.push([open[0], rustTrim(text.slice(open[1])), open[1], text.length]);
        open = null;
      }
      if (SCAN_BLOCK.has(t.name) && !text.endsWith("\n")) text += "\n";
    }
  }
  const links = found.map(([url, label, start, end]) => {
    const blockStart = start > 0 ? text.lastIndexOf("\n", start - 1) + 1 : 0;
    let blockEnd = text.indexOf("\n", end);
    if (blockEnd < 0) blockEnd = text.length;
    let before = text.slice(blockStart, start);
    const bi = [". ", "! ", "? "].map((p) => before.lastIndexOf(p)).filter((x) => x >= 0);
    if (bi.length) before = before.slice(Math.max(...bi) + 2);
    let after = text.slice(end, blockEnd);
    const ai = [". ", "! ", "? "].map((p) => after.indexOf(p)).filter((x) => x >= 0);
    if (ai.length) after = after.slice(0, Math.min(...ai) + 1);
    return { url, text: label, context: cpTail(before, 150) + text.slice(start, end) + cpHead(after, 150) };
  });
  return { text, links, title };
}

type Frame =
  | { k: "root"; b: string }
  | { k: "skip"; tag: string; depth: number; b: string }
  | { k: "link"; t: string | null; b: string }
  | { k: "em"; m: string; b: string }
  | { k: "code"; b: string }
  | { k: "pre"; b: string }
  | { k: "h"; n: number; b: string }
  | { k: "item"; m: string; b: string }
  | { k: "list"; ordered: boolean; n: number; b: string }
  | { k: "quote"; b: string }
  | { k: "table"; rows: string[][]; head: boolean; b: string }
  | { k: "row"; cells: string[]; b: string }
  | { k: "cell"; b: string };

const BLOCKS = new Set(["p", "div", "section", "article", "main", "header", "footer", "aside", "figure", "figcaption", "dl", "dt", "dd", "center"]);
const CLOSES: Record<string, string> = {
  a: "link",
  strong: "em**",
  b: "em**",
  em: "em*",
  i: "em*",
  cite: "em*",
  code: "code",
  kbd: "code",
  samp: "code",
  tt: "code",
  pre: "pre",
  h1: "h",
  h2: "h",
  h3: "h",
  h4: "h",
  h5: "h",
  h6: "h",
  ul: "list",
  ol: "list",
  li: "item",
  blockquote: "quote",
  table: "table",
  tr: "row",
  td: "cell",
  th: "cell",
};

function trimSpaces(b: string): string {
  return b.replace(/ +$/, "");
}

/** Per line: trim ends outside ``` fences, collapse blank runs to one blank line, drop outer blank lines. */
function tidy(s: string): string {
  let out = "";
  let blank = 0;
  let fence = false;
  const lines = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length && lines[lines.length - 1] === "" && s.endsWith("\n")) lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("```")) fence = !fence;
    const l = fence ? raw : rustTrimEnd(raw);
    if (!rustTrim(l) && !fence) {
      blank++;
      continue;
    }
    if (out) out += blank > 0 ? "\n\n" : "\n";
    blank = 0;
    out += l;
  }
  return out;
}

const escapeLabel = (s: string) => s.replace(/\[/g, "\\[").replace(/\]/g, "\\]");

/**
 * Markdown for `html`. Links resolve against `base`; `rewrite` turns each
 * http(s) target into what the Markdown should point at (a local copy, or the
 * URL itself). mailto links are kept as written.
 */
export function toMarkdown(html: string, base: URL | null, rewrite: (u: URL) => string): string {
  const F: Frame[] = [{ k: "root", b: "" }];
  const top = () => F[F.length - 1];
  const inPre = () => F.some((f) => f.k === "pre");
  const inCell = () => F.some((f) => f.k === "cell");
  const skipFrame = (): Extract<Frame, { k: "skip" }> | undefined => F.find((f) => f.k === "skip") as Extract<Frame, { k: "skip" }> | undefined;
  const text = (s: string) => {
    if (skipFrame()) return;
    const f = top();
    if (inPre()) f.b += s;
    else f.b = pushCollapsed(f.b, s);
  };
  const block = () => {
    const c = inCell();
    const f = top();
    f.b = trimSpaces(f.b);
    if (!f.b) return;
    if (c) {
      if (!f.b.endsWith(" ")) f.b += " ";
      return;
    }
    while (!f.b.endsWith("\n\n")) f.b += "\n";
  };
  const line = () => {
    const c = inCell();
    const f = top();
    f.b = trimSpaces(f.b);
    if (!f.b || f.b.endsWith("\n")) return;
    f.b += c ? " " : "\n";
  };
  const inline = (s: string) => {
    top().b += s;
  };
  const target = (h: string): string | null => {
    const u = resolve(base, h);
    if (!u) return null;
    return u.protocol === "mailto:" ? u.href : rewrite(u);
  };

  const pop = () => {
    const f = F.pop()!;
    const inner = f.b;
    switch (f.k) {
      case "root":
      case "skip":
        return;
      case "link": {
        const label = oneLine(inner);
        if (f.t !== null) inline(`[${escapeLabel(label || f.t)}](${f.t})`);
        else inline(label);
        return;
      }
      case "em": {
        const t = rustTrim(inner);
        if (!t) {
          if (inner) text(" ");
          return;
        }
        inline(`${inner.startsWith(" ") ? " " : ""}${f.m}${t}${f.m}${inner.endsWith(" ") ? " " : ""}`);
        return;
      }
      case "code": {
        const t = rustTrim(inner);
        if (t) {
          const fence = t.includes("`") ? "``" : "`";
          inline(fence + t + fence);
        }
        return;
      }
      case "pre":
        inline("```\n" + inner.replace(/^\n+|\n+$/g, "") + "\n```");
        block();
        return;
      case "h": {
        const t = oneLine(inner);
        if (t) inline("#".repeat(Math.min(6, Math.max(1, f.n))) + " " + t);
        block();
        return;
      }
      case "item": {
        const body = tidy(inner);
        line();
        const pad = " ".repeat([...f.m].length);
        let s = "";
        body
          .split("\n")
          .filter((l) => rustTrim(l))
          .forEach((l, i) => {
            s += i === 0 ? f.m : "\n" + pad;
            s += l;
          });
        if (!s) s = rustTrimEnd(f.m);
        inline(s);
        line();
        return;
      }
      case "list": {
        const body = tidy(inner);
        line();
        inline(body);
        if (F.some((x) => x.k === "item")) line();
        else block();
        return;
      }
      case "quote": {
        const body = tidy(inner);
        inline(
          body
            .split("\n")
            .map((l) => (l ? "> " + l : ">"))
            .join("\n"),
        );
        block();
        return;
      }
      case "cell": {
        const t = oneLine(inner).replace(/\|/g, "\\|");
        const parent = top();
        if (parent.k === "row") parent.cells.push(t);
        return;
      }
      case "row": {
        for (let i = F.length - 1; i >= 0; i--) {
          const t = F[i];
          if (t.k === "table") {
            if (f.cells.length) t.rows.push(f.cells);
            break;
          }
        }
        return;
      }
      case "table": {
        const width = Math.max(0, ...f.rows.map((r) => r.length));
        if (!width) return;
        const row = (r: string[]) => {
          const c = [...r];
          while (c.length < width) c.push("");
          return `| ${c.join(" | ")} |`;
        };
        const rows = [...f.rows];
        const lines: string[] = [];
        if (f.head) lines.push(row(rows.shift()!));
        else lines.push(row(Array<string>(width).fill("")));
        lines.push("|" + " --- |".repeat(width));
        lines.push(...rows.map(row));
        block();
        inline(lines.join("\n"));
        block();
        return;
      }
    }
  };

  const open = (name: string, attrs: [string, string][], closed: boolean) => {
    const skip = skipFrame();
    if (skip) {
      // Inside a nav, form or iframe: only track nesting of the same element.
      if (!closed && name === skip.tag) skip.depth++;
      return;
    }
    if (BLOCKS.has(name)) return block();
    if ((name === "form" || name === "nav") && !closed) {
      F.push({ k: "skip", tag: name, depth: 1, b: "" });
      return;
    }
    if (name === "br") {
      const f = top();
      if (inCell()) f.b += " ";
      else if (inPre()) f.b += "\n";
      else f.b = trimSpaces(f.b) + "\n";
      return;
    }
    if (name === "hr") {
      block();
      top().b += "---";
      block();
      return;
    }
    if (/^h[1-6]$/.test(name) && !closed) {
      block();
      F.push({ k: "h", n: Number(name[1]), b: "" });
      return;
    }
    if ((name === "strong" || name === "b") && !closed) return void F.push({ k: "em", m: "**", b: "" });
    if ((name === "em" || name === "i" || name === "cite") && !closed) return void F.push({ k: "em", m: "*", b: "" });
    if ((name === "code" || name === "kbd" || name === "samp" || name === "tt") && !closed && !inPre()) return void F.push({ k: "code", b: "" });
    if (name === "pre" && !closed) {
      block();
      F.push({ k: "pre", b: "" });
      return;
    }
    if (name === "a" && !closed) {
      const h = attr(attrs, "href");
      F.push({ k: "link", t: h !== null ? target(h) : null, b: "" });
      return;
    }
    if (name === "img") {
      const alt = oneLine(attr(attrs, "alt") ?? "");
      const s = attr(attrs, "src");
      const t = s !== null ? target(s) : null;
      if (t) inline(`![${escapeLabel(alt)}](${t})`);
      else if (alt) inline(`[image: ${alt}]`);
      return;
    }
    if (name === "iframe" || name === "embed" || name === "video" || name === "audio") {
      const s = attr(attrs, "src");
      const t = s !== null ? target(s) : null;
      if (t) {
        let label = attr(attrs, "title");
        if (!label || !rustTrim(label)) label = "Embedded content";
        block();
        top().b += `[${escapeLabel(label)}](${t})`;
        block();
      }
      if (!closed && name === "iframe") F.push({ k: "skip", tag: "iframe", depth: 1, b: "" });
      return;
    }
    if ((name === "ul" || name === "ol") && !closed) {
      line();
      const st = attr(attrs, "start");
      let n = 1;
      if (st !== null && /^\+?\d+$/.test(st) && Number(st) <= 0xffffffff) n = parseInt(st, 10);
      F.push({ k: "list", ordered: name === "ol", n, b: "" });
      return;
    }
    if (name === "li" && !closed) {
      let list = -1;
      let item = -1;
      F.forEach((f, i) => {
        if (f.k === "list") list = i;
        if (f.k === "item") item = i;
      });
      if (item >= 0 && (list < 0 || item > list)) while (F.length > item) pop();
      let marker = "- ";
      for (let i = F.length - 1; i >= 0; i--) {
        const f = F[i];
        if (f.k === "list") {
          if (f.ordered) {
            marker = `${f.n}. `;
            f.n++;
          }
          break;
        }
      }
      F.push({ k: "item", m: marker, b: "" });
      return;
    }
    if (name === "blockquote" && !closed) {
      block();
      F.push({ k: "quote", b: "" });
      return;
    }
    if (name === "table" && !closed) {
      block();
      F.push({ k: "table", rows: [], head: false, b: "" });
      return;
    }
    if (name === "tr" && !closed) return void F.push({ k: "row", cells: [], b: "" });
    if ((name === "td" || name === "th") && !closed) {
      if (name === "th") {
        for (let i = F.length - 1; i >= 0; i--) {
          const f = F[i];
          if (f.k === "table") {
            if (!f.rows.length) f.head = true;
            break;
          }
        }
      }
      F.push({ k: "cell", b: "" });
    }
  };

  const close = (name: string) => {
    const skip = skipFrame();
    if (skip) {
      if (name !== skip.tag) return;
      skip.depth--;
      if (skip.depth > 0) return;
      const at = F.indexOf(skip);
      while (F.length > at) pop();
      return;
    }
    if (BLOCKS.has(name)) {
      block();
      return;
    }
    const want = CLOSES[name];
    if (!want) return;
    let at = -1;
    for (let i = F.length - 1; i >= 0; i--) {
      const f = F[i];
      const key = f.k === "em" ? "em" + f.m : f.k;
      if (key === want) {
        at = i;
        break;
      }
    }
    if (at <= 0) return;
    while (F.length > at) pop();
  };

  for (const t of tokens(html)) {
    if (t.t === "text") text(t.s);
    else if (t.t === "open") open(t.name, t.attrs, t.closed);
    else close(t.name);
  }
  while (F.length > 1) pop();
  return tidy(F[0].b);
}
