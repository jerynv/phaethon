/**
 * The telemetry wire format, shared by the app (which builds and signs
 * envelopes) and the collector (which verifies them). Preferences and anything
 * that could identify an installation never belong here.
 */

export const TELEMETRY_CATEGORIES = ["usage", "diagnostics", "reports", "traces"] as const;
export type TelemetryCategory = (typeof TELEMETRY_CATEGORIES)[number];
export type TelemetryChoices = Record<TelemetryCategory, boolean>;

export const TELEMETRY_BACKENDS = ["phaethon", "claude-cli", "codex-cli", "gemini-cli"] as const;
export type TelemetryBackend = (typeof TELEMETRY_BACKENDS)[number];
export const TELEMETRY_VIEWS = ["chat", "files", "study", "grades", "plan", "courses", "settings"] as const;
export type TelemetryView = (typeof TELEMETRY_VIEWS)[number];
export const TELEMETRY_ACTIONS = ["chat_sent", "space_created", "file_opened", "search_used", "study_started"] as const;
export type TelemetryAction = (typeof TELEMETRY_ACTIONS)[number];
const PLATFORMS = ["darwin", "win32", "linux", "other"] as const;
const OUTCOMES = ["completed", "failed", "cancelled"] as const;

export const MAX_REPORT_CHARS = 4000;
export const MAX_TRACE_MESSAGE_CHARS = 8000;
export const MAX_TELEMETRY_BODY_BYTES = 256 * 1024;
export const MAX_TELEMETRY_PAYLOAD_BYTES = 192 * 1024;
export const TELEMETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TELEMETRY_MAX_FUTURE_MS = 5 * 60 * 1000;
export const TELEMETRY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TelemetryPayload = {
  appVersion: string;
  platform: (typeof PLATFORMS)[number];
} & (
  | {
      category: "usage";
      event: "app_opened" | "view_opened" | "action_completed";
      data: { view?: TelemetryView; action?: TelemetryAction; count?: number };
    }
  | {
      category: "diagnostics";
      event: "turn_completed";
      data: { backend: TelemetryBackend; outcome: (typeof OUTCOMES)[number]; durationMs: number; steps: number };
    }
  | { category: "reports"; event: "testing_report"; data: { text: string } }
  | {
      category: "traces";
      event: "chat_trace";
      data: { backend: TelemetryBackend; messages: Array<{ role: "user" | "assistant"; text: string }> };
    }
);

export interface TelemetryEnvelope {
  v: 1;
  id: string;
  sentAt: string;
  /** Base64 DER SPKI of a fresh Ed25519 key, used for this envelope only. */
  publicKey: string;
  /** The payload as JSON text; the signature covers these exact characters. */
  payload: string;
  signature: string;
}

function invalid(): never {
  throw new TypeError("Invalid telemetry");
}

/** A plain object with no keys outside `allowed`. */
function record(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) invalid();
  return object;
}

function text(value: unknown, max: number, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid();
  return value;
}

function oneOf(value: unknown, choices: readonly string[]): void {
  if (typeof value !== "string" || !choices.includes(value)) invalid();
}

function count(value: unknown, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
}

export function isTelemetryCategory(value: unknown): value is TelemetryCategory {
  return typeof value === "string" && (TELEMETRY_CATEGORIES as readonly string[]).includes(value);
}

/** A canonical UTC ISO timestamp with 0–3 fractional digits. */
export function isTelemetryTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!match) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  // Rejects dates that parse but roll over, like February 30th.
  return new Date(millis).toISOString() === `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
}

/** Strict: every allowed value is listed here, and unknown keys are rejected at every level. */
export function parseTelemetryPayload(value: unknown): TelemetryPayload {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_TELEMETRY_PAYLOAD_BYTES) invalid();
    value = JSON.parse(value) as unknown;
  }
  const payload = record(value, ["category", "event", "appVersion", "platform", "data"]);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(text(payload.appVersion, 64, 1))) invalid();
  oneOf(payload.platform, PLATFORMS);

  switch (payload.category) {
    case "usage": {
      oneOf(payload.event, ["app_opened", "view_opened", "action_completed"]);
      const data = record(payload.data, ["view", "action", "count"]);
      if (data.view !== undefined || payload.event === "view_opened") oneOf(data.view, TELEMETRY_VIEWS);
      if (data.action !== undefined || payload.event === "action_completed") oneOf(data.action, TELEMETRY_ACTIONS);
      if (data.count !== undefined) count(data.count, 10_000);
      break;
    }
    case "diagnostics": {
      oneOf(payload.event, ["turn_completed"]);
      const data = record(payload.data, ["backend", "outcome", "durationMs", "steps"]);
      oneOf(data.backend, TELEMETRY_BACKENDS);
      oneOf(data.outcome, OUTCOMES);
      count(data.durationMs, 86_400_000);
      count(data.steps, 10_000);
      break;
    }
    case "reports": {
      oneOf(payload.event, ["testing_report"]);
      const data = record(payload.data, ["text"]);
      if (!text(data.text, MAX_REPORT_CHARS, 1).trim()) invalid();
      break;
    }
    case "traces": {
      oneOf(payload.event, ["chat_trace"]);
      const data = record(payload.data, ["messages", "backend"]);
      oneOf(data.backend, TELEMETRY_BACKENDS);
      if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 20) invalid();
      for (const message of data.messages) {
        const m = record(message, ["role", "text"]);
        oneOf(m.role, ["user", "assistant"]);
        text(m.text, MAX_TRACE_MESSAGE_CHARS);
      }
      break;
    }
    default:
      invalid();
  }
  return payload as TelemetryPayload;
}

/**
 * Checks an envelope's shape without its age, for records already archived.
 * Ingestion must use `parseTelemetryEnvelope`, which also rejects stale events.
 */
export function parseStoredTelemetryEnvelope(value: unknown): TelemetryEnvelope {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_TELEMETRY_BODY_BYTES) invalid();
    value = JSON.parse(value) as unknown;
  }
  const envelope = record(value, ["v", "id", "sentAt", "publicKey", "payload", "signature"]);
  if (envelope.v !== 1 || typeof envelope.id !== "string" || !TELEMETRY_UUID.test(envelope.id)) invalid();
  if (!isTelemetryTimestamp(envelope.sentAt)) invalid();
  // Exactly one encoding each: a 44-byte Ed25519 SPKI key and a 64-byte signature, no trailing data.
  if (!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(text(envelope.publicKey, 60, 60))) invalid();
  if (!/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(text(envelope.signature, 88, 88))) invalid();
  parseTelemetryPayload(text(envelope.payload, MAX_TELEMETRY_PAYLOAD_BYTES, 1));
  return envelope as unknown as TelemetryEnvelope;
}

export function parseTelemetryEnvelope(value: unknown, now = Date.now()): TelemetryEnvelope {
  const envelope = parseStoredTelemetryEnvelope(value);
  const age = now - Date.parse(envelope.sentAt);
  if (age > TELEMETRY_MAX_AGE_MS || age < -TELEMETRY_MAX_FUTURE_MS) invalid();
  return envelope;
}

/**
 * The bytes each envelope's signature covers. The key is fresh per envelope, so
 * a valid signature proves the payload wasn't altered, not which app sent it.
 */
export function telemetrySignatureMessage(e: Pick<TelemetryEnvelope, "id" | "sentAt" | "payload">): string {
  return `phaethon.telemetry.v1\n${e.id}\n${e.sentAt}\n${e.payload}`;
}
