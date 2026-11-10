import fs from "node:fs";
import path from "node:path";
import { appFiles } from "../core/vault.ts";
import { readSettings } from "../settings/settings.ts";
import { readSpaceMeta } from "../spaces/meta.ts";
import type { Alert, Sees, Sight } from "./types.ts";

/**
 * Whether the model answering in a space can look at pictures, and what to
 * tell the person when their course leans on pages it can't read (Rust
 * `vision.rs`; not OCR). What providers' model lists said is kept in
 * `<appData>/model-pictures.json`.
 */

export const BETTER =
  "A model that can read pictures (for example Claude, GPT-4o or newer, Gemini, or a vision model such as Llama 3.2 Vision in Ollama) would do better.";

const SEE = [
  "claude-3", "claude-opus", "claude-sonnet", "claude-haiku", "claude-4", "gpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-4-vision", "gpt-5", "chatgpt-4o", "o4-mini",
  "gemini", "gemma-3", "gemma3", "llava", "bakllava", "vision", "pixtral", "moondream", "minicpm-v", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen2.5vl", "qwen3-vl",
  "-vl-", "-vl:", "llama-4", "llama4", "grok-4", "grok-2-vision", "mistral-small3.1", "mistral-small-3.1", "mistral-medium-3", "granite3.2-vision", "phi-3.5-vision",
  "phi-4-multimodal", "kimi-vl", "glm-4v", "glm-4.5v",
];
const BLIND = ["gpt-3.5", "gpt-4-0613", "gpt-4-32k", "o1-mini", "o1-preview", "o3-mini", "claude-2", "claude-instant", "deepseek", "embed", "whisper", "tts", "codestral", "devstral"];

/** Whether `model` (as `provider` names it) takes images, by its name. */
export function modelSees(provider: string, model: string): Sees {
  const m = model.toLowerCase();
  const bare = m.slice(m.lastIndexOf("/") + 1);
  if (BLIND.some((b) => bare.includes(b)) || provider === "deepseek") return "no";
  if (SEE.some((s) => bare.includes(s) || m.includes(s)) || bare.endsWith("-vl")) return "yes";
  const openai = provider === "openai" || m.startsWith("openai/");
  if (openai && (bare === "o1" || bare.startsWith("o1-2") || bare === "o3" || bare.startsWith("o3-2") || bare.startsWith("o3-pro"))) return "yes";
  if (openai && bare.startsWith("gpt-4")) return "no";
  if (provider === "anthropic" && bare.startsWith("claude-")) return "yes";
  return "unknown";
}

/** From one model's entry in a provider's model list, where it says (OpenRouter, then Ollama). */
export function fromMetadata(v: unknown): Sees | null {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const has = (list: unknown[], word: string) => list.some((x) => typeof x === "string" && x.toLowerCase() === word);
  const arch = o.architecture as Record<string, unknown> | undefined;
  const inputs = arch && typeof arch === "object" ? arch.input_modalities : undefined;
  if (Array.isArray(inputs)) return has(inputs, "image") ? "yes" : "no";
  const caps = o.capabilities;
  if (!Array.isArray(caps) || caps.length === 0) return null;
  return has(caps, "vision") ? "yes" : "no";
}

const KNOWN_LISTS = 32;
const KNOWN_MODELS = 5000;

type Known = { lists: Record<string, Record<string, Sees>> };
let known: Known = { lists: {} };
let keptIn: string | null = null;

function listKey(provider: string, base: string): string {
  return `${provider} ${base.replace(/\/+$/, "")}`;
}

/** Keep what lists say in `file`, reading what it kept last time (entries in memory win). */
export function keepAt(file: string): void {
  try {
    const read = JSON.parse(fs.readFileSync(file, "utf8")) as Known;
    if (read && typeof read.lists === "object" && read.lists) {
      for (const [list, models] of Object.entries(read.lists)) if (!(list in known.lists) && models && typeof models === "object") known.lists[list] = models;
    }
  } catch {
    // Missing or invalid: nothing kept.
  }
  keptIn = file;
}

function ensureKept(): void {
  if (keptIn === null) keepAt(appFiles.modelPictures());
}

/** Forgets everything in memory (tests). */
export function resetKnown(): void {
  known = { lists: {} };
  keptIn = null;
}

const sameMap = (a: Record<string, Sees> | undefined, b: Record<string, Sees>): boolean => {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

/** What `provider`'s list at `base` says now; it replaces what that list said before. An empty list is forgotten. */
export function remember(provider: string, base: string, models: Iterable<[string, Sees]>): void {
  ensureKept();
  const map: Record<string, Sees> = {};
  let n = 0;
  for (const [m, s] of models) {
    if (n++ >= KNOWN_MODELS) break;
    map[m] = s;
  }
  const key = listKey(provider, base);
  if (Object.keys(map).length === 0) {
    if (!(key in known.lists)) return;
    delete known.lists[key];
  } else {
    if (sameMap(known.lists[key], map) || (!(key in known.lists) && Object.keys(known.lists).length >= KNOWN_LISTS)) return;
    known.lists[key] = map;
  }
  if (keptIn) {
    try {
      fs.mkdirSync(path.dirname(keptIn), { recursive: true });
      const tmp = keptIn.replace(/\.json$/, "") + ".json.tmp";
      const sorted: Known = { lists: Object.fromEntries(Object.keys(known.lists).sort().map((k) => [k, known.lists[k]!])) };
      fs.writeFileSync(tmp, JSON.stringify(sorted));
      fs.renameSync(tmp, keptIn);
    } catch {
      // Errors are ignored: it's only a cache.
    }
  }
}

/** What `provider`'s list at `base` said about `model`, if it said. */
export function knownSees(provider: string, base: string, model: string): Sees | null {
  ensureKept();
  return known.lists[listKey(provider, base)]?.[model] ?? null;
}

/** Whether `model` from `provider` at `base` takes images: what its list said, else by its name. */
export function sees(provider: string, base: string, model: string): Sees {
  return knownSees(provider, base, model) ?? modelSees(provider, model);
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", openrouter: "OpenRouter", ollama: "Ollama" };

/**
 * The space's model as Study will ask it, without reading the keychain. The
 * real provider/model resolution belongs to the agent worker's providers
 * module; this reads the same settings in the simplest way.
 */
export function sightForSpace(space: string): Sight {
  const settings = readSettings();
  switch (settings.backend) {
    case "claude-cli":
      return { sees: "yes", model: "Claude Code", shown: true };
    case "codex-cli":
      return { sees: "yes", model: "Codex", shown: true };
    case "gemini-cli":
      return { sees: "yes", model: "Gemini CLI", shown: false };
  }
  let provider = typeof settings.provider === "string" && settings.provider ? settings.provider : "anthropic";
  let model: string | null = null;
  let ref: unknown = null;
  try {
    ref = readSpaceMeta(space).model;
  } catch {
    ref = null;
  }
  if (typeof ref === "string" && ref.includes(":")) {
    const i = ref.indexOf(":");
    provider = ref.slice(0, i);
    model = ref.slice(i + 1) || null;
  }
  if (!model) {
    const per = settings.providerModels;
    const fromMap = per && typeof per === "object" ? (per as Record<string, unknown>)[provider] : undefined;
    if (typeof fromMap === "string" && fromMap) model = fromMap;
    else if (provider === "anthropic" && typeof settings.model === "string" && settings.model) model = settings.model;
  }
  if (!model) return { sees: "unknown", model: PROVIDER_NAMES[provider] ?? provider, shown: false };
  const urls = settings.providerUrls;
  const base = urls && typeof urls === "object" && typeof (urls as Record<string, unknown>)[provider] === "string" ? ((urls as Record<string, string>)[provider] as string) : "";
  const s = sees(provider, base, model);
  return { sees: s, model, shown: s === "yes" };
}

/** What to say when material (`of`) has `pages` pages of handwriting or diagrams the model isn't shown; null otherwise. */
export function alert(pages: number, of: string, sight: Sight): Alert | null {
  if (pages === 0 || (sight.sees === "yes" && sight.shown)) return null;
  const are = pages === 1 ? `1 page of ${of} is handwriting or a diagram` : `${pages} pages of ${of} are handwriting or diagrams`;
  const effect = "Questions from those pages may have mistakes or be missed.";
  if (sight.sees === "no") return { kind: "cantSee", text: `Your model can’t look at pictures, and ${are}. ${effect} ${BETTER}` };
  if (sight.sees === "unknown")
    return {
      kind: "unknown",
      text: `Phaethon can’t tell whether your model (${sight.model}) can look at pictures, and ${are}. If it can’t, questions from those pages may have mistakes or be missed. ${BETTER}`,
    };
  return {
    kind: "notShown",
    text: `Phaethon can’t show pictures to ${sight.model} yet, and ${are}. ${effect} Claude Code, Codex, or a model of your own that can read pictures would do better.`,
  };
}
