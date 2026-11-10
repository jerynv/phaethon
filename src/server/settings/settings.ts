// STUB: owned by storage worker
import fs from "node:fs";
import path from "node:path";
import { vaultRoot } from "../core/vault.ts";

export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";

export type VaultSettings = {
  isolateClaudeConfig: boolean;
  backend: Backend;
  agentInstances?: unknown;
  activeAgentInstances?: unknown;
  model?: string | null;
  effort?: string | null;
  provider?: string | null;
  providerModels?: unknown;
  providerUrls?: unknown;
  appearance?: unknown;
  [key: string]: unknown;
};

/** `<vault>/.phaethon/settings.json` with defaults (tolerant stub). */
export function readSettings(): VaultSettings {
  const out: VaultSettings = { isolateClaudeConfig: false, backend: "phaethon" };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(vaultRoot(), ".phaethon", "settings.json"), "utf8"));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  Object.assign(out, o);
  out.isolateClaudeConfig = o.isolateClaudeConfig === true;
  out.backend = o.backend === "steward" ? "phaethon" : (["phaethon", "claude-cli", "codex-cli", "gemini-cli"] as const).find((b) => b === o.backend) ?? "phaethon";
  return out;
}

export function updateSettings(patch: Partial<VaultSettings>): VaultSettings {
  const file = path.join(vaultRoot(), ".phaethon", "settings.json");
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    obj = {};
  }
  Object.assign(obj, patch);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(obj, null, 2));
  fs.renameSync(file + ".tmp", file);
  return readSettings();
}
