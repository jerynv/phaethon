import fs from "node:fs";
import path from "node:path";
import { generateKeyPair, randomUUID, sign } from "node:crypto";
import { appDataDir } from "../env.ts";
import { redactText } from "./redact.ts";
import { MAX_TELEMETRY_PAYLOAD_BYTES, parseTelemetryPayload } from "../../shared/telemetry.ts";

/** Injected by the release build only after the owner configures a collector. */
declare const __PHAETHON_TELEMETRY_ENDPOINT__: string;

export const CATEGORIES = ["usage", "diagnostics", "reports", "traces"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Choices = Record<Category, boolean>;
export type Consent = Choices & { configured: boolean };
export const OFF: Choices = { usage: false, diagnostics: false, reports: false, traces: false };
export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";
export type View = "chat" | "files" | "study" | "grades" | "plan" | "courses" | "settings";
export type Action = "chat_sent" | "space_created" | "file_opened" | "search_used" | "study_started";
export type Payload = { category: Category; event: string; appVersion: string; platform: "darwin" | "win32" | "linux" | "other"; data: object };
export type Envelope = { v: 1; id: string; sentAt: string; publicKey: string; payload: string; signature: string };
const BACKENDS = ["phaethon", "claude-cli", "codex-cli", "gemini-cli"];
const VIEWS = ["chat", "files", "study", "grades", "plan", "courses", "settings"];
const ACTIONS = ["chat_sent", "space_created", "file_opened", "search_used", "study_started"];
const exact = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const enumOf = (value: unknown, values: readonly string[]): value is string => typeof value === "string" && values.includes(value);
const integer = (x: unknown, max: number) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= max;

export function parseChoices(value: unknown): Choices | null {
  if (!object(value) || !exact(value, [...CATEGORIES]) || !CATEGORIES.every((c) => typeof value[c] === "boolean")) return null;
  return Object.fromEntries(CATEGORIES.map((c) => [c, value[c]])) as Choices;
}

/** Reconstruct every allowed shape: usage/diagnostics can never carry arbitrary context. */
export function cleanData(category: Category, event: string, value: unknown): object | null {
  if (!object(value)) return null;
  if (category === "usage") {
    if (!["app_opened", "view_opened", "action_completed"].includes(event) || !exact(value, ["view", "action", "count"])) return null;
    if (value.view !== undefined && !enumOf(value.view, VIEWS)) return null;
    if (value.action !== undefined && !enumOf(value.action, ACTIONS)) return null;
    if (value.count !== undefined && !integer(value.count, 10_000)) return null;
    if (event === "view_opened" && value.view === undefined || event === "action_completed" && value.action === undefined) return null;
    return { ...(value.view === undefined ? {} : { view: value.view }), ...(value.action === undefined ? {} : { action: value.action }), ...(value.count === undefined ? {} : { count: value.count }) };
  }
  if (category === "diagnostics") {
    if (event !== "turn_completed" || !exact(value, ["backend", "outcome", "durationMs", "steps"]) || !enumOf(value.backend, BACKENDS) || !enumOf(value.outcome, ["completed", "failed", "cancelled"]) || !integer(value.durationMs, 86_400_000) || value.steps !== undefined && !integer(value.steps, 10_000)) return null;
    return { backend: value.backend, outcome: value.outcome, durationMs: value.durationMs, steps: value.steps ?? 0 };
  }
  if (category === "reports") {
    if (event !== "testing_report" || !exact(value, ["text"]) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 4000) return null;
    return { text: redactText(value.text, 4000) };
  }
  if (category === "traces") {
    if (event !== "chat_trace" || !exact(value, ["backend", "messages"]) || !enumOf(value.backend, BACKENDS) || !Array.isArray(value.messages) || !value.messages.length || value.messages.length > 20) return null;
    const messages = [];
    for (const m of value.messages) {
      if (!object(m) || !exact(m, ["role", "text"]) || !enumOf(m.role, ["user", "assistant"]) || typeof m.text !== "string" || m.text.length > 8000) return null;
      messages.push({ role: m.role, text: redactText(m.text) });
    }
    return { backend: value.backend, messages };
  }
  return null;
}

/** A new signing key for every envelope. This proves integrity, not app attestation. */
export async function signedEnvelope(payload: Payload): Promise<Envelope> {
  const { publicKey, privateKey } = await new Promise<{ publicKey: import("node:crypto").KeyObject; privateKey: import("node:crypto").KeyObject }>((resolve, reject) => {
    generateKeyPair("ed25519", {}, (error, publicKey, privateKey) => error ? reject(error) : resolve({ publicKey, privateKey }));
  });
  const id = randomUUID();
  const sentAt = new Date().toISOString();
  const json = JSON.stringify(payload);
  return { v: 1, id, sentAt, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), payload: json, signature: sign(null, Buffer.from(`phaethon.telemetry.v1\n${id}\n${sentAt}\n${json}`, "utf8"), privateKey).toString("base64") };
}

/** No default collector. HTTP is available only for explicitly enabled loopback tests. */
export function collectorEndpoint(): string | null {
  try {
    const built = typeof __PHAETHON_TELEMETRY_ENDPOINT__ === "undefined" ? "" : __PHAETHON_TELEMETRY_ENDPOINT__;
    const url = new URL(process.env.PHAETHON_TELEMETRY_ENDPOINT ?? built);
    if (url.username || url.password || url.hash || url.search) return null;
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (process.env.PHAETHON_TELEMETRY_ALLOW_LOCAL === "1" && local && ["http:", "https:"].includes(url.protocol)) return url.href;
    if (url.protocol !== "https:" || process.env.PHAETHON_TEST === "1" || process.env.PHAETHON_PACKAGED !== "1") return null;
    return url.href;
  } catch { return null; }
}

type Item = { payload: Payload; envelope?: Envelope; bytes: number; epoch: number; tries: number; readyAt: number };
type Options = { file?: () => string; endpoint?: () => string | null; fetch?: typeof fetch; retryMs?: number[]; timeoutMs?: number };

export class TelemetryClient {
  private previous: Consent = { ...OFF, configured: false };
  private epochs: Record<Category, number> = { usage: 0, diagnostics: 0, reports: 0, traces: 0 };
  private queue: Item[] = [];
  private active?: { item: Item; abort: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private failedSave = false;
  private closed = false;
  constructor(private options: Options = {}) {}
  private file() { return this.options.file?.() ?? path.join(appDataDir(), "telemetry-consent.json"); }
  private endpoint() { return (this.options.endpoint ?? collectorEndpoint)(); }
  consent(): Consent {
    let next: Consent = { ...OFF, configured: false };
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file(), "utf8"));
      if (object(raw) && exact(raw, ["v", "configured", ...CATEGORIES]) && raw.v === 1 && raw.configured === true) {
        const { v: _, configured: __, ...choices } = raw;
        const valid = parseChoices(choices);
        if (valid && !this.failedSave) next = { ...valid, configured: true };
      }
    } catch { /* Missing, unreadable or corrupt preferences fail closed. */ }
    for (const c of CATEGORIES) {
      if (!next[c] && this.previous[c]) this.epochs[c]++;
      if (!next[c]) {
        this.queue = this.queue.filter((i) => i.payload.category !== c);
        if (this.active?.item.payload.category === c) this.active.abort.abort();
      }
    }
    this.previous = next;
    return { ...next };
  }
  save(value: unknown): Consent {
    const choices = parseChoices(value);
    if (!choices) throw new Error("Choose on or off for each privacy setting.");
    // Revoke before touching disk, including when the save fails.
    for (const c of CATEGORIES) if (!choices[c]) {
      this.epochs[c]++;
      this.queue = this.queue.filter((i) => i.payload.category !== c);
      if (this.active?.item.payload.category === c) this.active.abort.abort();
    }
    const file = this.file();
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, configured: true, ...choices }), { mode: 0o600 });
      fs.renameSync(tmp, file);
      this.failedSave = false;
    } catch {
      this.failedSave = true;
      try { fs.unlinkSync(tmp); } catch { /* no temporary file */ }
      this.consent();
      throw new Error("Couldn’t save your privacy choices. Collection is paused.");
    }
    return this.consent();
  }
  ticket(category: Category): number | null {
    return !this.closed && this.consent()[category] && this.endpoint() ? this.epochs[category] : null;
  }
  valid(category: Category, epoch: number | null): boolean {
    this.consent();
    return this.current(category, epoch) && this.endpoint() !== null;
  }
  /** In-memory check for streamed chunks; disk is checked again at completion and delivery. */
  current(category: Category, epoch: number | null): boolean {
    return !this.closed && epoch !== null && this.previous[category] && this.epochs[category] === epoch;
  }
  capture(category: Category, event: string, data: unknown, ticket?: number | null): boolean {
    const epoch = this.ticket(category);
    if (epoch === null || ticket !== undefined && ticket !== epoch) return false;
    const clean = cleanData(category, event, data);
    if (!clean) return false;
    const version = process.env.PHAETHON_VERSION ?? "0.0.0-dev";
    const appVersion = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version) && version.length <= 64 ? version : "0.0.0-dev";
    const platform = ["darwin", "win32", "linux"].includes(process.platform) ? process.platform as Payload["platform"] : "other";
    const payload: Payload = { category, event, appVersion, platform, data: clean };
    // Use the collector's schema at the boundary as well, so changes to either
    // side cannot silently produce uploads that ingestion will discard.
    try { parseTelemetryPayload(payload); } catch { return false; }
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_TELEMETRY_PAYLOAD_BYTES) return false;
    // Memory only: maximum 64 items / 512 KiB of serialized payload, including the active item.
    // Retained envelope strings add a second bounded copy plus signature overhead. No restart backlog.
    const pending = this.active && !this.queue.includes(this.active.item) ? [...this.queue, this.active.item] : this.queue;
    if (pending.length >= 64 || bytes + pending.reduce((n, i) => n + i.bytes, 0) > 512 * 1024) return false;
    this.queue.push({ payload, bytes, epoch, tries: 0, readyAt: 0 });
    this.schedule(0);
    return true;
  }
  private schedule(ms: number) {
    if (this.closed || this.timer || this.pumping) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.pump(); }, ms);
    this.timer.unref?.();
  }
  private async pump() {
    if (this.closed || this.pumping) return;
    this.pumping = true;
    let nextDelay = 0;
    try {
      this.consent();
      const item = this.queue.find((i) => i.readyAt <= Date.now());
      if (!item) {
        nextDelay = this.queue.length ? Math.max(1, Math.min(...this.queue.map((i) => i.readyAt)) - Date.now()) : 0;
        return;
      }
      const endpoint = this.endpoint();
      if (!endpoint || !this.valid(item.payload.category, item.epoch)) { this.queue = this.queue.filter((i) => i !== item); return; }
      const abort = new AbortController();
      this.active = { item, abort };
      const timeout = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 10_000);
      const watchConsent = setInterval(() => this.consent(), 250);
      timeout.unref?.(); watchConsent.unref?.();
      let retry = false;
      try {
        // Retain delivery identity when the collector accepted a request but its response was lost.
        const envelope = item.envelope ??= await signedEnvelope(item.payload);
        if (!abort.signal.aborted && this.valid(item.payload.category, item.epoch) && this.endpoint() === endpoint) {
          const response = await (this.options.fetch ?? fetch)(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope), signal: abort.signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
          retry = response.status === 429 || response.status >= 500;
          // We need no collector response data, and never log it.
          await response.body?.cancel();
        }
      } catch { retry = true; }
      finally { clearTimeout(timeout); clearInterval(watchConsent); this.active = undefined; }
      const delays = this.options.retryMs ?? [1000, 5000];
      if (retry && this.valid(item.payload.category, item.epoch) && item.tries < delays.length) {
        item.readyAt = Date.now() + delays[item.tries++]!;
      } else this.queue = this.queue.filter((i) => i !== item);
    } finally {
      this.pumping = false;
      if (this.queue.length) this.schedule(nextDelay);
    }
  }
  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.active?.abort.abort();
    this.queue = [];
  }
}

export const telemetry = new TelemetryClient();
