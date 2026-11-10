// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (Claude's initialize-only capability probe, Codex's model/list paging, and the fallback projected from T3's model manifest.)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliName, isValidCliModel, validReasoning, type CliId } from "./cli.ts";
import { CLIENT_INFO } from "./codex.ts";
import { binary, cliCommand, collect, probeLines } from "./instances.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";
import { sleep, spawnInGroup, stopGroup } from "./process.ts";

/**
 * The models each CLI offers, from the CLI itself, for a space's model menu.
 * Discovery runs the selected account's CLI and never starts a model turn.
 * Nothing is cached.
 */

export type CliModel = {
  id: string;
  name: string;
  description?: string;
  aliases?: string[];
  reasoningEfforts?: string[];
  defaultReasoningEffort?: string;
};
export type CliModels = { models: CliModel[]; note?: string; defaultModel?: string };

const WAIT_MS = 20_000;
const RETRY_NOTE = "Couldn’t load models. Retry.";
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function effortLevels(values: unknown[], cli: CliId | null = null): string[] {
  const out: string[] = [];
  for (const v of values.slice(0, 64)) {
    if (typeof v !== "string" || !EFFORTS.includes(v) || out.includes(v)) continue;
    // A level the space couldn't save for this CLI is never offered.
    if (cli !== null && !validReasoning(cli, v)) continue;
    out.push(v);
  }
  return out;
}

/** A model with the optional fields left out when empty, as serde's skip rules wrote it. */
function model(m: { id: string; name: string; description?: string | null; aliases?: string[]; reasoningEfforts?: string[]; defaultReasoningEffort?: string | null }): CliModel {
  const out: CliModel = { id: m.id, name: m.name };
  if (m.description !== undefined && m.description !== null) out.description = m.description;
  if (m.aliases?.length) out.aliases = m.aliases;
  if (m.reasoningEfforts?.length) out.reasoningEfforts = m.reasoningEfforts;
  if (m.defaultReasoningEffort) out.defaultReasoningEffort = m.defaultReasoningEffort;
  return out;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function listModels(cli: CliId, dir: string | null): Promise<CliModels> {
  const bin = binary(cli, dir);
  if (!bin) return { models: [], note: `${cliName(cli)} isn’t installed.` };
  if (cli === "codex") return codexModels(bin, dir);
  if (cli === "claude") return claudeModels(bin, dir);
  return geminiModels(bin);
}

// ---- Claude Code ----

export function parseClaudeModels(response: unknown): CliModels | null {
  const reported = obj(response).models;
  if (!Array.isArray(reported)) return null;
  const models: CliModel[] = [];
  let defaultModel: string | undefined;
  for (const raw of reported.slice(0, 1000)) {
    const entry = obj(raw);
    const value = str(entry.value) ?? "";
    const resolved = isValidCliModel(entry.resolvedModel) ? entry.resolvedModel : undefined;
    if (value === "default") {
      defaultModel = resolved;
      continue;
    }
    const id = resolved ?? (isValidCliModel(value) ? value : undefined);
    if (!id) continue;
    const display = str(entry.displayName)?.trim() || id;
    const name = id.startsWith("claude-") && !display.startsWith("Claude ") ? `Claude ${display}` : display;
    const efforts = entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels) ? effortLevels(entry.supportedEffortLevels, "claude") : [];
    const alias = value !== id && isValidCliModel(value) ? value : undefined;
    const existing = models.find((m) => m.id === id);
    if (existing) {
      if (alias && !(existing.aliases ?? []).includes(alias)) existing.aliases = [...(existing.aliases ?? []), alias];
      continue;
    }
    const def = str(entry.defaultEffortLevel);
    models.push(
      model({
        id,
        name,
        description: str(entry.description)?.trim() || undefined,
        aliases: alias ? [alias] : [],
        reasoningEfforts: efforts,
        defaultReasoningEffort: def && efforts.includes(def) ? def : undefined,
      }),
    );
  }
  if (!models.length) return null;
  const out: CliModels = { models };
  if (defaultModel) out.defaultModel = defaultModel;
  return out;
}

/** A projection of T3's Claude model manifest (MIT, 7f6f47b): an offline fallback, not a claim of account access. */
export const CLAUDE_FALLBACK: { id: string; name: string; aliases: string[]; levels: string[]; minVersion: string | null }[] = JSON.parse(
  '[{"id":"claude-opus-5-5","name":"Claude Opus 5.5","aliases":["opus","opus-5.5","claude-opus-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.280"},{"id":"claude-sonnet-5-5","name":"Claude Sonnet 5.5","aliases":["sonnet","sonnet-5.5","claude-sonnet-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.284"},{"id":"claude-fable-5-1","name":"Claude Fable 5.1","aliases":["fable","fable-5.1","claude-fable-5.1"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.257"},{"id":"claude-fable-5","name":"Claude Fable 5","aliases":[],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.169"},{"id":"claude-opus-5","name":"Claude Opus 5","aliases":["opus-5","claude-opus-5.0","claude-opus-5-0"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.219"},{"id":"claude-opus-4-8","name":"Claude Opus 4.8","aliases":["opus-4.8","claude-opus-4.8"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.154"},{"id":"claude-opus-4-7","name":"Claude Opus 4.7","aliases":["opus-4.7","claude-opus-4.7"],"levels":["low","medium","high","max"],"minVersion":"2.1.111"},{"id":"claude-opus-4-6","name":"Claude Opus 4.6","aliases":["opus-4.6","claude-opus-4.6","claude-opus-4-6-20251117"],"levels":["low","medium","high","max"],"minVersion":null},{"id":"claude-opus-4-5","name":"Claude Opus 4.5","aliases":[],"levels":["low","medium","high","max"],"minVersion":null},{"id":"claude-sonnet-5","name":"Claude Sonnet 5","aliases":["sonnet-5","claude-sonnet-5.0","claude-sonnet-5-0"],"levels":["low","medium","high","xhigh","max"],"minVersion":null},{"id":"claude-sonnet-4-6","name":"Claude Sonnet 4.6","aliases":["sonnet-4.6","claude-sonnet-4.6","claude-sonnet-4-6-20251117"],"levels":["low","medium","high"],"minVersion":null},{"id":"claude-haiku-5-5","name":"Claude Haiku 5.5","aliases":["haiku","haiku-5.5","claude-haiku-5.5"],"levels":["low","medium","high","xhigh","max"],"minVersion":"2.1.293"},{"id":"claude-haiku-4-5","name":"Claude Haiku 4.5","aliases":["haiku-4.5","claude-haiku-4.5","claude-haiku-4-5-20251001"],"levels":[],"minVersion":null}]',
);

/** The first whitespace word shaped like `[v]X.Y.Z[-…]`. */
export function parseVersion(value: string): [number, number, number] | null {
  for (const word of value.split(/\s+/)) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(word);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function older(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

export function claudeFallback(installed: string | null): CliModel[] {
  const version = installed ? parseVersion(installed) : null;
  return CLAUDE_FALLBACK.filter((e) => {
    const min = e.minVersion ? parseVersion(e.minVersion) : null;
    return !min || (version !== null && !older(version, min));
  }).map((e) => model({ id: e.id, name: e.name, aliases: e.aliases, reasoningEfforts: effortLevels(e.levels, "claude") }));
}

async function claudeModels(bin: string, dir: string | null): Promise<CliModels> {
  const cmd = cliCommand("claude", bin, os.tmpdir(), dir);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--safe-mode", "--strict-mcp-config", "--no-session-persistence"];
  // Initialize only: no user message is ever sent.
  const request = JSON.stringify({ type: "control_request", request_id: "phaethon-models", request: { subtype: "initialize" } });
  const found = await probeLines(
    cmd,
    args,
    [request],
    WAIT_MS,
    100,
    (v) => {
      const response = obj(obj(v).response);
      if (response.request_id !== "phaethon-models") return undefined;
      return { value: response.subtype === "success" ? parseClaudeModels(response.response) : null };
    },
    { ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_AUTO_CONNECT_IDE: "0", CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1" },
  );
  if (found) return found as CliModels;
  const out = await collect(cmd, ["--version"], WAIT_MS);
  const models = claudeFallback(out && out.code === 0 ? out.stdout : null);
  return models.length ? { models } : { models, note: RETRY_NOTE };
}

// ---- Codex ----

/** One `model/list` page. A row without an id is skipped (it used to void the whole page). */
export function parseCodexAppModels(response: unknown): CliModels | null {
  const rows = obj(response).data;
  if (!Array.isArray(rows)) return null;
  const models: CliModel[] = [];
  let defaultModel: string | undefined;
  for (const raw of rows.slice(0, 1001)) {
    const row = obj(raw);
    if (row.hidden === true) continue;
    const id = str(row.model) ?? str(row.id);
    if (!id || !isValidCliModel(id)) continue;
    const efforts = effortLevels(Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts.map((e) => obj(e).reasoningEffort) : [], "codex");
    const def = str(row.defaultReasoningEffort);
    const rowId = str(row.id);
    if (row.isDefault === true) {
      if (defaultModel !== undefined && defaultModel !== id) return null;
      defaultModel = id;
    }
    models.push(
      model({
        id,
        name: str(row.displayName)?.trim() || id,
        description: str(row.description),
        aliases: rowId && rowId !== id && isValidCliModel(rowId) ? [rowId] : [],
        reasoningEfforts: efforts,
        defaultReasoningEffort: def && efforts.includes(def) ? def : undefined,
      }),
    );
  }
  const out: CliModels = { models };
  if (defaultModel) out.defaultModel = defaultModel;
  return out;
}

/** `codex debug models`: the models Codex's own picker lists, in its order. */
export function parseCodexDebug(json: string): CliModel[] | null {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  const list = obj(v).models;
  if (!Array.isArray(list)) return null;
  const listed: [number, CliModel][] = [];
  for (const raw of list) {
    const m = obj(raw);
    if (m.visibility !== "list") continue;
    const id = str(m.slug);
    if (!id || !isValidCliModel(id)) continue;
    const efforts = effortLevels(Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((e) => obj(e).effort) : [], "codex");
    const def = str(m.default_reasoning_level);
    listed.push([
      typeof m.priority === "number" && Number.isInteger(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER,
      model({
        id,
        name: str(m.display_name)?.trim() ? (m.display_name as string) : id,
        description: str(m.description)?.trim() || undefined,
        aliases: Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => isValidCliModel(a)) : [],
        reasoningEfforts: efforts,
        defaultReasoningEffort: def && efforts.includes(def) ? def : undefined,
      }),
    ]);
  }
  return listed.sort((a, b) => a[0] - b[0]).map(([, m]) => m);
}

async function codexCatalog(bin: string, dir: string | null): Promise<CliModels | null> {
  const cmd = cliCommand("codex", bin, os.tmpdir(), dir);
  let gc;
  try {
    gc = await spawnInGroup(cmd.file, [...cmd.args, "app-server"], { cwd: cmd.cwd, env: cmd.env });
  } catch {
    return null;
  }
  gc.child.stderr?.resume();
  const peer = new JsonRpcPeer(gc.stdin!, gc.stdout, { maxLine: 2 * 1024 * 1024 });
  const work = (async (): Promise<CliModels | null> => {
    const init = await peer.request("initialize", { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: true } });
    if (init === undefined) return null;
    peer.notify("initialized", {});
    const result: CliModels = { models: [] };
    const cursors: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 32; page++) {
      const payload = await peer.request("model/list", { limit: 100, includeHidden: false, cursor });
      const pageModels = parseCodexAppModels(payload);
      if (!pageModels) return null;
      if (pageModels.defaultModel) {
        if (result.defaultModel && result.defaultModel !== pageModels.defaultModel) return null;
        result.defaultModel = pageModels.defaultModel;
      }
      for (const m of pageModels.models) {
        if (!result.models.some((k) => k.id === m.id)) result.models.push(m);
        if (result.models.length > 1000) return null;
      }
      const next = str(obj(payload).nextCursor);
      if (!next) return result.models.length ? result : null;
      if (cursors.includes(next)) return null;
      cursors.push(next);
      cursor = next;
    }
    return null;
  })().catch(() => null);
  const found = await Promise.race([work, sleep(WAIT_MS).then(() => null)]);
  peer.close();
  await stopGroup(gc, undefined, 200);
  return found;
}

async function codexModels(bin: string, dir: string | null): Promise<CliModels> {
  const catalog = await codexCatalog(bin, dir);
  if (catalog) return catalog;
  const out = await collect(cliCommand("codex", bin, os.tmpdir(), dir), ["debug", "models"], WAIT_MS);
  const listed = out && out.code === 0 ? parseCodexDebug(out.stdout) : null;
  return listed?.length ? { models: listed } : { models: [], note: RETRY_NOTE };
}

// ---- Gemini CLI ----

/** "flash-lite" → "Flash-Lite". */
function capitalized(id: string): string {
  return id
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join("-");
}

/** The aliases in Gemini CLI's bundled source (`var GEMINI_MODEL_ALIAS_PRO = "pro";`). */
export function geminiAliases(dir: string): CliModel[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: CliModel[] = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (path.extname(e.name) !== ".js") continue;
    try {
      if (fs.statSync(p).size > 64 * 1024 * 1024) continue;
    } catch {
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(p, "utf8");
    } catch {
      continue;
    }
    let at = text.indexOf("var GEMINI_MODEL_ALIAS_");
    while (at >= 0) {
      const line = text.slice(at).split(/\r?\n/, 1)[0];
      const value = line.split('"')[1];
      if (value !== undefined && isValidCliModel(value) && !out.some((m) => m.id === value)) out.push({ id: value, name: capitalized(value) });
      at = text.indexOf("var GEMINI_MODEL_ALIAS_", at + 1);
    }
    if (out.length) break;
  }
  return out;
}

function geminiModels(bin: string): CliModels {
  let models: CliModel[] = [];
  try {
    models = geminiAliases(path.dirname(fs.realpathSync.native(bin)));
  } catch {
    models = [];
  }
  return models.length ? { models } : { models, note: RETRY_NOTE };
}
