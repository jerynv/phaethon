import fs from "node:fs";
import path from "node:path";
import { isValidCliModel, validReasoning, type CliId } from "./cli.ts";
import type { CliModels } from "./models.ts";

/**
 * The reasoning level a space chose for a CLI and model, read strictly from
 * `<space>/.phaethon/space.json` → `cliReasoning.<cli>.<model or "$default">`
 * (storage.md §2.2.2). The setter and its commands belong to the storage
 * worker; the turn reads it once per turn.
 */

export const DEFAULT_REASONING_MODEL = "$default";
const UNREADABLE = "This space’s settings file can’t be read; reasoning was not changed.";

function readMeta(spaceDir: string): Record<string, unknown> | null {
  const state = path.join(spaceDir, ".phaethon");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(state);
  } catch {
    return null;
  }
  if (!st.isDirectory()) throw new Error(UNREADABLE);
  const file = path.join(state, "space.json");
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > 64 * 1024) throw new Error(UNREADABLE);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(UNREADABLE);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(UNREADABLE);
  return value as Record<string, unknown>;
}

/** The saved level, or null. Throws a user-facing message when the saved settings are invalid. */
export function getReasoning(spaceDir: string, cli: CliId, model: string | null): string | null {
  const meta = readMeta(spaceDir);
  const all = meta?.cliReasoning;
  if (all === undefined) return null;
  if (!all || typeof all !== "object" || Array.isArray(all)) throw new Error("Invalid saved reasoning settings.");
  const forCli = (all as Record<string, unknown>)[cli];
  if (forCli === undefined) return null;
  if (!forCli || typeof forCli !== "object" || Array.isArray(forCli)) throw new Error("Invalid saved reasoning settings.");
  const key = model !== null && isValidCliModel(model) ? model : DEFAULT_REASONING_MODEL;
  const level = (forCli as Record<string, unknown>)[key];
  if (level === undefined) return null;
  if (typeof level !== "string" || !validReasoning(cli, level)) throw new Error("Invalid saved reasoning level.");
  return level;
}

/** Whether a live catalog lists `effort` for `model` (or, with no model, the catalog default), matched by id or alias. */
export function catalogSupportsReasoning(catalog: CliModels, model: string | null, effort: string): boolean {
  const wanted = model ?? catalog.defaultModel ?? null;
  if (wanted === null) return false;
  const entry = catalog.models.find((m) => m.id === wanted || (m.aliases ?? []).includes(wanted));
  return !!entry && (entry.reasoningEfforts ?? []).includes(effort);
}

/** For `space_reasoning_set` (storage worker): the selected instance's live catalog must list the level. */
export async function modelSupportsReasoning(cli: CliId, model: string | null, effort: string): Promise<boolean> {
  const { listModels } = await import("./models.ts");
  const { configDirFor } = await import("./instances.ts");
  return catalogSupportsReasoning(await listModels(cli, configDirFor(cli)), model, effort);
}
