/**
 * String helpers that behave like the Rust standard library did, where card
 * ids, hashes, limits and parsing depend on it (see the study spec §0).
 */

/** Rust's `char::is_whitespace` (Unicode White_Space; not U+FEFF). */
export const WS_CLASS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp(`[${WS_CLASS}]+`, "u");
const WS_ONE = new RegExp(`^[${WS_CLASS}]$`, "u");
const LEAD = new RegExp(`^[${WS_CLASS}]+`, "u");
const TRAIL = new RegExp(`[${WS_CLASS}]+$`, "u");

export function isWs(ch: string): boolean {
  return WS_ONE.test(ch);
}

/** Rust `str::trim`. */
export function rtrim(s: string): string {
  return s.replace(LEAD, "").replace(TRAIL, "");
}
export function rtrimStart(s: string): string {
  return s.replace(LEAD, "");
}
export function rtrimEnd(s: string): string {
  return s.replace(TRAIL, "");
}

/** Rust `split_whitespace()`. */
export function splitWs(s: string): string[] {
  return s.split(WS_RUN).filter((p) => p !== "");
}

/** `split_whitespace().collect::<Vec<_>>().join(" ")`. */
export function squeeze(s: string): string {
  return splitWs(s).join(" ");
}

const ALNUM = /^[\p{Alphabetic}\p{N}]$/u;
const ALPHA = /^\p{Alphabetic}$/u;
const LOWER = /^\p{Lowercase}$/u;
const UPPER = /^\p{Uppercase}$/u;
const CONTROL = /^\p{Cc}$/u;

export const isAlnum = (ch: string): boolean => ALNUM.test(ch);
export const isAlpha = (ch: string): boolean => ALPHA.test(ch);
export const isLower = (ch: string): boolean => LOWER.test(ch);
export const isUpper = (ch: string): boolean => UPPER.test(ch);
export const isControl = (ch: string): boolean => CONTROL.test(ch);
export const isAsciiDigit = (ch: string): boolean => ch >= "0" && ch <= "9";
export const isAsciiAlnum = (ch: string): boolean => /^[A-Za-z0-9]$/.test(ch);

/** `to_ascii_lowercase`. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** `eq_ignore_ascii_case`. */
export function asciiEqIgnoreCase(a: string, b: string): boolean {
  return asciiLower(a) === asciiLower(b);
}

/** Unicode scalar count (`chars().count()`). */
export function charLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** First `n` scalars (`chars().take(n)`). */
export function takeChars(s: string, n: number): string {
  if (n <= 0) return "";
  let out = "";
  let i = 0;
  for (const ch of s) {
    if (i++ >= n) break;
    out += ch;
  }
  return out;
}

/** UTF-8 byte length (`str::len`). */
export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The longest prefix of `s` that is at most `max` UTF-8 bytes (cut at a char boundary). */
export function cutBytes(s: string, max: number): string {
  if (max <= 0) return "";
  if (byteLen(s) <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = byteLen(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

/** Splits on every char for which `pred` holds (Rust `split(|c| pred(c))`), empties kept. */
export function splitBy(s: string, pred: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (pred(ch)) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** `trim_matches(chars)`, repeatedly from both ends. */
export function trimChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}
export function trimStartChars(s: string, chars: string): string {
  let a = 0;
  while (a < s.length && chars.includes(s[a]!)) a++;
  return s.slice(a);
}
export function trimEndChars(s: string, chars: string): string {
  let b = s.length;
  while (b > 0 && chars.includes(s[b - 1]!)) b--;
  return s.slice(0, b);
}

/** `trim_start_matches(prefix)` with a string pattern: strips it repeatedly. */
export function stripPrefixAll(s: string, prefix: string): string {
  if (!prefix) return s;
  while (s.startsWith(prefix)) s = s.slice(prefix.length);
  return s;
}
export function stripSuffixAll(s: string, suffix: string): string {
  if (!suffix) return s;
  while (s.endsWith(suffix)) s = s.slice(0, s.length - suffix.length);
  return s;
}

/** Rust `str::parse::<f64>`: no empty, no hex, no trailing junk; `inf`/`nan` allowed. */
export function parseRustF64(s: string): number | null {
  if (!/^[+-]?(inf|infinity|nan|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)$/i.test(s)) return null;
  const neg = s.startsWith("-");
  const body = s.replace(/^[+-]/, "").toLowerCase();
  if (body === "inf" || body === "infinity") return neg ? -Infinity : Infinity;
  if (body === "nan") return NaN;
  return Number(s);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64 over bytes, as 16 lowercase hex digits. */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let h = FNV_OFFSET;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK;
  }
  return h.toString(16).padStart(16, "0");
}

/** FNV-1a 64 over UTF-8 parts joined by a 0x00 byte. */
export function fnvParts(...parts: string[]): string {
  const bufs: Buffer[] = [];
  parts.forEach((p, i) => {
    if (i > 0) bufs.push(Buffer.from([0]));
    bufs.push(Buffer.from(p, "utf8"));
  });
  return fnv1a64Hex(Buffer.concat(bufs));
}

/** Levenshtein distance over code points. */
export function levenshtein(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur.push(Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost));
    }
    prev = cur;
  }
  return prev[y.length]!;
}

/** The last path segment (`rsplit('/').next()`). */
export function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

/** Rust `str::lines()`: splits on `\n`, strips one trailing `\r` per line, no final empty line. */
export function rustLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Stable sort that returns a new array. */
export function stableSort<T>(xs: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return xs
    .map((x, i) => [x, i] as const)
    .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
    .map(([x]) => x);
}

/** Byte-order comparison of strings (Rust `str` Ord). */
export function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** `Vec::dedup`: drops consecutive duplicates only. */
export function dedupConsecutive<T>(xs: readonly T[]): T[] {
  const out: T[] = [];
  for (const x of xs) if (out.length === 0 || out[out.length - 1] !== x) out.push(x);
  return out;
}

/** Drops every repeat, keeping first-seen order. */
export function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)];
}
