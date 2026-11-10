import zlib from "node:zlib";

/**
 * Just enough of a PDF object reader to see what pictures a page draws and to
 * hand a stored picture on as it is: objects (also inside object streams),
 * dictionaries, streams with their stored bytes, the page tree, and a
 * content-stream tokenizer. Lenient: anything it can't read is skipped, never
 * thrown. Text and drawing use pdfjs; this only looks at the raw objects.
 *
 * Only ever run on a PDF from the internet inside a child process, with every
 * inflate bounded.
 */

export type Name = { t: "name"; v: string };
export type Ref = { t: "ref"; n: number; g: number };
export type Str = { t: "str"; v: Buffer };
export type Op = { t: "op"; v: string };
export type Dict = { t: "dict"; d: Map<string, Obj> };
export type Stream = { t: "stream"; dict: Map<string, Obj>; data: Buffer };
export type Obj = null | boolean | number | Name | Ref | Str | Dict | Stream | Op | Obj[];

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export function isName(o: Obj | undefined, v?: string): o is Name {
  return !!o && typeof o === "object" && !Array.isArray(o) && o.t === "name" && (v === undefined || o.v === v);
}
export function isRef(o: Obj | undefined): o is Ref {
  return !!o && typeof o === "object" && !Array.isArray(o) && o.t === "ref";
}
export function isDict(o: Obj | undefined): o is Dict {
  return !!o && typeof o === "object" && !Array.isArray(o) && o.t === "dict";
}
export function isStream(o: Obj | undefined): o is Stream {
  return !!o && typeof o === "object" && !Array.isArray(o) && o.t === "stream";
}

/** A tokenizer/parser over bytes, for objects and content streams alike. */
export class Lexer {
  pos: number;
  constructor(
    readonly b: Buffer,
    start = 0,
    readonly end = b.length,
  ) {
    this.pos = start;
  }

  skipWs(): void {
    for (;;) {
      while (this.pos < this.end && WS.has(this.b[this.pos])) this.pos++;
      if (this.pos < this.end && this.b[this.pos] === 0x25) {
        while (this.pos < this.end && this.b[this.pos] !== 10 && this.b[this.pos] !== 13) this.pos++;
        continue;
      }
      return;
    }
  }

  private regular(): string {
    const s = this.pos;
    while (this.pos < this.end && !WS.has(this.b[this.pos]) && !DELIM.has(this.b[this.pos])) this.pos++;
    return this.b.toString("latin1", s, this.pos);
  }

  /** The next object, or undefined at the end. Keywords come back as `Op`. */
  next(depth = 0): Obj | undefined {
    this.skipWs();
    if (this.pos >= this.end) return undefined;
    const c = this.b[this.pos];
    if (c === 0x2f) {
      this.pos++;
      const raw = this.regular();
      return { t: "name", v: raw.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (this.b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        const d = new Map<string, Obj>();
        for (let guard = 0; guard < 100_000; guard++) {
          this.skipWs();
          if (this.pos >= this.end) break;
          if (this.b[this.pos] === 0x3e && this.b[this.pos + 1] === 0x3e) {
            this.pos += 2;
            break;
          }
          const k = this.next(depth + 1);
          if (k === undefined) break;
          if (!isName(k)) continue;
          const v = depth < 64 ? this.next(depth + 1) : undefined;
          if (v === undefined) break;
          d.set(k.v, v);
        }
        return { t: "dict", d };
      }
      this.pos++;
      const s = this.pos;
      while (this.pos < this.end && this.b[this.pos] !== 0x3e) this.pos++;
      const hex = this.b.toString("latin1", s, this.pos).replace(/[^0-9A-Fa-f]/g, "");
      this.pos++;
      return { t: "str", v: Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex") };
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: Obj[] = [];
      for (let guard = 0; guard < 1_000_000; guard++) {
        this.skipWs();
        if (this.pos >= this.end) break;
        if (this.b[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        const v = depth < 64 ? this.next(depth + 1) : undefined;
        if (v === undefined) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) {
      this.pos++;
      return { t: "op", v: String.fromCharCode(c) };
    }
    const word = this.regular();
    if (word === "") {
      this.pos++;
      return { t: "op", v: "" };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      const n = Number(word);
      // `n g R` is a reference.
      if (/^\d+$/.test(word)) {
        const save = this.pos;
        this.skipWs();
        const g = this.regular();
        if (/^\d+$/.test(g)) {
          this.skipWs();
          const r = this.regular();
          if (r === "R") return { t: "ref", n, g: Number(g) };
        }
        this.pos = save;
      }
      return n;
    }
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return { t: "op", v: word };
  }

  private literal(): Str {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end) {
      const c = this.b[this.pos++];
      if (c === 0x5c) {
        const e = this.b[this.pos++];
        if (e === undefined) break;
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12 };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && this.b[this.pos] >= 0x30 && this.b[this.pos] <= 0x37; k++) v = v * 8 + (this.b[this.pos++] - 0x30);
          out.push(v & 255);
        } else if (e === 13) {
          if (this.b[this.pos] === 10) this.pos++;
        } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return { t: "str", v: Buffer.from(out) };
  }
}

/** Inflates a FlateDecode stream, at most `limit` bytes; a truncated stream gives what it has. */
export function inflate(data: Buffer, limit: number): Buffer | null {
  try {
    return zlib.inflateSync(data, { maxOutputLength: limit, finishFlush: zlib.constants.Z_SYNC_FLUSH });
  } catch {
    return null;
  }
}

export class PdfDoc {
  private objects = new Map<number, Obj>();
  readonly pages: Ref[] = [];

  private constructor(private readonly bytes: Buffer) {}

  static load(bytes: Buffer): PdfDoc {
    const doc = new PdfDoc(bytes);
    doc.scan();
    doc.walkPages();
    return doc;
  }

  get(o: Obj | undefined): Obj | undefined {
    let cur = o;
    for (let i = 0; i < 32 && isRef(cur); i++) cur = this.objects.get(cur.n);
    return isRef(cur) ? undefined : cur;
  }

  dict(o: Obj | undefined): Map<string, Obj> | undefined {
    const v = this.get(o);
    if (isDict(v)) return v.d;
    if (isStream(v)) return v.dict;
    return undefined;
  }

  object(n: number): Obj | undefined {
    return this.objects.get(n);
  }

  private scan(): void {
    const text = this.bytes.toString("latin1");
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    const found: { n: number; at: number }[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) found.push({ n: Number(m[1]), at: m.index + m[0].length });
    const offsets = new Map<number, number>();
    for (const f of found) offsets.set(f.n, f.at);
    let skipUntil = 0;
    const streams: Stream[] = [];
    for (const f of found) {
      if (f.at < skipUntil) continue;
      const lx = new Lexer(this.bytes, f.at);
      let v = lx.next();
      if (v === undefined) continue;
      const save = lx.pos;
      lx.skipWs();
      if (isDict(v) && text.startsWith("stream", lx.pos)) {
        let start = lx.pos + 6;
        if (this.bytes[start] === 13 && this.bytes[start + 1] === 10) start += 2;
        else if (this.bytes[start] === 10 || this.bytes[start] === 13) start += 1;
        let len = this.length(v.d.get("Length"), offsets);
        let end = -1;
        if (len !== null && start + len <= this.bytes.length) {
          let k = start + len;
          while (k < this.bytes.length && WS.has(this.bytes[k])) k++;
          if (text.startsWith("endstream", k)) end = start + len;
        }
        if (end < 0) {
          const e = text.indexOf("endstream", start);
          end = e < 0 ? this.bytes.length : e;
          if (end > start && this.bytes[end - 1] === 10) end--;
          if (end > start && this.bytes[end - 1] === 13) end--;
          len = end - start;
        }
        const s: Stream = { t: "stream", dict: v.d, data: this.bytes.subarray(start, end) };
        v = s;
        streams.push(s);
        skipUntil = end;
      } else {
        lx.pos = save;
        skipUntil = lx.pos;
      }
      this.objects.set(f.n, v);
    }
    // Objects kept inside object streams fill in what isn't defined directly.
    for (const s of streams) {
      if (!isName(s.dict.get("Type"), "ObjStm")) continue;
      const data = this.decoded(s, 64 * 1024 * 1024);
      const count = this.get(s.dict.get("N"));
      const first = this.get(s.dict.get("First"));
      if (!data || typeof count !== "number" || typeof first !== "number") continue;
      const head = new Lexer(data, 0, Math.min(first, data.length));
      const pairs: [number, number][] = [];
      for (let i = 0; i < count && i < 1_000_000; i++) {
        const n = head.next();
        const off = head.next();
        if (typeof n !== "number" || typeof off !== "number") break;
        pairs.push([n, off]);
      }
      for (const [n, off] of pairs) {
        if (this.objects.has(n)) continue;
        const v = new Lexer(data, first + off).next();
        if (v !== undefined) this.objects.set(n, v);
      }
    }
    // The trailer (or a cross-reference stream) names the catalog.
    const t = text.lastIndexOf("trailer");
    let root: Obj | undefined;
    if (t >= 0) {
      const tr = new Lexer(this.bytes, t + 7).next();
      if (isDict(tr)) root = tr.d.get("Root");
    }
    if (!root) {
      for (const s of streams) if (isName(s.dict.get("Type"), "XRef") && s.dict.get("Root")) root = s.dict.get("Root");
    }
    if (!root) {
      for (const [n, o] of this.objects) if (isDict(o) && isName(o.d.get("Type"), "Catalog")) root = { t: "ref", n, g: 0 };
    }
    this.root = root;
  }

  private root: Obj | undefined;

  private length(o: Obj | undefined, offsets: Map<number, number>): number | null {
    if (typeof o === "number") return o >= 0 ? Math.floor(o) : null;
    if (isRef(o)) {
      const known = this.objects.get(o.n);
      if (typeof known === "number") return known;
      const at = offsets.get(o.n);
      if (at === undefined) return null;
      const v = new Lexer(this.bytes, at).next();
      return typeof v === "number" ? v : null;
    }
    return null;
  }

  private walkPages(): void {
    const catalog = this.dict(this.root);
    const seen = new Set<number>();
    const visit = (node: Obj | undefined, depth: number) => {
      if (!isRef(node) || depth > 64 || seen.has(node.n) || this.pages.length > 100_000) return;
      seen.add(node.n);
      const d = this.dict(node);
      if (!d) return;
      const kids = this.get(d.get("Kids"));
      if (Array.isArray(kids) && !isName(d.get("Type"), "Page")) {
        for (const k of kids) visit(k, depth + 1);
      } else this.pages.push(node);
    };
    visit(catalog?.get("Pages"), 0);
  }

  /** Filter names of a stream. */
  filters(s: Stream): string[] {
    const f = this.get(s.dict.get("Filter"));
    if (isName(f)) return [f.v];
    if (Array.isArray(f)) return f.map((x) => this.get(x)).filter((x): x is Name => isName(x)).map((x) => x.v);
    return [];
  }

  /** A stream's content decoded (Flate only; an unfiltered stream as it is). */
  decoded(s: Stream, limit: number): Buffer | null {
    const f = this.filters(s);
    if (f.length === 0) return s.data;
    if (f.length === 1 && (f[0] === "FlateDecode" || f[0] === "Fl")) return inflate(s.data, limit);
    return null;
  }

  /** A page's content streams, decoded and joined. */
  pageContent(page: Ref, limit: number): Buffer | null {
    const d = this.dict(page);
    if (!d) return null;
    const c = this.get(d.get("Contents"));
    const list = Array.isArray(c) ? c.map((x) => this.get(x)) : [c];
    const parts: Buffer[] = [];
    let size = 0;
    for (const s of list) {
      if (!isStream(s)) continue;
      const b = this.decoded(s, limit);
      if (!b) return null;
      size += b.length;
      if (size > limit) return null;
      parts.push(b, Buffer.from("\n"));
    }
    return Buffer.concat(parts);
  }

  num(o: Obj | undefined): number | undefined {
    const v = this.get(o);
    return typeof v === "number" ? v : undefined;
  }
}

/** One content-stream operation: the operator and its operands. `BI` carries the inline image's dict and data. */
export type Operation = { op: string; args: Obj[]; inline?: { dict: Map<string, Obj>; data: Buffer } };

/** The operations of a content stream; stops at whatever it can't read. */
export function operations(content: Buffer): Operation[] {
  const out: Operation[] = [];
  const lx = new Lexer(content);
  let args: Obj[] = [];
  for (let guard = 0; guard < 50_000_000; guard++) {
    const v = lx.next();
    if (v === undefined) break;
    if (v !== null && typeof v === "object" && !Array.isArray(v) && v.t === "op") {
      if (v.v === "BI") {
        const dict = new Map<string, Obj>();
        for (;;) {
          const k = lx.next();
          if (k === undefined) break;
          if (!isName(k)) {
            if (k !== null && typeof k === "object" && !Array.isArray(k) && k.t === "op" && k.v === "ID") break;
            continue;
          }
          const val = lx.next();
          if (val === undefined) break;
          dict.set(k.v, val);
        }
        let start = lx.pos;
        if (WS.has(content[start])) start++;
        let end = start;
        let found = -1;
        while (end + 1 < content.length) {
          if (content[end] === 0x45 && content[end + 1] === 0x49 && (end === start || WS.has(content[end - 1])) && (end + 2 >= content.length || WS.has(content[end + 2]) || DELIM.has(content[end + 2]))) {
            found = end;
            break;
          }
          end++;
        }
        if (found < 0) break;
        let dataEnd = found;
        if (dataEnd > start && WS.has(content[dataEnd - 1])) dataEnd--;
        out.push({ op: "BI", args: [], inline: { dict, data: content.subarray(start, dataEnd) } });
        lx.pos = found + 2;
        args = [];
        continue;
      }
      out.push({ op: v.v, args });
      args = [];
    } else {
      args.push(v);
      if (args.length > 10_000) args = [];
    }
  }
  return out;
}
