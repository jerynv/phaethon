import type { Block, Role } from "../core/thread.ts";

/**
 * What every model provider gives the agent loop. The conversation is always
 * in Anthropic's Messages shape; other APIs convert at their boundary.
 */

export type WireMessage = { role: Role; content: Block[] };
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown>; eager_input_streaming?: boolean };
export type Effort = "low" | "medium" | "high";

export type ModelRequest = {
  /** Byte-stable part first (cached), then the volatile tail. */
  system: { stable: string; volatile: string };
  messages: WireMessage[];
  tools: ToolDef[];
  /** This turn's reasoning depth. */
  effort: Effort;
  /** Cap on output; providers have their own default. */
  maxTokens?: number;
};

export type Delta =
  | { type: "textStart" }
  | { type: "text"; text: string }
  /** A progress note the model wrote between tool calls (Claude "updates" thinking). */
  | { type: "progress"; text: string }
  /** A readable reasoning summary, when the provider returns one. */
  | { type: "thinking"; text: string };

export type ModelTurn = {
  /** Assistant blocks exactly as they must be saved and sent back. */
  content: Block[];
  stopReason: string;
  /** Tool calls whose streamed input wasn't valid JSON: [toolUseId, raw]. */
  invalidInputs: [string, string][];
};

export type ErrorKind = "auth" | "billing" | "rateLimit" | "unavailable" | "badRequest" | "network";

/** A user-facing provider failure. The message never contains a key. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Sees = "yes" | "no" | "unknown";

export interface Provider {
  /** Preset id ("anthropic", "openai", …, "fake"). */
  readonly id: string;
  readonly model: string;
  /** Claude models get `send_to_user` and Claude-specific prompt notes. */
  readonly isClaude: boolean;
  imageInput(): Sees;
  turn(req: ModelRequest, onDelta: (d: Delta) => void, signal: AbortSignal): Promise<ModelTurn>;
}

export type WireRole = Role;
