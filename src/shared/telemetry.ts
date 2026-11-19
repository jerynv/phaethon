/** Wire-only telemetry types. Preferences and persistent installation IDs never belong here. */
export const TELEMETRY_CATEGORIES = ["usage", "diagnostics", "reports", "traces"] as const;
export type TelemetryCategory = typeof TELEMETRY_CATEGORIES[number];
export const TELEMETRY_BACKENDS = ["phaethon", "claude-cli", "codex-cli", "gemini-cli"] as const;
export type TelemetryBackend = typeof TELEMETRY_BACKENDS[number];
export const MAX_TELEMETRY_BODY_BYTES = 256 * 1024;
export const MAX_TELEMETRY_PAYLOAD_BYTES = 192 * 1024;
export const TELEMETRY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const TELEMETRY_MAX_FUTURE_MS = 5 * 60 * 1000;
export const TELEMETRY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type TelemetryPayload = {
  appVersion: string;
  platform: "darwin" | "win32" | "linux" | "other";
} & (
  | { category: "usage"; event: "app_opened" | "view_opened" | "action_completed"; data: {
    view?: "chat" | "files" | "study" | "grades" | "plan" | "courses" | "settings";
    action?: "chat_sent" | "space_created" | "file_opened" | "search_used" | "study_started";
    count?: number;
  } }
  | { category: "diagnostics"; event: "turn_completed"; data: {
    backend: TelemetryBackend; outcome: "completed" | "failed" | "cancelled"; durationMs: number; steps: number;
  } }
  | { category: "reports"; event: "testing_report"; data: { text: string } }
  | { category: "traces"; event: "chat_trace"; data: {
    messages: Array<{ role: "user" | "assistant"; text: string }>; backend: TelemetryBackend;
  } }
);
export interface TelemetryEnvelope {
  v: 1; id: string; sentAt: string; publicKey: string; payload: string; signature: string;
}

function invalid(): never { throw new TypeError("Invalid telemetry"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some(key => !keys.includes(key))) return invalid();
  return object;
}
function string(value: unknown, max: number, min = 0): asserts value is string {
  if (typeof value !== "string" || value.length < min || value.length > max) invalid();
}
function choice(value: unknown, choices: readonly string[]): void {
  if (typeof value !== "string" || !choices.includes(value)) invalid();
}
function integer(value: unknown, max: number): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) invalid();
}
export function isTelemetryCategory(value: unknown): value is TelemetryCategory {
  return typeof value === "string" && (TELEMETRY_CATEGORIES as readonly string[]).includes(value);
}
export function isTelemetryTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  const normalized = value.includes(".") ? value.replace(/\.(\d+)Z$/, (_, fraction: string) => `.${fraction.padEnd(3, "0")}Z`) : value.replace("Z", ".000Z");
  return new Date(millis).toISOString() === normalized;
}
export function parseTelemetryPayload(value: unknown): TelemetryPayload {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_TELEMETRY_PAYLOAD_BYTES) invalid();
    value = JSON.parse(value) as unknown;
  }
  const p = record(value, ["category", "event", "appVersion", "platform", "data"]);
  string(p.appVersion, 64, 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(p.appVersion)) invalid();
  choice(p.platform, ["darwin", "win32", "linux", "other"]);
  switch (p.category) {
    case "usage": {
      choice(p.event, ["app_opened", "view_opened", "action_completed"]);
      const d = record(p.data, ["view", "action", "count"]);
      if (d.view !== undefined) choice(d.view, ["chat", "files", "study", "grades", "plan", "courses", "settings"]);
      if (d.action !== undefined) choice(d.action, ["chat_sent", "space_created", "file_opened", "search_used", "study_started"]);
      if (d.count !== undefined) integer(d.count, 10_000);
      break;
    }
    case "diagnostics": {
      choice(p.event, ["turn_completed"]);
      const d = record(p.data, ["backend", "outcome", "durationMs", "steps"]);
      choice(d.backend, TELEMETRY_BACKENDS);
      choice(d.outcome, ["completed", "failed", "cancelled"]);
      integer(d.durationMs, 86_400_000);
      integer(d.steps, 10_000);
      break;
    }
    case "reports": {
      choice(p.event, ["testing_report"]);
      const d = record(p.data, ["text"]);
      string(d.text, 4000, 1);
      break;
    }
    case "traces": {
      choice(p.event, ["chat_trace"]);
      const d = record(p.data, ["messages", "backend"]);
      choice(d.backend, TELEMETRY_BACKENDS);
      if (!Array.isArray(d.messages) || d.messages.length < 1 || d.messages.length > 20) invalid();
      for (const message of d.messages) {
        const m = record(message, ["role", "text"]);
        choice(m.role, ["user", "assistant"]);
        string(m.text, 8000);
      }
      break;
    }
    default: invalid();
  }
  return p as TelemetryPayload;
}
/** Structural validation for retained archives. Ingestion must use parseTelemetryEnvelope. */
export function parseStoredTelemetryEnvelope(value: unknown): TelemetryEnvelope {
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_TELEMETRY_BODY_BYTES) invalid();
    value = JSON.parse(value) as unknown;
  }
  const e = record(value, ["v", "id", "sentAt", "publicKey", "payload", "signature"]);
  if (e.v !== 1 || typeof e.id !== "string" || !TELEMETRY_UUID.test(e.id)) invalid();
  if (!isTelemetryTimestamp(e.sentAt)) invalid();
  // Ed25519 DER SPKI is exactly 44 bytes; reject alternative encodings and trailing data.
  string(e.publicKey, 60, 60);
  if (!/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(e.publicKey)) invalid();
  string(e.signature, 88, 88);
  if (!/^[A-Za-z0-9+/]{85}[AQgw]==$/.test(e.signature)) invalid();
  string(e.payload, MAX_TELEMETRY_PAYLOAD_BYTES, 1);
  parseTelemetryPayload(e.payload);
  return e as unknown as TelemetryEnvelope;
}
export function parseTelemetryEnvelope(value: unknown, now = Date.now()): TelemetryEnvelope {
  const e = parseStoredTelemetryEnvelope(value);
  const age = now - Date.parse(e.sentAt);
  if (age > TELEMETRY_MAX_AGE_MS || age < -TELEMETRY_MAX_FUTURE_MS) invalid();
  return e;
}
/** Self-signed integrity only: this is neither app attestation nor proof of truth. */
export function telemetrySignatureMessage(e: Pick<TelemetryEnvelope, "id" | "sentAt" | "payload">): string {
  return `phaethon.telemetry.v1\n${e.id}\n${e.sentAt}\n${e.payload}`;
}
