/**
 * The tokens a person may change from Settings, with the rules each value must
 * follow. Defaults mirror src/styles/tokens.css. Everything here is pure (no
 * DOM, no imports) so it can be tested with plain `node`.
 *
 * Three kinds of value:
 * - number: a unitless dial (hue, scale). Clamped to [min, max], snapped to step.
 * - length: a number with one fixed unit ("3px", "0.02em"). Same clamping.
 * - colour: oklch() or oklab() only, matched by a strict pattern.
 *
 * Some entries are "virtual": tokens.css has no single property for them (the
 * five corner radii, the three durations), so the entry has `derive`, which
 * turns its value into the real properties to set.
 */

export type TokenGroup = "Text" | "Colour" | "Layout" | "Motion" | "Accessibility";

type Base = {
  name: `--st-${string}`;
  label: string;
  /** One plain sentence: what changes when you move it. */
  description: string;
  group: TokenGroup;
};

export type NumberToken = Base & {
  kind: "number";
  min: number;
  max: number;
  step: number;
  default: number;
  /** How the value reads on screen and to a screen reader. */
  format: (v: number) => string;
  /** Named stops shown as swatches or quick picks. */
  presets?: readonly { label: string; value: number }[];
  derive?: (v: number) => Record<string, string>;
};

export type LengthToken = Base & {
  kind: "length";
  unit: "px" | "em" | "rem";
  min: number;
  max: number;
  step: number;
  /** In `unit`. */
  default: number;
  format: (v: number) => string;
};

export type ColourToken = Base & {
  kind: "colour";
  default: string;
};

export type TokenSpec = NumberToken | LengthToken | ColourToken;

const pct = (v: number) => `${Math.round(v * 100)}%`;
const times = (v: number) => `${v.toFixed(2).replace(/\.?0+$/, "")}×`;

/** Soft accent hues. Chroma stays at the user's accent strength. */
export const ACCENT_PRESETS = [
  { label: "Sea", value: 168 },
  { label: "Lagoon", value: 200 },
  { label: "Sky", value: 240 },
  { label: "Iris", value: 280 },
  { label: "Orchid", value: 320 },
  { label: "Rose", value: 10 },
  { label: "Clay", value: 50 },
  { label: "Moss", value: 130 },
] as const;

/** Named surface tints, from warm paper to cool slate. */
export const NEUTRAL_PRESETS = [
  { label: "Paper", value: 80 },
  { label: "Sand", value: 60 },
  { label: "Sage", value: 140 },
  { label: "Mist", value: 200 },
  { label: "Slate", value: 255 },
  { label: "Heather", value: 310 },
] as const;

const RADII = { xs: 3, sm: 5, "": 7, lg: 10, xl: 14 } as const;
const DURATIONS = { fast: 100, "": 160, slow: 260 } as const;

export function hueName(h: number): string {
  const all = [...ACCENT_PRESETS];
  let best: { label: string; value: number } = all[0];
  let bestD = 360;
  for (const p of all) {
    const d = Math.min(Math.abs(p.value - h), 360 - Math.abs(p.value - h));
    if (d < bestD) [best, bestD] = [p, d];
  }
  return bestD <= 12 ? best.label : `hue ${Math.round(h)}`;
}

export const TOKENS: readonly TokenSpec[] = [
  // ---- Text ----
  {
    name: "--st-text-scale",
    label: "Text size",
    description: "Makes every piece of text larger or smaller. Layouts grow with it.",
    group: "Text",
    kind: "number",
    min: 0.85,
    max: 2,
    step: 0.05,
    default: 1,
    format: pct,
    presets: [
      { label: "Small", value: 0.9 },
      { label: "Default", value: 1 },
      { label: "Large", value: 1.25 },
      { label: "Larger", value: 1.5 },
      { label: "Largest", value: 2 },
    ],
  },
  {
    name: "--st-weight-normal",
    label: "Text weight",
    description: "How heavy ordinary text is. Heavier text can be easier to read on some screens.",
    group: "Text",
    kind: "number",
    min: 350,
    max: 560,
    step: 10,
    default: 400,
    format: (v) => (v === 400 ? "Regular (400)" : v < 400 ? `Lighter (${v})` : `Heavier (${v})`),
  },

  // ---- Colour ----
  {
    name: "--st-accent-h",
    label: "Accent colour",
    description: "The colour of buttons, links, selection and the focus ring.",
    group: "Colour",
    kind: "number",
    min: 0,
    max: 360,
    step: 1,
    default: 168,
    format: (v) => `${hueName(v)}, ${Math.round(v)} degrees`,
    presets: ACCENT_PRESETS,
  },
  {
    name: "--st-accent-c",
    label: "Accent strength",
    description: "How vivid the accent is. Kept soft so it never shouts; text on it stays readable.",
    group: "Colour",
    kind: "number",
    min: 0.02,
    max: 0.12,
    step: 0.005,
    default: 0.075,
    format: (v) => `${Math.round(((v - 0.02) / 0.1) * 100)}%`,
  },
  {
    name: "--st-neutral-h",
    label: "Surface tint",
    description: "The faint colour in backgrounds and borders: warm paper, cool slate, or anything between.",
    group: "Colour",
    kind: "number",
    min: 0,
    max: 360,
    step: 1,
    default: 80,
    format: (v) => {
      const p = NEUTRAL_PRESETS.find((n) => Math.abs(n.value - v) <= 5);
      return p ? `${p.label}, ${Math.round(v)} degrees` : `hue ${Math.round(v)}`;
    },
    presets: NEUTRAL_PRESETS,
  },
  {
    name: "--st-neutral-c",
    label: "Surface tint strength",
    description: "From plain grey to clearly tinted. Always subtle.",
    group: "Colour",
    kind: "number",
    min: 0,
    max: 0.02,
    step: 0.001,
    default: 0.006,
    format: (v) => (v === 0 ? "None (grey)" : `${Math.round((v / 0.02) * 100)}%`),
  },

  // ---- Layout ----
  {
    name: "--st-density",
    label: "Spacing",
    description: "Room around and between things. Lower fits more on screen; higher is calmer.",
    group: "Layout",
    kind: "number",
    min: 0.8,
    max: 1.4,
    step: 0.05,
    default: 1,
    format: (v) => (v === 1 ? "Standard (100%)" : v < 1 ? `Compact (${pct(v)})` : `Roomy (${pct(v)})`),
  },
  {
    name: "--st-radius-scale",
    label: "Corner roundness",
    description: "From square corners to soft, rounded ones.",
    group: "Layout",
    kind: "number",
    min: 0,
    max: 2,
    step: 0.1,
    default: 1,
    format: (v) => (v === 0 ? "Square" : times(v)),
    derive: (v) =>
      Object.fromEntries(
        Object.entries(RADII).map(([k, px]) => [`--st-radius${k ? `-${k}` : ""}`, `${round(px * v, 2)}px`]),
      ),
  },
  {
    name: "--st-sidebar-width",
    label: "Sidebar width",
    description: "How wide the list of spaces is.",
    group: "Layout",
    kind: "length",
    unit: "px",
    min: 200,
    max: 360,
    step: 4,
    default: 232,
    format: (v) => `${v} pixels`,
  },

  // ---- Motion ----
  {
    name: "--st-duration-scale",
    label: "Animation length",
    description: "How long transitions take. Off makes every change instant.",
    group: "Motion",
    kind: "number",
    min: 0,
    max: 2,
    step: 0.25,
    default: 1,
    format: (v) => (v === 0 ? "Off" : v === 1 ? "Normal (1×)" : times(v)),
    derive: (v) =>
      Object.fromEntries(
        Object.entries(DURATIONS).map(([k, ms]) => [`--st-duration${k ? `-${k}` : ""}`, `${Math.round(ms * v)}ms`]),
      ),
  },

  // ---- Accessibility ----
  {
    name: "--st-focus-width",
    label: "Focus ring thickness",
    description: "The outline that shows which control the keyboard is on.",
    group: "Accessibility",
    kind: "length",
    unit: "px",
    min: 2,
    max: 4,
    step: 1,
    default: 2,
    format: (v) => `${v} pixels`,
  },
  {
    name: "--st-leading-normal",
    label: "Line spacing",
    description: "Space between lines in paragraphs and replies.",
    group: "Accessibility",
    kind: "number",
    min: 1.3,
    max: 2.2,
    step: 0.05,
    default: 1.55,
    format: (v) => times(v),
  },
  {
    name: "--st-tracking-normal",
    label: "Letter spacing",
    description: "Space between letters. A little extra helps some people with dyslexia.",
    group: "Accessibility",
    kind: "length",
    unit: "em",
    min: 0,
    max: 0.12,
    step: 0.01,
    default: 0,
    format: (v) => (v === 0 ? "None" : `+${Math.round(v * 100)}%`),
  },
  {
    name: "--st-icon-stroke",
    label: "Icon line weight",
    description: "How thick the lines in icons are.",
    group: "Accessibility",
    kind: "number",
    min: 1.25,
    max: 2.25,
    step: 0.25,
    default: 1.5,
    format: (v) => `${v === 1.5 ? "Regular" : v < 1.5 ? "Thinner" : v < 2 ? "Thicker" : "Thickest"} (${v})`,
  },
];

export const TOKEN_BY_NAME: ReadonlyMap<string, TokenSpec> = new Map(TOKENS.map((t) => [t.name, t]));

export type TokenValue = number | string;
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function round(v: number, places = 4) {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function clampStep(v: number, min: number, max: number, step: number) {
  const c = Math.min(max, Math.max(min, v));
  return round(min + Math.round((c - min) / step) * step);
}

const NUMBER_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
const NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
const PCT = String.raw`${NUM}%?`;
/** oklch(L C H [/ A]) and oklab(L a b [/ A]): numbers (optionally %) only. No var(), no calc(), no names. */
export const COLOUR_RE = new RegExp(
  String.raw`^okl(?:ch|ab)\(\s*${PCT}\s+${PCT}\s+${NUM}(?:deg)?\s*(?:/\s*${PCT}\s*)?\)$`,
  "i",
);

/**
 * Check one value against its spec. Numbers are clamped into range and snapped
 * to the step (out-of-range is corrected, not refused); anything of the wrong
 * shape is refused.
 */
export function validateValue(spec: TokenSpec, raw: unknown): Result<TokenValue> {
  if (spec.kind === "colour") {
    if (typeof raw !== "string" || raw.length > 64 || !COLOUR_RE.test(raw.trim())) {
      return { ok: false, error: `${spec.label} must be an oklch() or oklab() colour.` };
    }
    return { ok: true, value: raw.trim().toLowerCase() };
  }
  let n: number;
  if (spec.kind === "number") {
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string" && NUMBER_RE.test(raw.trim())) n = Number(raw);
    else return { ok: false, error: `${spec.label} must be a number.` };
  } else {
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string") {
      const m = raw.trim().match(new RegExp(`^(${NUM})${spec.unit}$`));
      if (!m) return { ok: false, error: `${spec.label} must be a length in ${spec.unit}, like ${spec.default}${spec.unit}.` };
      n = Number(m[1]);
    } else return { ok: false, error: `${spec.label} must be a length in ${spec.unit}.` };
  }
  if (!Number.isFinite(n)) return { ok: false, error: `${spec.label} must be a finite number.` };
  const v = clampStep(n, spec.min, spec.max, spec.step);
  return { ok: true, value: spec.kind === "length" ? `${v}${spec.unit}` : v };
}

/** Validate a token by name. Unknown names are refused. */
export function validateToken(name: string, raw: unknown): Result<TokenValue> {
  const spec = TOKEN_BY_NAME.get(name);
  if (!spec) return { ok: false, error: `"${name}" is not a setting steward knows.` };
  return validateValue(spec, raw);
}

/** A validated value as a number, for sliders. */
export function numericValue(spec: TokenSpec, v: TokenValue | undefined): number {
  if (spec.kind === "colour") return NaN;
  if (v === undefined) return spec.default;
  return typeof v === "number" ? v : Number.parseFloat(v);
}

/** The CSS custom properties one validated token value sets. */
export function cssFor(spec: TokenSpec, v: TokenValue): Record<string, string> {
  if (spec.kind === "number" && spec.derive) return { [spec.name]: String(v), ...spec.derive(Number(v)) };
  return { [spec.name]: String(v) };
}

export function isDefault(spec: TokenSpec, v: TokenValue | undefined): boolean {
  if (v === undefined) return true;
  if (spec.kind === "colour") return v === spec.default;
  return numericValue(spec, v) === spec.default;
}

// ---- The whole appearance object ----

export type ThemePref = "system" | "light" | "dark";
/** "system" follows the OS; "on" forces it. ("off" is accepted from files and treated as system.) */
export type AccessPref = "system" | "on" | "off";

export type Appearance = {
  version: 1;
  theme: ThemePref;
  reduceMotion: AccessPref;
  increaseContrast: AccessPref;
  /** Only tokens that differ from their default. */
  tokens: Record<string, TokenValue>;
};

export const DEFAULT_APPEARANCE: Appearance = {
  version: 1,
  theme: "system",
  reduceMotion: "system",
  increaseContrast: "system",
  tokens: {},
};

const THEMES: readonly ThemePref[] = ["system", "light", "dark"];
const ACCESS: readonly AccessPref[] = ["system", "on", "off"];

/**
 * Turn anything (a cached copy, the settings file, a half-written object) into
 * a valid Appearance. Unknown tokens and bad values are dropped, numbers are
 * clamped, defaults are left out. Returns the dropped entries for reporting.
 */
export function sanitizeAppearance(raw: unknown): { appearance: Appearance; dropped: string[] } {
  const dropped: string[] = [];
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const pick = <T extends string>(k: string, allowed: readonly T[], d: T): T => {
    const v = o[k];
    if (v === undefined) return d;
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
    dropped.push(k);
    return d;
  };
  const tokens: Record<string, TokenValue> = {};
  const rawTokens = o.tokens && typeof o.tokens === "object" && !Array.isArray(o.tokens) ? (o.tokens as Record<string, unknown>) : {};
  for (const [name, v] of Object.entries(rawTokens)) {
    const r = validateToken(name, v);
    if (!r.ok) {
      dropped.push(name);
      continue;
    }
    const spec = TOKEN_BY_NAME.get(name)!;
    if (!isDefault(spec, r.value)) tokens[name] = r.value;
  }
  return {
    appearance: {
      version: 1,
      theme: pick("theme", THEMES, "system"),
      reduceMotion: pick("reduceMotion", ACCESS, "system"),
      increaseContrast: pick("increaseContrast", ACCESS, "system"),
      tokens,
    },
    dropped,
  };
}

/** Every CSS custom property an appearance sets, after validation. */
export function cssProperties(a: Appearance): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, v] of Object.entries(a.tokens)) {
    const spec = TOKEN_BY_NAME.get(name);
    if (spec) Object.assign(out, cssFor(spec, v));
  }
  return out;
}
