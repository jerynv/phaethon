import type { Block } from "../core/thread.ts";
import { backoffMs, bodyText, isRedirect, parseJson, rateLimitSuffix, request, retryAfterSecs, RETRIES, shouldRetry, sleep, sseEvents, StreamDropped, StreamIdle, TimeoutError } from "./http.ts";
import { isValidModelId } from "./presets.ts";
import { ProviderError, type Delta, type ModelRequest, type ModelTurn, type Provider, type Sees } from "./types.ts";
import { modelSees } from "./vision.ts";

/**
 * Anthropic's Messages API over raw HTTPS + SSE. Redirects are never followed,
 * so the key only ever reaches api.anthropic.com.
 */

export const API_VERSION = "2023-06-01";
export const MAX_TOKENS = 64_000;

/**
 * Every beta this provider may send, in one place. Each is sent only to models
 * that take it (see `claudeTraits`).
 * - fallback: `fallbacks: "default"` reruns a declined request on a fallback model.
 * - updates: `thinking.display: "updates"` returns the notes Claude writes between tool calls.
 * - binding: `thinking.block_binding` so a changed system prompt or tool set drops stale
 *   thinking blocks instead of failing the request (preserved thinking).
 */
export const ANTHROPIC_BETAS = {
  fallback: "server-side-fallback-2026-07-01",
  updates: "thinking-display-updates-2026-08-18",
  binding: "thinking-binding-controls-2026-08-01",
} as const;

export const INTERRUPTED_NOTE = "This part of the response was interrupted before it finished.";

export type ClaudeTraits = {
  /** Takes `thinking: {type: "adaptive"}` (4.6 and later). */
  adaptive: boolean;
  /** Takes `output_config.effort`. */
  effort: boolean;
  /** Returns between-tool notes as text with `display: "updates"`. */
  updates: boolean;
  /** Takes `fallbacks: "default"`. */
  fallbacks: boolean;
};

/** What a Claude model accepts, from its id (`claude-<family>-<major>[-<minor>]`). Unknown ids get the conservative set. */
export function claudeTraits(model: string): ClaudeTraits {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(model);
  if (!m) return { adaptive: false, effort: false, updates: false, fallbacks: false };
  const family = m[1];
  const v = Number(m[2]) + (m[3] && m[3].length <= 2 && Number(m[3]) < 10 ? Number(m[3]) / 10 : 0);
  const frontier = family === "fable" || family === "mythos";
  return {
    adaptive: frontier || v >= 4.6,
    effort: frontier || v >= 4.6 || (family === "opus" && v >= 4.5),
    updates: (frontier && v >= 5) || ((family === "opus" || family === "sonnet") && v >= 5.5),
    fallbacks: (family === "opus" && v >= 5) || (family === "sonnet" && v >= 5.5) || (family === "fable" && v >= 5.1),
  };
}

export const BILLING = "Your Anthropic account is out of credit or has a billing problem. Add credit at console.anthropic.com, then try again.";

function isBilling(status: number, err: { type?: unknown; message?: unknown } | undefined): boolean {
  return status === 402 || err?.type === "billing_error" || (typeof err?.message === "string" && err.message.toLowerCase().includes("credit balance"));
}

export function httpError(status: number, body: string, retryAfter: number | undefined): ProviderError {
  const err = (parseJson(body) as { error?: { type?: unknown; message?: unknown } } | undefined)?.error;
  const detail = typeof err?.message === "string" ? err.message : "";
  if (isBilling(status, err)) return new ProviderError("billing", BILLING);
  if (status === 401) return new ProviderError("auth", "Anthropic didn’t accept your API key. Check it in Settings.");
  if (status === 403) return new ProviderError("auth", "Your API key isn’t allowed to do this. Check its permissions at console.anthropic.com.");
  if (status === 429) return new ProviderError("rateLimit", `Anthropic is limiting how fast this key can send messages.${rateLimitSuffix(retryAfter)}`, retryAfter);
  if ([400, 404, 413, 422].includes(status)) return new ProviderError("badRequest", `Anthropic couldn’t accept this request. ${detail}`.trim());
  return new ProviderError("unavailable", "Anthropic is overloaded or having problems right now. Try again in a few minutes.", retryAfter);
}

export function requestBody(model: string, req: ModelRequest): Record<string, unknown> {
  const t = claudeTraits(model);
  const system: Block[] = [{ type: "text", text: req.system.stable, cache_control: { type: "ephemeral" } }];
  if (req.system.volatile) system.push({ type: "text", text: req.system.volatile });
  const body: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? MAX_TOKENS,
    stream: true,
    cache_control: { type: "ephemeral" },
    system,
    messages: req.messages,
  };
  if (t.effort) body.output_config = { effort: req.effort };
  if (t.fallbacks) body.fallbacks = "default";
  if (t.adaptive) {
    body.thinking = {
      type: "adaptive",
      ...(t.updates ? { display: "updates" } : {}),
      block_binding: { prefix_mismatch_behavior: "drop_block" },
    };
  }
  if (req.tools.length) body.tools = req.tools;
  return body;
}

export function betasFor(model: string): string[] {
  const t = claudeTraits(model);
  const out: string[] = [];
  if (t.fallbacks) out.push(ANTHROPIC_BETAS.fallback);
  if (t.updates) out.push(ANTHROPIC_BETAS.updates);
  if (t.adaptive) out.push(ANTHROPIC_BETAS.binding);
  return out;
}

/** Keeps what's safe to send back after a server-side fallback: blocks from the last switch on, plus earlier text. */
export function echoSafe(blocks: Block[]): Block[] {
  const last = blocks.map((b) => b.type).lastIndexOf("fallback");
  if (last < 0) return blocks;
  return blocks.filter((b, i) => i >= last || b.type === "text");
}

export class Anthropic implements Provider {
  readonly id = "anthropic";
  readonly isClaude = true;
  constructor(
    private readonly key: string,
    readonly model: string,
    private readonly base: string,
  ) {}

  imageInput(): Sees {
    return modelSees("anthropic", this.model);
  }

  async turn(req: ModelRequest, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ModelTurn> {
    const body = JSON.stringify(requestBody(this.model, req));
    const headers: Record<string, string> = {
      "x-api-key": this.key,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    };
    const betas = betasFor(this.model);
    if (betas.length) headers["anthropic-beta"] = betas.join(",");
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await request(`${this.base}/v1/messages`, { method: "POST", headers, body }, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        if (attempt < RETRIES) {
          await sleep(backoffMs(attempt), signal);
          continue;
        }
        throw new ProviderError("network", "Phaethon couldn’t reach Anthropic. Check your internet connection, then try again.");
      }
      if (isRedirect(res.status)) {
        await bodyText(res);
        throw new ProviderError("badRequest", "Anthropic redirected the request to another address. The request was not forwarded.");
      }
      if (res.ok && res.body) return readStream(res.body, onDelta, signal, claudeTraits(this.model).updates);
      const wait = retryAfterSecs(res.headers);
      const err = httpError(res.status, await bodyText(res), wait);
      if (shouldRetry(err.kind, wait, attempt)) {
        await sleep(backoffMs(attempt, wait), signal);
        continue;
      }
      throw err;
    }
  }
}

type Slot = Block & { _raw?: string };

async function readStream(body: ReadableStream<Uint8Array>, onDelta: (d: Delta) => void, signal: AbortSignal, updates: boolean): Promise<ModelTurn> {
  const blocks: (Slot | null)[] = [];
  const invalid: [string, string][] = [];
  let stopReason: string | undefined;
  let stopped = false;
  try {
    for await (const data of sseEvents(body, signal)) {
      if (!data) continue;
      const ev = parseJson(data) as Record<string, any> | undefined;
      if (!ev || typeof ev !== "object") continue;
      switch (ev.type) {
        case "content_block_start": {
          const i = Number(ev.index);
          while (blocks.length <= i) blocks.push(null);
          const block: Slot = { ...(ev.content_block ?? {}) };
          if (block.type === "tool_use") block._raw = "";
          blocks[i] = block;
          if (block.type === "text") {
            onDelta({ type: "textStart" });
            if (typeof block.text === "string" && block.text) onDelta({ type: "text", text: block.text });
          }
          break;
        }
        case "content_block_delta": {
          const block = blocks[Number(ev.index)];
          const d = ev.delta ?? {};
          if (!block) break;
          if (d.type === "text_delta") {
            block.text = String(block.text ?? "") + d.text;
            onDelta({ type: "text", text: String(d.text) });
          } else if (d.type === "thinking_delta") {
            block.thinking = String(block.thinking ?? "") + d.thinking;
            if (!updates && d.thinking) onDelta({ type: "thinking", text: String(d.thinking) });
          } else if (d.type === "signature_delta") block.signature = d.signature;
          else if (d.type === "input_json_delta") block._raw = (block._raw ?? "") + d.partial_json;
          else if (d.type === "citations_delta") block.citations = [...((block.citations as unknown[]) ?? []), d.citation];
          break;
        }
        case "content_block_stop": {
          const block = blocks[Number(ev.index)];
          if (!block) break;
          if (block.type === "tool_use") {
            const raw = block._raw ?? "";
            delete block._raw;
            if (!raw.trim()) block.input = {};
            else {
              const parsed = parseJson(raw);
              if (parsed === undefined) {
                block.input = {};
                invalid.push([String(block.id), raw]);
              } else block.input = parsed;
            }
          } else if (block.type === "thinking" && updates) {
            const note = String(block.thinking ?? "").trim();
            if (note && note !== INTERRUPTED_NOTE) onDelta({ type: "progress", text: note });
          }
          break;
        }
        case "message_delta":
          if (ev.delta?.stop_reason) stopReason = String(ev.delta.stop_reason);
          break;
        case "message_stop":
          stopped = true;
          break;
        case "error": {
          const e = ev.error ?? {};
          if (e.type === "overloaded_error" || e.type === "api_error") {
            throw new ProviderError("unavailable", "Anthropic is overloaded or having problems, and stopped the reply. Try again in a few minutes.");
          }
          if (e.type === "rate_limit_error") throw new ProviderError("rateLimit", `Anthropic is limiting how fast this key can send messages.${rateLimitSuffix(undefined)}`);
          if (isBilling(0, e)) throw new ProviderError("billing", BILLING);
          throw new ProviderError("badRequest", `Anthropic stopped the reply: ${e.message || "unknown error"}`);
        }
        default:
          break;
      }
      if (stopped) break;
    }
  } catch (e) {
    if (e instanceof ProviderError || signal.aborted) throw e;
    if (e instanceof StreamIdle) throw new ProviderError("network", "Anthropic stopped responding in the middle of the reply. Try again.");
    if (e instanceof StreamDropped || e instanceof TimeoutError) {
      throw new ProviderError("network", "The connection to Anthropic dropped in the middle of the reply. Check your internet connection, then try again.");
    }
    throw e;
  }
  if (!stopped || !stopReason) throw new ProviderError("network", "The reply from Anthropic ended early. Try again.");
  const content = echoSafe(blocks.filter((b): b is Slot => b !== null));
  return { content, stopReason, invalidInputs: invalid };
}

// ---------------------------------------------------------------------------
// Key check and model list

export type KeyCheck = { ok: boolean; problem?: "format" | "rejected" | "network" | "billing"; message: string };

export function keyFormatOk(key: string): boolean {
  return key.startsWith("sk-ant-") && key.length >= 20 && key.length <= 400 && /^[A-Za-z0-9_-]+$/.test(key);
}

export async function checkKey(base: string, rawKey: string): Promise<KeyCheck> {
  const key = rawKey.trim();
  if (!keyFormatOk(key)) {
    return {
      ok: false,
      problem: "format",
      message: "That doesn’t look like an Anthropic API key. Keys start with sk-ant- and are about 100 characters long; copy the whole key from console.anthropic.com.",
    };
  }
  let res: Response;
  try {
    res = await request(`${base}/v1/models?limit=1`, { headers: { "x-api-key": key, "anthropic-version": API_VERSION }, timeoutMs: 20_000 });
  } catch {
    return { ok: false, problem: "network", message: "Phaethon couldn’t reach Anthropic to check the key. Check your internet connection, then try again." };
  }
  const text = await bodyText(res);
  if (res.ok) return { ok: true, message: "This key works." };
  const err = (parseJson(text) as { error?: { type?: unknown; message?: unknown } } | undefined)?.error;
  if (isBilling(res.status, err)) return { ok: false, problem: "billing", message: BILLING };
  if (res.status === 401 || res.status === 403) {
    return { ok: false, problem: "rejected", message: "Anthropic didn’t accept this key. It may have been deleted, or part of it is missing. Copy it again from console.anthropic.com." };
  }
  if (res.status === 429) return { ok: true, message: "This key works." };
  return { ok: false, problem: "network", message: "Anthropic couldn’t check the key right now. Try again in a few minutes." };
}

export type ModelInfo = { id: string; name: string; sees?: Sees };

export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
];

export async function listModels(base: string, key: string): Promise<ModelInfo[] | undefined> {
  try {
    const res = await request(`${base}/v1/models?limit=100`, { headers: { "x-api-key": key, "anthropic-version": API_VERSION }, timeoutMs: 20_000 });
    const text = await bodyText(res);
    if (!res.ok) return undefined;
    const data = (parseJson(text) as { data?: unknown } | undefined)?.data;
    if (!Array.isArray(data)) return undefined;
    const out: ModelInfo[] = [];
    for (const e of data) {
      const id = (e as { id?: unknown })?.id;
      if (typeof id !== "string" || !isValidModelId(id)) continue;
      const display = (e as { display_name?: unknown }).display_name;
      const name = typeof display === "string" && display.trim() ? display.trim() : id;
      out.push({ id, name: [...name].slice(0, 80).join("") });
    }
    return out.length ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function modelsOrFallback(base: string, key: string | undefined): Promise<ModelInfo[]> {
  return (key ? await listModels(base, key) : undefined) ?? FALLBACK_MODELS;
}
