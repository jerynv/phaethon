import { spaceDir } from "../core/vault.ts";
import { cliOfBackend, isCliId, isValidCliModel, validReasoning, type CliId } from "../cli/cli.ts";
import { DEFAULT_REASONING_MODEL, getReasoning, modelSupportsReasoning } from "../cli/reasoning.ts";
import { parseRef, savedRef } from "../providers/presets.ts";
import { commands, messageOf, Refusal } from "../rpc/registry.ts";
import { readSettings } from "../settings/settings.ts";
import { listSpaces, readSpaceMeta, updateSpaceMeta } from "./meta.ts";

/**
 * Which model a space uses (`space.json` `model` for Phaethon's agent,
 * `cliModels.<cli>` for a coding agent) and its reasoning level per CLI and
 * model (`cliReasoning`). Strings are the old commands' (storage.md §8).
 */

function backendCli(): CliId | null {
  return cliOfBackend(readSettings().backend);
}

function setCliModel(space: string, cli: CliId, model: string | null): void {
  const m = model?.trim() ?? null;
  if (m !== null && !isValidCliModel(m)) throw new Refusal("That isn’t a model name Phaethon can pass on: use letters, digits, and . - _ : / only.");
  updateSpaceMeta(
    space,
    (meta) => {
      const saved = meta.cliModels && typeof meta.cliModels === "object" && !Array.isArray(meta.cliModels) ? { ...(meta.cliModels as Record<string, unknown>) } : {};
      if (m) saved[cli] = m;
      else delete saved[cli];
      if (Object.keys(saved).length) meta.cliModels = saved;
      else delete meta.cliModels;
    },
    { failed: "The model couldn’t be saved" },
  );
}

commands({
  space_model_get: ({ space }: { space: string }) => {
    const meta = readSpaceMeta(space);
    const cli = backendCli();
    if (cli) return meta.cliModels[cli] ? `${cli}:${meta.cliModels[cli]}` : null;
    return meta.model ?? null;
  },

  space_model_set: ({ space, model }: { space: string; model?: string | null }) => {
    spaceDir(space);
    if (typeof model === "string") {
      const at = model.indexOf(":");
      const prefix = at > 0 ? model.slice(0, at) : "";
      if (isCliId(prefix)) return setCliModel(space, prefix, model.slice(at + 1));
    }
    const cli = backendCli();
    if ((model === null || model === undefined) && cli) return setCliModel(space, cli, null);
    if (model === null || model === undefined) {
      updateSpaceMeta(space, { model: null }, { failed: "The model couldn’t be saved" });
      return null;
    }
    const ref = parseRef(model);
    if (!ref) throw new Refusal("That isn’t a model Phaethon knows how to use.");
    updateSpaceMeta(space, { model: savedRef(ref) }, { failed: "The model couldn’t be saved" });
    return null;
  },

  space_models_list: () => {
    const cli = backendCli();
    const out: Record<string, string> = {};
    for (const s of listSpaces()) {
      try {
        const meta = readSpaceMeta(s.id);
        if (cli) {
          if (meta.cliModels[cli]) out[s.id] = `${cli}:${meta.cliModels[cli]}`;
        } else if (meta.model) out[s.id] = meta.model;
      } catch {
        // An unreadable space has no model of its own to show.
      }
    }
    return out;
  },

  space_reasoning_get: ({ space, cli, model }: { space: string; cli: string; model?: string | null }) => {
    if (!isCliId(cli)) throw new Refusal("Unknown assistant.");
    try {
      return getReasoning(spaceDir(space), cli, model ?? null);
    } catch (e) {
      throw new Refusal(messageOf(e));
    }
  },

  space_reasoning_set: async ({ space, cli, model, effort }: { space: string; cli: string; model?: string | null; effort?: string | null }) => {
    if (!isCliId(cli)) throw new Refusal("Unknown assistant.");
    spaceDir(space);
    const m = model ?? null;
    if (m !== null && !isValidCliModel(m)) throw new Refusal("Invalid model name.");
    if (effort) {
      if (!validReasoning(cli, effort)) throw new Refusal("That assistant does not support this reasoning level.");
      if (!(await modelSupportsReasoning(cli, m, effort))) throw new Refusal("This model does not report that reasoning level. Refresh its model list and retry.");
    }
    const key = m ?? DEFAULT_REASONING_MODEL;
    updateSpaceMeta(
      space,
      (meta) => {
        const all = meta.cliReasoning;
        if (all !== undefined && (!all || typeof all !== "object" || Array.isArray(all))) throw new Refusal("Invalid saved reasoning settings; nothing was changed.");
        const table = { ...((all as Record<string, unknown>) ?? {}) };
        const forCli = table[cli];
        if (forCli !== undefined && (!forCli || typeof forCli !== "object" || Array.isArray(forCli))) throw new Refusal("Invalid saved reasoning settings; nothing was changed.");
        const levels = { ...((forCli as Record<string, unknown>) ?? {}) };
        if (effort) levels[key] = effort;
        else delete levels[key];
        if (Object.keys(levels).length) table[cli] = levels;
        else delete table[cli];
        if (Object.keys(table).length) meta.cliReasoning = table;
        else delete meta.cliReasoning;
      },
      { failed: "Reasoning could not be saved" },
    );
    return null;
  },
});
