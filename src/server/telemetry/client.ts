import fs from "node:fs";
import path from "node:path";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { appDataDir } from "../env.ts";
import { redactText } from "./redact.ts";
import {
  MAX_REPORT_CHARS,
  parseTelemetryPayload,
  TELEMETRY_CATEGORIES,
  telemetrySignatureMessage,
  type TelemetryCategory,
  type TelemetryChoices,
  type TelemetryEnvelope,
  type TelemetryPayload,
} from "../../shared/telemetry.ts";

/**
 * Sends the telemetry each person agreed to. Their choices live in app data
 * (outside the vault, never synced), and nothing is sent until they have saved
 * them. Events wait in a small in-memory queue; nothing survives a restart.
 */

/** Set by release builds (scripts/build-node.mjs); empty everywhere else. */
declare const __PHAETHON_TELEMETRY_ENDPOINT__: string;

export type Consent = TelemetryChoices & { configured: boolean };
export const OFF: TelemetryChoices = { usage: false, diagnostics: false, reports: false, traces: false };

const MAX_QUEUED = 64;
const MAX_QUEUED_BYTES = 512 * 1024;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(process.env.PHAETHON_VERSION ?? "")
  && process.env.PHAETHON_VERSION!.length <= 64
  ? process.env.PHAETHON_VERSION!
  : "0.0.0-dev";
const PLATFORM = ["darwin", "win32", "linux"].includes(process.platform)
  ? (process.platform as TelemetryPayload["platform"])
  : "other";

export function parseChoices(value: unknown): TelemetryChoices | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length !== TELEMETRY_CATEGORIES.length) return null;
  if (!TELEMETRY_CATEGORIES.every((c) => typeof object[c] === "boolean")) return null;
  return Object.fromEntries(TELEMETRY_CATEGORIES.map((c) => [c, object[c]])) as TelemetryChoices;
}

/** Signs with a key made for this envelope alone, so envelopes can't be linked to each other. */
export function signedEnvelope(payload: TelemetryPayload): TelemetryEnvelope {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const envelope = {
    v: 1 as const,
    id: randomUUID(),
    sentAt: new Date().toISOString(),
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    payload: JSON.stringify(payload),
  };
  const signature = sign(null, Buffer.from(telemetrySignatureMessage(envelope), "utf8"), privateKey);
  return { ...envelope, signature: signature.toString("base64") };
}

/**
 * Where to send events, or null to send nothing. Only installed release builds
 * have a collector; dev and test runs can opt into a loopback one with
 * PHAETHON_TELEMETRY_ALLOW_LOCAL=1.
 */
export function collectorEndpoint(): string | null {
  const built = typeof __PHAETHON_TELEMETRY_ENDPOINT__ === "undefined" ? "" : __PHAETHON_TELEMETRY_ENDPOINT__;
  let url: URL;
  try {
    url = new URL(process.env.PHAETHON_TELEMETRY_ENDPOINT ?? built);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (loopback && process.env.PHAETHON_TELEMETRY_ALLOW_LOCAL === "1") {
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  }
  const release = process.env.PHAETHON_PACKAGED === "1" && process.env.PHAETHON_TEST !== "1";
  return url.protocol === "https:" && release ? url.href : null;
}

/** Reports and traces are the only free text; redact it before it's signed. */
function redactData(category: TelemetryCategory, data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as { text?: unknown; messages?: unknown };
  if (category === "reports" && typeof d.text === "string") {
    return { ...d, text: redactText(d.text, MAX_REPORT_CHARS) };
  }
  if (category === "traces" && Array.isArray(d.messages)) {
    const messages = d.messages.map((m: { text?: unknown }) =>
      m && typeof m.text === "string" ? { ...m, text: redactText(m.text) } : m,
    );
    return { ...d, messages };
  }
  return data;
}

type Queued = { payload: TelemetryPayload; bytes: number; envelope?: TelemetryEnvelope; tries: number; readyAt: number };
type Options = {
  file?: () => string;
  endpoint?: () => string | null;
  fetch?: typeof fetch;
  /** Delay before each retry; its length is the number of retries. */
  retryMs?: number[];
  timeoutMs?: number;
};

export class TelemetryClient {
  private choices: Consent | null = null;
  /** Bumped each time a category is turned off; see `grant`. */
  private revocations: Record<TelemetryCategory, number> = { usage: 0, diagnostics: 0, reports: 0, traces: 0 };
  /** Includes the event being sent, which leaves the queue once it's delivered or dropped. */
  private queue: Queued[] = [];
  private sending?: { item: Queued; abort: AbortController };
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(private options: Options = {}) {}

  private file(): string {
    return this.options.file?.() ?? path.join(appDataDir(), "telemetry-consent.json");
  }

  private endpoint(): string | null {
    return (this.options.endpoint ?? collectorEndpoint)();
  }

  consent(): Consent {
    this.choices ??= this.load();
    return { ...this.choices };
  }

  /** Missing, unreadable or malformed choices count as not yet made. */
  private load(): Consent {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Record<string, unknown>;
      const { v, configured, ...rest } = saved;
      const choices = parseChoices(rest);
      if (v === 1 && configured === true && choices) return { ...choices, configured: true };
    } catch {
      // Fall through.
    }
    return { ...OFF, configured: false };
  }

  save(value: unknown): Consent {
    const choices = parseChoices(value);
    if (!choices) throw new Error("Choose on or off for each privacy setting.");
    for (const c of TELEMETRY_CATEGORIES) if (!choices[c]) this.revoke(c);
    const file = this.file();
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, configured: true, ...choices }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      fs.rmSync(tmp, { force: true });
      // Nothing is sent until a save succeeds.
      for (const c of TELEMETRY_CATEGORIES) this.revoke(c);
      this.choices = { ...OFF, configured: false };
      throw new Error("Couldn’t save your privacy choices. Collection is paused.");
    }
    this.choices = { ...choices, configured: true };
    return this.consent();
  }

  /** Drops the category's queued events and cancels its upload in flight. */
  private revoke(category: TelemetryCategory) {
    this.revocations[category]++;
    this.queue = this.queue.filter((item) => item.payload.category !== category);
    if (this.sending?.item.payload.category === category) this.sending.abort.abort();
  }

  enabled(category: TelemetryCategory): boolean {
    return !this.closed && this.consent()[category] && this.endpoint() !== null;
  }

  /**
   * For content gathered over time, like a chat turn: take a grant when it
   * starts and pass it to `capture` at the end. The capture is refused if the
   * category was off at the start or was turned off in between, even if it's
   * back on now.
   */
  grant(category: TelemetryCategory): number | null {
    return this.enabled(category) ? this.revocations[category] : null;
  }

  /** Queues one event if its category is on and it fits the schema. Returns whether it was queued. */
  capture(category: TelemetryCategory, event: string, data: unknown, grant?: number | null): boolean {
    if (!this.enabled(category)) return false;
    if (grant !== undefined && grant !== this.revocations[category]) return false;
    let payload: TelemetryPayload;
    try {
      const candidate = { category, event, appVersion: VERSION, platform: PLATFORM, data: redactData(category, data) };
      payload = parseTelemetryPayload(candidate);
    } catch {
      return false;
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    const queuedBytes = this.queue.reduce((sum, item) => sum + item.bytes, 0);
    if (this.queue.length >= MAX_QUEUED || queuedBytes + bytes > MAX_QUEUED_BYTES) return false;
    this.queue.push({ payload, bytes, tries: 0, readyAt: 0 });
    this.schedule(0);
    return true;
  }

  private schedule(delay: number) {
    if (this.closed || this.timer || this.sending) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sendNext();
    }, delay);
    this.timer.unref?.();
  }

  private async sendNext() {
    const endpoint = this.endpoint();
    if (!endpoint) {
      this.queue = [];
      return;
    }
    const now = Date.now();
    const item = this.queue.find((i) => i.readyAt <= now);
    if (!item) {
      if (this.queue.length) this.schedule(Math.min(...this.queue.map((i) => i.readyAt)) - now);
      return;
    }

    const abort = new AbortController();
    this.sending = { item, abort };
    const timeout = setTimeout(() => abort.abort(), this.options.timeoutMs ?? 10_000);
    let retry = false;
    try {
      // The same envelope on every retry, so the collector can tell a repeat
      // from a new event when only its response was lost.
      item.envelope ??= signedEnvelope(item.payload);
      const response = await (this.options.fetch ?? fetch)(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.envelope),
        signal: abort.signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      retry = response.status === 429 || response.status >= 500;
      await response.body?.cancel();
    } catch {
      retry = true;
    } finally {
      clearTimeout(timeout);
      this.sending = undefined;
    }

    // A revoked event has already left the queue, so it's never retried.
    const delays = this.options.retryMs ?? [1000, 5000];
    if (retry && this.queue.includes(item) && item.tries < delays.length) {
      item.readyAt = Date.now() + delays[item.tries++]!;
    } else {
      this.queue = this.queue.filter((i) => i !== item);
    }
    if (this.queue.length) this.schedule(0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.sending?.abort.abort();
    this.queue = [];
  }
}

export const telemetry = new TelemetryClient();
