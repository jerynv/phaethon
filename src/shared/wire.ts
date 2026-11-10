/**
 * The wire between the renderer and the Node core.
 *
 * It keeps the shape of the Tauri commands Phaethon used to have: a command is
 * a name plus a JSON object of camelCase arguments, it resolves with JSON or
 * rejects with a plain string the UI can show, and streams are Channels passed
 * as arguments. A Channel crosses the wire as `{ [CHANNEL_KEY]: id }`, and each
 * message on it arrives as a `ChannelFrame`.
 */

export const CHANNEL_KEY = "__phaethonChannel";
/** Binary results (file bytes) cross as base64 under this key and become an ArrayBuffer again. */
export const BYTES_KEY = "__phaethonBytes";

export type ChannelRef = { [CHANNEL_KEY]: number };
export type BytesRef = { [BYTES_KEY]: string };

/** Renderer → core. */
export type RequestFrame = { t: "req"; id: number; cmd: string; args: Record<string, unknown> };
/** Renderer → core: the renderer dropped a Channel (component unmounted, page left). */
export type CloseChannelFrame = { t: "close"; ch: number };
export type ClientFrame = RequestFrame | CloseChannelFrame | { t: "ping" };

/** Core → renderer. */
export type ResultFrame = { t: "ok"; id: number; value: unknown };
export type ErrorFrame = { t: "err"; id: number; error: string };
export type ChannelFrame = { t: "ch"; ch: number; msg: unknown };
export type ServerFrame = ResultFrame | ErrorFrame | ChannelFrame | { t: "pong" };

export function isChannelRef(v: unknown): v is ChannelRef {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[CHANNEL_KEY] === "number";
}

export function isBytesRef(v: unknown): v is BytesRef {
  return typeof v === "object" && v !== null && typeof (v as Record<string, unknown>)[BYTES_KEY] === "string";
}
