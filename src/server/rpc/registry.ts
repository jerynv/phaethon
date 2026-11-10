import type { Channel } from "./channel.ts";

/**
 * Every command the renderer may call is registered here by name. Unknown names
 * are refused, the same allow-list the Tauri capability file used to be.
 */

export type CallContext = {
  /** Aborted when the renderer that made this call disconnects. */
  signal: AbortSignal;
};

// Handlers take loosely typed JSON in and give JSON (or bytes) back; each module types its own arguments.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: any, ctx: CallContext) => unknown;

const handlers = new Map<string, Handler>();

export function command(name: string, handler: Handler): void {
  if (handlers.has(name)) throw new Error(`Command ${name} is registered twice.`);
  handlers.set(name, handler);
}

export function commands(map: Record<string, Handler>): void {
  for (const [name, handler] of Object.entries(map)) command(name, handler);
}

export function handlerFor(name: string): Handler | undefined {
  return handlers.get(name);
}

export function commandNames(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * A message the UI shows as-is. Throw this (or a plain string) for an expected
 * refusal; any other error is logged with its stack and its message is shown.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

export function messageOf(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export type { Channel };
