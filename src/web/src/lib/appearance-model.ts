/**
 * The appearance object saved in the vault (`settings.json` → `appearance`),
 * kept in the same shape the Rust core validated so existing files stay valid:
 *
 *   { version: 1, theme, readingFont, reduceMotion, increaseContrast, tokens }
 *
 * Preferences without a top-level key live in `tokens` as `--ph-*` values, as
 * before: text size, focus rings, target size, line/letter/word spacing.
 * Tokens Phaethon no longer shows (an old accent override, say) are kept
 * as they are, so saving never drops someone's earlier choices.
 *
 * Pure (no DOM), so it is unit-tested directly.
 */

export type ThemePref = "system" | "light" | "dark";
/** "system" follows the OS; "on" forces the feature on; "off" forces it off. */
export type AccessPref = "system" | "on" | "off";
export type ReadingFont = "atkinson" | "opendyslexic" | "lexend" | "system";
export type TokenValue = number | string;

export type Appearance = {
  version: 1;
  theme: ThemePref;
  readingFont: ReadingFont;
  reduceMotion: AccessPref;
  increaseContrast: AccessPref;
  tokens: Record<string, TokenValue>;
};

export const DEFAULT_APPEARANCE: Appearance = {
  version: 1,
  theme: "system",
  readingFont: "atkinson",
  reduceMotion: "system",
  increaseContrast: "system",
  tokens: {},
};

export const THEMES: readonly ThemePref[] = ["system", "light", "dark"];
export const ACCESS: readonly AccessPref[] = ["system", "on", "off"];
export const READING_FONTS: readonly ReadingFont[] = ["atkinson", "opendyslexic", "lexend", "system"];

/** The token dials this UI offers, with their allowed values. */
export const TEXT_SCALES = [1, 1.125, 1.25, 1.5, 2] as const;
export const LEADINGS = [1.55, 1.8, 2.05] as const;
export const TRACKINGS = [0, 0.04, 0.08, 0.12] as const;
export const WORD_SPACINGS = [0, 0.08, 0.16, 0.24] as const;

export const TOKEN = {
  textScale: "--ph-text-scale",
  focusRings: "--ph-focus-rings",
  targetSize: "--ph-target-size",
  leading: "--ph-leading-normal",
  tracking: "--ph-tracking-normal",
  wordSpacing: "--ph-word-spacing",
} as const;

const DEFAULTS: Record<string, number> = {
  [TOKEN.textScale]: 1,
  [TOKEN.focusRings]: 0,
  [TOKEN.targetSize]: 24,
  [TOKEN.leading]: 1.55,
  [TOKEN.tracking]: 0,
  [TOKEN.wordSpacing]: 0,
};

/** The core's own rules for a token (validate_appearance), so nothing we send is refused. */
const TOKEN_NAME_RE = /^--ph-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TOKEN_VALUE_RE = /^[A-Za-z0-9 .%/+()-]+$/;
const MAX_TOKENS = 64;

export function isValidTokenValue(v: unknown): v is TokenValue {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "string" || v.length === 0 || v.length > 64 || !TOKEN_VALUE_RE.test(v)) return false;
  const open = (v.match(/\(/g) ?? []).length;
  const close = (v.match(/\)/g) ?? []).length;
  if (open === 0 && close === 0) return true;
  return open === 1 && close === 1 && /^okl(ch|ab)\(/i.test(v) && v.endsWith(")");
}

function pick<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const v = o[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Reads a number from a token value: 1.5, "1.5", "0.04em", "44px". */
export function tokenNumber(v: TokenValue | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Turns anything (a cached copy, the vault's file, nonsense) into a valid Appearance. */
export function sanitizeAppearance(raw: unknown): Appearance {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawTokens =
    o.tokens && typeof o.tokens === "object" && !Array.isArray(o.tokens) ? (o.tokens as Record<string, unknown>) : {};
  const tokens: Record<string, TokenValue> = {};
  for (const [name, value] of Object.entries(rawTokens)) {
    if (Object.keys(tokens).length >= MAX_TOKENS) break;
    if (new TextEncoder().encode(name).length > 64 || !TOKEN_NAME_RE.test(name) || !isValidTokenValue(value)) continue;
    tokens[name] = value;
  }
  return {
    version: 1,
    theme: pick(o, "theme", THEMES, "system"),
    readingFont: pick(o, "readingFont", READING_FONTS, "atkinson"),
    reduceMotion: pick(o, "reduceMotion", ACCESS, "system"),
    increaseContrast: pick(o, "increaseContrast", ACCESS, "system"),
    tokens,
  };
}

function nearest(values: readonly number[], v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  let best = values[0];
  for (const c of values) if (Math.abs(c - v) < Math.abs(best - v)) best = c;
  return best;
}

/** The dials as this UI shows them (old values snap to the nearest offered stop). */
export function dials(a: Appearance) {
  return {
    textScale: nearest(TEXT_SCALES, tokenNumber(a.tokens[TOKEN.textScale]), 1),
    focusRings: tokenNumber(a.tokens[TOKEN.focusRings]) === 1,
    largeTargets: (tokenNumber(a.tokens[TOKEN.targetSize]) ?? 24) > 24,
    leading: nearest(LEADINGS, tokenNumber(a.tokens[TOKEN.leading]), 1.55),
    tracking: nearest(TRACKINGS, tokenNumber(a.tokens[TOKEN.tracking]), 0),
    wordSpacing: nearest(WORD_SPACINGS, tokenNumber(a.tokens[TOKEN.wordSpacing]), 0),
  };
}
export type Dials = ReturnType<typeof dials>;

/** Sets one token; the default value removes it, so files only hold real choices. */
export function withToken(a: Appearance, name: string, value: number): Appearance {
  const tokens = { ...a.tokens };
  const formatted: TokenValue =
    name === TOKEN.tracking || name === TOKEN.wordSpacing ? `${value}em` : value;
  if (DEFAULTS[name] === value) delete tokens[name];
  else tokens[name] = formatted;
  return { ...a, tokens };
}

export function withDial<K extends keyof Dials>(a: Appearance, key: K, value: Dials[K]): Appearance {
  switch (key) {
    case "textScale":
      return withToken(a, TOKEN.textScale, value as number);
    case "focusRings":
      return withToken(a, TOKEN.focusRings, value ? 1 : 0);
    case "largeTargets":
      return withToken(a, TOKEN.targetSize, value ? 44 : 24);
    case "leading":
      return withToken(a, TOKEN.leading, value as number);
    case "tracking":
      return withToken(a, TOKEN.tracking, value as number);
    case "wordSpacing":
      return withToken(a, TOKEN.wordSpacing, value as number);
  }
  return a;
}

/** Back to defaults, keeping tokens this UI doesn't own. */
export function resetAppearance(a: Appearance): Appearance {
  const tokens = { ...a.tokens };
  for (const name of Object.values(TOKEN)) delete tokens[name];
  return { ...DEFAULT_APPEARANCE, tokens };
}

export type SystemPrefs = { dark: boolean; moreContrast: boolean; reduceMotion: boolean };

/** What actually applies once "system" is resolved against the OS. */
export function effective(a: Appearance, s: SystemPrefs) {
  return {
    dark: a.theme === "dark" || (a.theme === "system" && s.dark),
    moreContrast: a.increaseContrast === "on" || (a.increaseContrast === "system" && s.moreContrast),
    reduceMotion: a.reduceMotion === "on" || (a.reduceMotion === "system" && s.reduceMotion),
  };
}

export function isDefaultAppearance(a: Appearance): boolean {
  const d = dials(a);
  return (
    a.theme === "system" &&
    a.readingFont === "atkinson" &&
    a.reduceMotion === "system" &&
    a.increaseContrast === "system" &&
    d.textScale === 1 &&
    !d.focusRings &&
    !d.largeTargets &&
    d.leading === 1.55 &&
    d.tracking === 0 &&
    d.wordSpacing === 0
  );
}
