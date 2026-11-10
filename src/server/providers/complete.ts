// STUB: owned by agent
import { Refusal } from "../rpc/registry.ts";

/**
 * Placeholder for one non-streaming completion with the vault's provider, so
 * storage code (clearing a conversation into memory) typechecks before the
 * agent worker's branch is merged. The real module replaces this file.
 */
export async function completeText(_req: {
  space?: string;
  model?: string;
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
  signal?: AbortSignal;
}): Promise<{ text: string; model: string }> {
  throw new Refusal("Phaethon has no model set up to do that yet.");
}
