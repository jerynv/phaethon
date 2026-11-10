import { Refusal } from "../rpc/registry.ts";
import { readSettings } from "../settings/settings.ts";
import { providerFor } from "./build.ts";
import { modelForSpace, parseRef } from "./presets.ts";
import type { Block } from "../core/thread.ts";
import type { Effort } from "./types.ts";

export type CompleteRequest = {
  space?: string;
  /** A `provider:model` reference; else the space's model, else the vault default. */
  model?: string;
  system: string;
  /** Text, or content blocks (pictures as Messages-API image blocks) for a model that sees them. */
  messages: { role: "user" | "assistant"; content: string | Block[] }[];
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
};

/**
 * One completion with the vault's configured provider, for background work
 * (study generation, summaries, compaction). Throws a Refusal with a
 * user-facing message when the provider can't be used (no key, no model) and a
 * ProviderError (also user-facing) when the call fails.
 */
function providerOf(req: { space?: string; model?: string }) {
  const settings = readSettings();
  let ref = modelForSpace(req.space, settings);
  if (req.model) {
    const parsed = parseRef(req.model);
    if (!parsed) throw new Refusal("That isn’t a model Phaethon knows how to use.");
    ref = parsed;
  }
  return providerFor(ref, settings);
}

/** Whether the model `completeText` would use takes pictures (false when it can't be used at all). */
export function completeSeesPictures(req: { space?: string; model?: string }): boolean {
  try {
    const provider = providerOf(req);
    return provider.id === "anthropic" || provider.imageInput() === "yes";
  } catch {
    return false;
  }
}

export async function completeText(req: CompleteRequest): Promise<{ text: string; model: string }> {
  const provider = providerOf(req);
  const turn = await provider.turn(
    {
      system: { stable: req.system, volatile: "" },
      messages: req.messages.map((m) => ({ role: m.role, content: typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content })),
      tools: [],
      effort: req.effort ?? "medium",
      maxTokens: req.maxTokens,
    },
    () => {},
    req.signal ?? new AbortController().signal,
  );
  if (turn.stopReason === "refusal") throw new Refusal("The model declined to answer this. Try rephrasing your message.");
  const text = turn.content
    .filter((b) => b.type === "text")
    .map((b) => String(b.text ?? ""))
    .join("\n\n");
  return { text, model: provider.model };
}
