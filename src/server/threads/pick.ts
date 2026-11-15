import { cliOfBackend, isValidCliModel, validReasoning } from "../cli/cli.ts";
import { getReasoning } from "../cli/reasoning.ts";
import { spaceDir } from "../core/vault.ts";
import { defaultRef, parseRef, savedRef } from "../providers/presets.ts";
import { parseBackend, readSettings, setSettings, type Backend, type VaultSettings } from "../settings/settings.ts";
import { readSpaceMeta } from "../spaces/meta.ts";
import { isValidThreadId, loadIn, readPickRawIn, writePickRawIn } from "./store.ts";

/**
 * The model a conversation answers with, chosen per conversation in the
 * composer: which backend (Phaethon's own loop or a coding agent), which model
 * (`provider:model` for Phaethon, the CLI's own id for a coding agent; null
 * for that backend's default) and the reasoning effort (null for the
 * default). Saved beside the conversation (`threads/<id>.model`) and as the
 * vault's `lastModel`, which a new conversation
 * starts with. A conversation from before per-conversation choice has none
 * saved and keeps answering as it did: the vault's backend with the space's
 * model.
 */
export type ModelPick = { backend: Backend; model: string | null; effort: string | null };

const OWN_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** A pick from untrusted JSON, or null when any part of it isn't usable. */
export function parsePick(value: unknown): ModelPick | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const backend = parseBackend(o.backend);
  if (!backend) return null;
  const model = o.model === null || o.model === undefined ? null : typeof o.model === "string" ? o.model.trim() : undefined;
  const effort = o.effort === null || o.effort === undefined ? null : typeof o.effort === "string" ? o.effort.trim() : undefined;
  if (model === undefined || effort === undefined) return null;
  const cli = cliOfBackend(backend);
  if (cli) {
    if (model !== null && !isValidCliModel(model)) return null;
    if (effort !== null && !validReasoning(cli, effort)) return null;
    return { backend, model: model || null, effort: effort || null };
  }
  let ref: string | null = null;
  if (model) {
    const parsed = parseRef(model);
    if (!parsed) return null;
    ref = savedRef(parsed);
  }
  if (effort !== null && !OWN_EFFORTS.includes(effort)) return null;
  return { backend, model: ref, effort: effort || null };
}

/** How the space answered before per-conversation choice: the vault's backend, the space's model. */
export function legacyPick(space: string, settings: VaultSettings = readSettings()): ModelPick {
  const backend = settings.backend;
  const cli = cliOfBackend(backend);
  const meta = readSpaceMeta(space);
  if (cli) {
    const model = meta.cliModels[cli] ?? null;
    let effort: string | null = null;
    try {
      effort = getReasoning(spaceDir(space), cli, model);
    } catch {
      effort = null;
    }
    return { backend, model, effort };
  }
  const own = typeof meta.model === "string" ? parseRef(meta.model) : undefined;
  const ref = own ?? defaultRef(settings);
  return { backend, model: ref ? savedRef(ref) : null, effort: OWN_EFFORTS.includes(settings.effort ?? "") ? settings.effort : null };
}

export type PickView = {
  pick: ModelPick;
  /** True when this conversation has its own saved choice. */
  saved: boolean;
};

/**
 * Conversation `thread`'s model: its own choice; else, for a conversation that
 * hasn't started (or none named: a new chat), the last one picked anywhere;
 * else the space's legacy model.
 */
export function effectivePick(space: string, thread?: string | null): PickView {
  const dir = spaceDir(space);
  const id = isValidThreadId(thread) ? thread : null;
  const own = id ? parsePick(readPickRawIn(dir, id)) : null;
  if (own) return { pick: own, saved: true };
  const settings = readSettings();
  let started = false;
  if (id) {
    try {
      started = loadIn(dir, id).length > 0;
    } catch {
      started = true;
    }
  }
  const last = started ? null : parsePick(settings.lastModel);
  return { pick: last ?? legacyPick(space, settings), saved: false };
}

/** Saves the choice for conversation `thread` (none: only as the default) and as the one new conversations start with. */
export function savePick(space: string, thread: string | null, pick: ModelPick): void {
  if (thread !== null) writePickRawIn(spaceDir(space), thread, pick);
  try {
    setSettings({ lastModel: pick });
  } catch {
    // An unreadable settings file only loses the default for new conversations.
  }
}
