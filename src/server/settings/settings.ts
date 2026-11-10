import fs from "node:fs";
import path from "node:path";
import { isNotFound, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";

/**
 * Vault preferences, `<vault>/.phaethon/settings.json`. Preferences only:
 * secrets never go in the vault (it may sync). The file is user-editable, so
 * each field is checked on its own and a wrongly typed one falls back to its
 * default without voiding the others (the Rust core reset every setting when
 * one field had the wrong type). Unknown keys are kept on every write.
 */

export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";
export const BACKENDS: readonly Backend[] = ["phaethon", "claude-cli", "codex-cli", "gemini-cli"];

export type VaultSettings = {
  /** Opt-in per-vault `CLAUDE_CONFIG_DIR`. Hand-edit only. */
  isolateClaudeConfig: boolean;
  backend: Backend;
  /** Raw JSON, checked where it is read (agent instances). */
  agentInstances?: unknown;
  activeAgentInstances?: unknown;
  /** Anthropic model for Phaethon's own loop; the provider's default when null. */
  model: string | null;
  /** Effort for Phaethon's own loop. Hand-edit only. */
  effort: string | null;
  /** The provider for Phaethon's own loop; Anthropic when null. */
  provider: string | null;
  /** Raw JSON: provider id → model. */
  providerModels?: unknown;
  /** Raw JSON: provider id → address. */
  providerUrls?: unknown;
  /** Raw JSON, validated with `validateAppearance` on the way in and out. */
  appearance?: unknown;
};

export const DEFAULT_SETTINGS: Readonly<VaultSettings> = Object.freeze({
  isolateClaudeConfig: false,
  backend: "phaethon",
  model: null,
  effort: null,
  provider: null,
});

export function settingsFile(): string {
  return path.join(vaultStateDir(), "settings.json");
}

/** `"steward"` (the name before the rename) reads as `"phaethon"`. */
export function parseBackend(value: unknown): Backend | undefined {
  if (value === "steward") return "phaethon";
  return typeof value === "string" && (BACKENDS as readonly string[]).includes(value) ? (value as Backend) : undefined;
}

function optString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

const RAW_KEYS = ["agentInstances", "activeAgentInstances", "providerModels", "providerUrls", "appearance"] as const;

/** Every setting, with defaults for missing or wrongly typed fields. Never throws. */
export function readSettings(): VaultSettings {
  const out: VaultSettings = { ...DEFAULT_SETTINGS };
  let text: string;
  try {
    text = fs.readFileSync(settingsFile(), "utf8");
  } catch {
    return out;
  }
  // Token names before the rename, anywhere in the file (as the Rust core did); not written back.
  text = text.replaceAll('"--st-', '"--ph-');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return out;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return out;
  const o = doc as Record<string, unknown>;
  if (typeof o.isolateClaudeConfig === "boolean") out.isolateClaudeConfig = o.isolateClaudeConfig;
  out.backend = parseBackend(o.backend) ?? DEFAULT_SETTINGS.backend;
  for (const key of ["model", "effort", "provider"] as const) out[key] = optString(o[key]) ?? null;
  // serde's Option<Value> reads JSON null as absent.
  for (const key of RAW_KEYS) if (o[key] !== undefined && o[key] !== null) out[key] = o[key];
  return out;
}

/** The file as an object for a read-modify-write; refuses anything else so a hand-edited file is never clobbered. */
function readDoc(): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(settingsFile(), "utf8");
  } catch (e) {
    if (isNotFound(e)) return {};
    throw e;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    doc = undefined;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("settings.json is not a JSON object; fix or remove it first");
  return doc as Record<string, unknown>;
}

/**
 * Changes some settings in one write, keeping every other key (unknown ones
 * included). A value of `undefined` removes that key; `null` is written as JSON null.
 */
export function setSettings(entries: Record<string, unknown>): void {
  const doc = readDoc();
  for (const [key, value] of Object.entries(entries)) {
    if (value === undefined) delete doc[key];
    else doc[key] = value;
  }
  writeJsonAtomic(settingsFile(), doc);
}

export function setSetting(key: string, value: unknown): void {
  setSettings({ [key]: value });
}

/** The interface other modules use: the given fields written as given (undefined ones skipped), then the result read back. */
export function updateSettings(patch: Partial<VaultSettings>): VaultSettings {
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) entries[key] = value;
  if (Object.keys(entries).length) setSettings(entries);
  return readSettings();
}

// ---- Appearance --------------------------------------------------------------

const APPEARANCE_MAX_BYTES = 8 * 1024;
const APPEARANCE_MAX_TOKENS = 64;
const TOKEN_VALUE_MAX_LEN = 64;

function truncate(s: string): string {
  return [...s].slice(0, 40).join("");
}

function oneOf(key: string, value: unknown, allowed: string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) throw new Error(`${key} must be one of: ${allowed.join(", ")}.`);
}

/** `--ph-` plus `[a-z0-9-]`, at most 64 bytes, not starting or ending in a dash. */
export function isTokenName(name: string): boolean {
  if (!name.startsWith("--ph-")) return false;
  const rest = name.slice(5);
  return rest.length > 0 && Buffer.byteLength(name) <= 64 && !rest.startsWith("-") && !rest.endsWith("-") && /^[a-z0-9-]+$/.test(rest);
}

/** Numbers, lengths and oklch()/oklab() colours only, so a stored value can't smuggle in other CSS. */
export function isTokenValue(s: string): boolean {
  const lower = s.toLowerCase();
  const opens = s.split("(").length - 1;
  const closes = s.split(")").length - 1;
  return (
    s.length > 0 &&
    Buffer.byteLength(s) <= TOKEN_VALUE_MAX_LEN &&
    /^[A-Za-z0-9 .%/+()-]*$/.test(s) &&
    opens === closes &&
    (opens === 0 || (opens === 1 && (lower.startsWith("oklch(") || lower.startsWith("oklab(")) && s.endsWith(")")))
  );
}

/** Checks an appearance object; throws an Error with the message the UI shows. */
export function validateAppearance(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Appearance must be an object.");
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > APPEARANCE_MAX_BYTES) throw new Error(`Appearance is too large (${size} bytes).`);
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    switch (key) {
      case "version":
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1000) throw new Error("Appearance version must be a small positive number.");
        break;
      case "theme":
        oneOf(key, v, ["system", "light", "dark"]);
        break;
      case "readingFont":
        oneOf(key, v, ["atkinson", "opendyslexic", "lexend", "system"]);
        break;
      case "reduceMotion":
      case "increaseContrast":
        oneOf(key, v, ["system", "on", "off"]);
        break;
      case "tokens": {
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Appearance tokens must be an object.");
        const tokens = Object.entries(v as Record<string, unknown>);
        if (tokens.length > APPEARANCE_MAX_TOKENS) throw new Error(`Too many token overrides (${tokens.length}).`);
        for (const [name, tv] of tokens) {
          if (!isTokenName(name)) throw new Error(`"${truncate(name)}" is not a Phaethon token name.`);
          const ok = typeof tv === "number" ? Number.isFinite(tv) : typeof tv === "string" ? isTokenValue(tv) : false;
          if (!ok) throw new Error(`${name} has a value Phaethon cannot use.`);
        }
        break;
      }
      default:
        throw new Error(`Unknown appearance setting "${truncate(key)}".`);
    }
  }
}

export function isValidAppearance(value: unknown): boolean {
  try {
    validateAppearance(value);
    return true;
  } catch {
    return false;
  }
}

/** A raw settings map (providerModels, providerUrls) as string → string, ignoring anything else. */
export function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  }
  return out;
}
