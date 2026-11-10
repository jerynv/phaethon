// STUB: owned by agent worker
import { Refusal } from "../rpc/registry.ts";

export type CompleteRequest = {
  space?: string;
  model?: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
};

/** One non-streaming completion with the vault's configured provider. */
export async function completeText(_req: CompleteRequest): Promise<{ text: string; model: string }> {
  throw new Refusal("No model is set up: add an API key in Settings, or switch to Claude Code.");
}
