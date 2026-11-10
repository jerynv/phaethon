import crypto from "node:crypto";
import type { Block } from "../core/thread.ts";
import { backoffMs, bodyText, isConnectError, isRedirect, parseJson, rateLimitSuffix, request, retryAfterSecs, RETRIES, shouldRetry, sleep, sseEvents, StreamDropped, StreamIdle, TimeoutError } from "./http.ts";
import { isLoopback, isValidCompatModel, keyProblem, origin, type Preset } from "./presets.ts";
import { ProviderError, type Delta, type Effort, type ModelRequest, type ModelTurn, type Provider, type Sees, type WireMessage } from "./types.ts";
import { fromMetadata, remember, sees } from "./vision.ts";
import type { KeyCheck, ModelInfo } from "./anthropic.ts";

/**
 * OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Groq, …, Ollama, LM
 * Studio, your own server). The conversation stays in Anthropic's Messages
 * shape on disk and is converted here, on the way out and back.
 */

export type CompatConfig = { preset: Preset; base: string; key?: string; model: string };

const who = (p: Preset) => (p.id === "custom" ? "Your server" : p.name);
const whoMid = (p: Preset) => (p.id === "custom" ? "your server" : p.name);
const shown = (base: string) => origin(base) ?? base;
const isLocal = (p: Preset, base: string) => p.local || isLoopback(base);

/** Does the model take `reasoning_effort`? */
export function takesReasoningEffort(model: string): boolean {
  const bare = model.slice(model.lastIndexOf("/") + 1).toLowerCase();
  return /^(o1|o3|o4|gpt-5|grok-3-mini)/.test(bare) || bare.includes("gpt-oss");
}

export const IMAGE_NOTE = "[An image was attached here, but this model can’t see images.]";

function wireId(id: string, mistral: boolean): string {
  if (!mistral || /^[A-Za-z0-9]{9}$/.test(id)) return id;
  const digest = crypto.createHash("sha256").update(id).digest();
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = digest.readBigUInt64BE(0);
  let out = "";
  for (let i = 0; i < 9; i++) {
    out += alphabet[Number(n % 62n)];
    n /= 62n;
  }
  return out;
}

function resultText(block: Block, images: boolean): string {
  const c = block.content;
  let text: string;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    text = c
      .map((part: Block) => (part.type === "text" ? String(part.text ?? "") : part.type === "image" ? (images ? "[Page image follows.]" : IMAGE_NOTE) : ""))
      .filter((s) => s !== "")
      .join("\n");
  } else text = "";
  return block.is_error ? `Error: ${text}` : text;
}

function imageUrl(block: Block): string | undefined {
  const src = block.source as { media_type?: unknown; data?: unknown } | undefined;
  if (typeof src?.media_type !== "string" || typeof src?.data !== "string") return undefined;
  return `data:${src.media_type};base64,${src.data}`;
}

/** Messages-shape conversation → Chat Completions messages. */
export function toMessages(system: string, messages: WireMessage[], images: boolean, mistral: boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];
  for (const m of messages) {
    const content: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    if (m.role === "assistant") {
      const text = content.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n\n");
      const calls = content
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: wireId(String(b.id), mistral), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
      const msg: Record<string, unknown> = { role: "assistant", content: calls.length && !text ? null : text };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    const results = content.filter((b) => b.type === "tool_result");
    for (const r of results) out.push({ role: "tool", tool_call_id: wireId(String(r.tool_use_id), mistral), content: resultText(r, images) });
    const parts: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[] = [];
    for (const b of content) {
      if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
      else if (b.type === "image") {
        const url = imageUrl(b);
        parts.push(images && url ? { type: "image_url", image_url: { url } } : { type: "text", text: IMAGE_NOTE });
      } else if (b.type === "document") {
        const src = b.source as { type?: unknown; data?: unknown } | undefined;
        const title = String(b.title ?? "").replaceAll('"', "'");
        if (src?.type === "text") parts.push({ type: "text", text: `<document name="${title}">\n${String(src.data ?? "").trimEnd()}\n</document>` });
        else parts.push({ type: "text", text: `[The attached PDF ${b.title ?? ""} couldn’t be read as text.]` });
      }
    }
    for (const r of results) {
      if (!Array.isArray(r.content)) continue;
      for (const part of r.content as Block[]) {
        if (part.type !== "image") continue;
        const url = imageUrl(part);
        if (!images || !url) continue;
        parts.push({ type: "text", text: `Page image returned by tool ${r.tool_use_id}:` });
        parts.push({ type: "image_url", image_url: { url } });
      }
    }
    if (!parts.length) continue;
    out.push({ role: "user", content: parts.every((x) => x.type === "text") ? parts.map((x) => (x as { text: string }).text).join("\n\n") : parts });
  }
  return out;
}

function hasImages(messages: WireMessage[]): boolean {
  return messages.some((m) => m.content.some((b) => b.type === "image" || (b.type === "tool_result" && Array.isArray(b.content) && (b.content as Block[]).some((p) => p.type === "image"))));
}

function refusesImages(status: number, body: string): boolean {
  const b = body.toLowerCase();
  return [400, 404, 415, 422, 500].includes(status) && ["image", "vision", "multimodal", "multi-modal", "content must be a string", "expected a string"].some((w) => b.includes(w));
}

function detailOf(body: string): { detail: string; code?: string } {
  const v = parseJson(body) as Record<string, any> | undefined;
  const e = v?.error;
  let detail = "";
  if (typeof e?.message === "string") detail = e.message;
  else if (typeof e === "string") detail = e;
  else if (typeof v?.message === "string") detail = v.message;
  else if (typeof v?.detail === "string") detail = v.detail;
  else detail = [...body].slice(0, 300).join("");
  const code = typeof e?.code === "string" || typeof e?.code === "number" ? String(e.code) : typeof e?.type === "string" ? e.type : undefined;
  return { detail: detail.trim(), code };
}

export function httpError(p: Preset, model: string, hasKey: boolean, status: number, body: string, retryAfter?: number): ProviderError {
  const { detail, code } = detailOf(body);
  const w = who(p);
  if (status === 402 || code === "insufficient_quota") return new ProviderError("billing", `Your ${p.name} account is out of credit or has a billing problem. Add credit with ${p.name}, then try again.`);
  if (status === 401 && !hasKey) return new ProviderError("auth", `${w} asked for an API key. Add one in Settings › Assistant.`);
  if (status === 401) return new ProviderError("auth", `${w} didn’t accept your API key. Check it in Settings.`);
  if (status === 403) return new ProviderError("auth", `${w} refused this request. ${detail}`.trim());
  if (status === 404) {
    const hint = p.id === "ollama" ? ` To download it, run ollama pull ${model} in a terminal.` : " Choose another in Settings, or check its name.";
    return new ProviderError("badRequest", `${w} couldn’t find the model ${model}.${hint} ${detail}`.trim());
  }
  if (status === 429) return new ProviderError("rateLimit", `${w} is limiting how fast this key can send messages.${rateLimitSuffix(retryAfter)}`, retryAfter);
  if ([400, 413, 422].includes(status)) return new ProviderError("badRequest", `${w} couldn’t accept this request. ${detail}`.trim());
  return new ProviderError("unavailable", `${w} is overloaded or having problems right now. Try again in a few minutes.`, retryAfter);
}

function reachError(p: Preset, base: string): ProviderError {
  if (isLocal(p, base)) return new ProviderError("network", `Phaethon couldn’t reach ${whoMid(p)} at ${shown(base)}. Make sure it’s open and running, then try again.`);
  if (p.id === "custom") return new ProviderError("network", `Phaethon couldn’t reach your server at ${shown(base)}. Check the address in Settings and your internet connection, then try again.`);
  return new ProviderError("network", `Phaethon couldn’t reach ${p.name}. Check your internet connection, then try again.`);
}

/**
 * Hides a `<think>…</think>` preamble some local models write at the very start
 * of a reply. Text that might still be the start of the tag is held back.
 */
export class ThinkFilter {
  #state: "start" | "inside" | "after" | "done" = "start";
  #held = "";
  push(t: string): string {
    if (this.#state === "done") return t;
    this.#held += t;
    if (this.#state === "start") {
      const lead = this.#held.trimStart();
      if (!lead) return "";
      if ("<think>".startsWith(lead)) return "";
      if (!lead.startsWith("<think>")) {
        this.#state = "done";
        const out = this.#held;
        this.#held = "";
        return out;
      }
      this.#state = "inside";
      this.#held = lead.slice("<think>".length);
    }
    if (this.#state === "inside") {
      const end = this.#held.indexOf("</think>");
      if (end < 0) {
        // Keep only what could be the start of the closing tag.
        const keep = Math.max(0, this.#held.length - "</think>".length);
        this.#held = this.#held.slice(keep);
        return "";
      }
      this.#held = this.#held.slice(end + "</think>".length);
      this.#state = "after";
    }
    if (this.#state === "after") {
      const rest = this.#held.trimStart();
      if (!rest) return "";
      this.#state = "done";
      this.#held = "";
      return rest;
    }
    return "";
  }
  /** At the end: anything held that turned out not to be the tag. */
  flush(): string {
    const out = this.#state === "start" ? this.#held : "";
    this.#held = "";
    return out;
  }
}

function effortField(p: Preset, model: string, effort: Effort | undefined): Record<string, unknown> {
  if (!effort) return {};
  if (p.id === "openrouter") return { reasoning: { effort } };
  return takesReasoningEffort(model) ? { reasoning_effort: effort } : {};
}

type Call = { id: string; name: string; args: string; argsObject?: unknown };

export class OpenAiCompatible implements Provider {
  readonly isClaude: boolean;
  constructor(private readonly cfg: CompatConfig) {
    this.isClaude = cfg.model.toLowerCase().includes("claude");
  }
  get id() {
    return this.cfg.preset.id;
  }
  get model() {
    return this.cfg.model;
  }

  imageInput(): Sees {
    return sees(this.cfg.preset.id, this.cfg.base, this.cfg.model);
  }

  async turn(req: ModelRequest, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ModelTurn> {
    const { preset: p, base, key, model } = this.cfg;
    const system = req.system.volatile ? `${req.system.stable}\n\n${req.system.volatile}` : req.system.stable;
    const mistral = p.id === "mistral";
    let images = this.imageInput() !== "no";
    const build = () =>
      JSON.stringify({
        model,
        stream: true,
        messages: toMessages(system, req.messages, images, mistral),
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
          : {}),
        ...effortField(p, model, req.effort),
      });
    let body = build();
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (key) headers.authorization = `Bearer ${key}`;
    const withImages = hasImages(req.messages);
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await request(`${base}/chat/completions`, { method: "POST", headers, body }, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        if ((p.local && isConnectError(e)) || attempt >= RETRIES) throw reachError(p, base);
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      if (isRedirect(res.status)) {
        await bodyText(res);
        throw new ProviderError("badRequest", `${who(p)} sent Phaethon to another address, and Phaethon doesn’t follow that with your messages or key. Check the address in Settings.`);
      }
      if (res.ok && res.body) return this.read(res, onDelta, signal);
      const text = await bodyText(res);
      if (withImages && images && refusesImages(res.status, text)) {
        images = false;
        body = build();
        attempt--;
        continue;
      }
      const wait = retryAfterSecs(res.headers);
      const err = httpError(p, model, !!key, res.status, text, wait);
      if (shouldRetry(err.kind, wait, attempt)) {
        await sleep(backoffMs(attempt, wait), signal);
        continue;
      }
      throw err;
    }
  }

  private async read(res: Response, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ModelTurn> {
    const p = this.cfg.preset;
    const filter = new ThinkFilter();
    let shownText = "";
    let started = false;
    let refusal = "";
    let finish: string | undefined;
    let done = false;
    let readAny = false;
    const calls: Call[] = [];
    const show = (t: string) => {
      if (!t) return;
      if (!started) {
        started = true;
        onDelta({ type: "textStart" });
      }
      shownText += t;
      onDelta({ type: "text", text: t });
    };
    const feed = (chunk: Record<string, any>, whole: boolean) => {
      if (chunk.error !== undefined) {
        const e = chunk.error;
        const code = String(e?.code ?? "");
        const detail = typeof e === "string" ? e : String(e?.message ?? "");
        if (code === "429" || code === "rate_limit_exceeded") throw new ProviderError("rateLimit", `${who(p)} is limiting how fast this key can send messages.${rateLimitSuffix(undefined)}`);
        if (code === "402" || code === "insufficient_quota") throw new ProviderError("billing", `Your ${p.name} account is out of credit or has a billing problem. Add credit with ${p.name}, then try again.`);
        throw new ProviderError("unavailable", `${who(p)} stopped the reply: ${detail || "no reason given"}`);
      }
      const choice = chunk.choices?.[0];
      if (!choice) {
        readAny ||= (chunk.usage && typeof chunk.usage === "object") || typeof chunk.object === "string";
        return;
      }
      readAny = true;
      const d = whole ? choice.message ?? {} : choice.delta ?? {};
      if (typeof d.content === "string") show(filter.push(d.content));
      if (typeof d.refusal === "string") refusal += d.refusal;
      if (Array.isArray(d.tool_calls)) {
        d.tool_calls.forEach((tc: Record<string, any>, pos: number) => {
          let slot: number;
          if (typeof tc.index === "number") slot = tc.index;
          else if (tc.id && calls.some((c) => c.id === tc.id)) slot = calls.findIndex((c) => c.id === tc.id);
          else if (tc.id) slot = calls.length;
          else if (whole) slot = pos;
          else slot = Math.max(0, calls.length - 1);
          while (calls.length <= slot) calls.push({ id: "", name: "", args: "" });
          const c = calls[slot];
          if (!c.id && tc.id) c.id = String(tc.id);
          if (!c.name && tc.function?.name) c.name = String(tc.function.name);
          const a = tc.function?.arguments;
          if (typeof a === "string") c.args += a;
          else if (a && typeof a === "object") c.argsObject = a;
        });
      }
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
    };
    try {
      if ((res.headers.get("content-type") ?? "").startsWith("application/json")) {
        const v = parseJson(await bodyText(res));
        if (v && typeof v === "object") feed(v as Record<string, any>, true);
        done = readAny;
      } else {
        for await (const data of sseEvents(res.body!, signal)) {
          if (!data) continue;
          if (data.trim() === "[DONE]") {
            done = true;
            break;
          }
          const v = parseJson(data);
          if (v && typeof v === "object") feed(v as Record<string, any>, false);
        }
      }
    } catch (e) {
      if (e instanceof ProviderError || signal.aborted) throw e;
      if (e instanceof StreamIdle) throw new ProviderError("network", `${who(p)} stopped responding in the middle of the reply. Try again.`);
      if (e instanceof StreamDropped || e instanceof TimeoutError) throw new ProviderError("network", `The connection to ${whoMid(p)} dropped in the middle of the reply. Try again.`);
      throw e;
    }
    show(filter.flush());
    if (!readAny) throw new ProviderError("unavailable", `${who(p)} sent a reply Phaethon couldn’t read. Try again, or choose another model.`);
    if (!done && !finish) throw new ProviderError("network", `The reply from ${whoMid(p)} ended early. Try again.`);
    const content: Block[] = [];
    const invalid: [string, string][] = [];
    if (shownText) content.push({ type: "text", text: shownText });
    const stamp = process.hrtime.bigint().toString(16);
    calls.forEach((c, i) => {
      if (!c.name) return;
      const clean = c.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
      const id = clean || `call_${stamp}_${i}`;
      let input: unknown = {};
      if (c.argsObject && typeof c.argsObject === "object") input = c.argsObject;
      else if (c.args.trim()) {
        const parsed = parseJson(c.args);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed;
        else invalid.push([id, c.args]);
      }
      content.push({ type: "tool_use", id, name: c.name, input });
    });
    const hasCalls = content.some((b) => b.type === "tool_use");
    let stopReason = "end_turn";
    if (finish === "length") stopReason = "max_tokens";
    else if (finish === "content_filter") stopReason = "refusal";
    else if (hasCalls) stopReason = "tool_use";
    else if (refusal && !shownText) stopReason = "refusal";
    return { content, stopReason, invalidInputs: invalid };
  }
}

// ---------------------------------------------------------------------------
// Key check, model lists, local server status

export async function checkKey(p: Preset, base: string, rawKey: string): Promise<KeyCheck> {
  const key = rawKey.trim();
  const problem = keyProblem(p, base, key);
  if (problem) return { ok: false, problem: "format", message: problem };
  let res: Response;
  try {
    res = await request(`${base}${p.checkPath}`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 20_000 });
  } catch {
    return { ok: false, problem: "network", message: `Phaethon couldn’t reach ${whoMid(p)} to check the key. Check your internet connection, then try again.` };
  }
  const text = await bodyText(res);
  if (res.ok) return { ok: true, message: "This key works." };
  if (res.status === 402 || detailOf(text).code === "insufficient_quota") {
    return { ok: false, problem: "billing", message: `Your ${p.name} account is out of credit or has a billing problem. Add credit with ${p.name}, then try again.` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, problem: "rejected", message: `${who(p)} didn’t accept this key. It may have been deleted, or part of it is missing. Copy it again and paste it here.` };
  }
  if (res.status === 429) return { ok: true, message: "This key works." };
  return { ok: false, problem: "network", message: `${who(p)} couldn’t check the key right now. Try again in a few minutes.` };
}

const OPENAI_SKIP = ["embedding", "tts", "whisper", "dall-e", "moderation", "davinci", "babbage", "transcribe", "realtime", "audio", "image", "search", "sora", "computer-use"];

export async function listModels(p: Preset, base: string, key: string | undefined): Promise<ModelInfo[]> {
  const local = isLocal(p, base);
  let res: Response;
  try {
    res = await request(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, timeoutMs: local ? 4_000 : 20_000 });
  } catch {
    throw new Error(local ? `${who(p)} isn’t running at ${shown(base)}. Open it, then check again.` : `Phaethon couldn’t reach ${whoMid(p)} at ${shown(base)}. Check the address and your internet connection.`);
  }
  const text = await bodyText(res);
  if (res.status === 401 || res.status === 403) {
    throw new Error(key ? `${who(p)} didn’t accept your API key, so its models can’t be listed. Check the key above.` : `${who(p)} asked for an API key before it lists its models.`);
  }
  const v = res.ok ? parseJson(text) : undefined;
  const list = Array.isArray(v) ? v : (v as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(list)) throw new Error(`Phaethon couldn’t get the list of models from ${whoMid(p)} just now. You can still type a model’s name.`);
  let out: ModelInfo[] = [];
  for (const e of list) {
    const id = (e as { id?: unknown })?.id;
    if (typeof id !== "string" || !isValidCompatModel(id)) continue;
    if (p.id === "openai" && OPENAI_SKIP.some((s) => id.toLowerCase().includes(s))) continue;
    const n = (e as { name?: unknown; display_name?: unknown }).name ?? (e as { display_name?: unknown }).display_name;
    const name = typeof n === "string" && n.trim() ? [...n.trim()].slice(0, 100).join("") : id;
    const s = fromMetadata(e);
    out.push(s ? { id, name, sees: s } : { id, name });
    if (out.length >= 5000) break;
  }
  if (p.id === "openai") out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (p.id === "ollama") out = await ollamaSight(base, out);
  remember(p.id, base, out);
  return out;
}

async function ollamaSight(base: string, models: ModelInfo[]): Promise<ModelInfo[]> {
  const root = base.replace(/\/v1\/?$/, "");
  try {
    const res = await request(`${root}/api/tags`, { timeoutMs: 4_000 });
    const v = parseJson(await bodyText(res)) as { models?: unknown } | undefined;
    if (Array.isArray(v?.models)) {
      for (const e of v.models as Record<string, unknown>[]) {
        const id = typeof e.model === "string" ? e.model : typeof e.name === "string" ? e.name : undefined;
        const s = fromMetadata(e);
        const m = models.find((x) => x.id === id);
        if (m && !m.sees && s) m.sees = s;
      }
    }
  } catch {
    // keep what we have
  }
  const started = Date.now();
  for (const m of models.filter((x) => !x.sees).slice(0, 64)) {
    if (Date.now() - started > 8_000) break;
    try {
      const res = await request(`${root}/api/show`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: m.id }), timeoutMs: 3_000 });
      const s = fromMetadata(parseJson(await bodyText(res)));
      if (s) m.sees = s;
    } catch {
      // unknown
    }
  }
  return models;
}

export type ServerStatus = { running: boolean; models: ModelInfo[]; message: string };

export async function status(p: Preset, base: string, key: string | undefined): Promise<ServerStatus> {
  try {
    const models = await listModels(p, base, key);
    let message: string;
    if (!models.length) {
      message = p.id === "ollama" ? "Ollama is running, but has no models yet. Download one with ollama pull llama3.2 in a terminal, then check again." : `${who(p)} is running, but has no models loaded yet. Load one, then check again.`;
    } else message = models.length === 1 ? `${who(p)} is running, with 1 model.` : `${who(p)} is running, with ${models.length} models.`;
    return { running: true, models, message };
  } catch (e) {
    return { running: false, models: [], message: (e as Error).message };
  }
}
