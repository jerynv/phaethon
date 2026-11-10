import fs from "node:fs";
import { appFiles } from "../core/vault.ts";
import { writeJsonAtomic } from "../core/fsx.ts";
import type { Sees } from "./types.ts";

/**
 * Can a model look at pictures? Learned from providers' model lists when they
 * say (kept in `<app data>/model-pictures.json`), otherwise guessed from the
 * model's name. This is model sight, not OCR.
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

/** Name heuristics. */
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

/** What a model-list entry says about images, if anything (OpenRouter modalities, Ollama capabilities). */
export function fromMetadata(entry: unknown): Sees | undefined {
  const e = entry as { architecture?: { input_modalities?: unknown }; capabilities?: unknown } | null;
  const mods = e?.architecture?.input_modalities;
  if (Array.isArray(mods)) return mods.some((x) => typeof x === "string" && x.toLowerCase() === "image") ? "yes" : "no";
  const caps = e?.capabilities;
  if (Array.isArray(caps) && caps.length) return caps.some((x) => typeof x === "string" && x.toLowerCase() === "vision") ? "yes" : "no";
  return undefined;
}

const KNOWN_LISTS = 32;
const KNOWN_MODELS = 5000;

type Known = { lists: Record<string, Record<string, Sees>> };
let known: Known | undefined;

function load(): Known {
  if (known) return known;
  known = { lists: {} };
  try {
    const v = JSON.parse(fs.readFileSync(appFiles.modelPictures(), "utf8"));
    if (v && typeof v.lists === "object" && v.lists) {
      for (const [k, list] of Object.entries(v.lists as Record<string, unknown>)) {
        if (!list || typeof list !== "object") continue;
        const clean: Record<string, Sees> = {};
        for (const [m, s] of Object.entries(list)) if (s === "yes" || s === "no" || s === "unknown") clean[m] = s;
        known.lists[k] = clean;
      }
    }
  } catch {
    // missing or invalid: empty
  }
  return known;
}

/** Tests: forget what was loaded. */
export function resetVisionMemory(): void {
  known = undefined;
}

const listKey = (provider: string, base: string) => `${provider} ${base.replace(/\/+$/, "")}`;

/** Remembers what a provider's model list said about each model. */
export function remember(provider: string, base: string, models: { id: string; sees?: Sees }[]): void {
  const k = load();
  const key = listKey(provider, base);
  const next: Record<string, Sees> = {};
  for (const m of models.slice(0, KNOWN_MODELS)) if (m.sees) next[m.id] = m.sees;
  if (!Object.keys(next).length) {
    if (!(key in k.lists)) return;
    delete k.lists[key];
  } else {
    const old = k.lists[key];
    if (old && JSON.stringify(old) === JSON.stringify(next)) return;
    if (!old && Object.keys(k.lists).length >= KNOWN_LISTS) return;
    k.lists[key] = next;
  }
  try {
    writeJsonAtomic(appFiles.modelPictures(), k, { tmp: appFiles.modelPictures().replace(/\.json$/, ".json.tmp") });
  } catch {
    // best effort
  }
}

export function sees(provider: string, base: string, model: string): Sees {
  return load().lists[listKey(provider, base)]?.[model] ?? modelSees(provider, model);
}
