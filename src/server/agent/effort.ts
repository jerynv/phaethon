import type { Message } from "../core/thread.ts";
import type { Effort } from "../providers/types.ts";
import { currentPlan } from "./lesson.ts";
import type { TutorMode } from "./tutor.ts";

/**
 * How hard the model thinks, per turn. Teaching and planning get more depth
 * than plain chat. Anthropic receives it as `output_config.effort`;
 * OpenAI-compatible reasoning models as `reasoning_effort`. A change between
 * turns costs one prompt-cache miss but keeps earlier thinking valid; it only
 * happens when the tutor mode changes, since the effort follows the mode.
 */

export type TurnKind = "chat" | "tutor" | "plan";

export function turnKind(mode: TutorMode, msgs: Message[]): TurnKind {
  if (mode === "normal") return "chat";
  return currentPlan(msgs) ? "tutor" : "plan";
}

/** A hand-edited `effort` setting, if it is one Phaethon can send. */
export function settingEffort(raw: string | null | undefined): Effort | undefined {
  switch (raw?.trim()) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return undefined;
  }
}

export function effortFor(kind: TurnKind, setting?: string | null): Effort {
  if (kind === "tutor" || kind === "plan") return "high";
  return settingEffort(setting) ?? "medium";
}
