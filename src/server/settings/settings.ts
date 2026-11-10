// STUB: owned by storage worker. Minimal stand-in so the CLI worker's code and
// tests run before the storage branch is merged; the integrator keeps the
// storage worker's real file.
import fs from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";

export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";

export type VaultSettings = {
  backend: Backend;
  isolateClaudeConfig: boolean;
  /** Raw JSON, expected `Instance[]` (cli/instances.ts validates it). */
  agentInstances?: unknown;
  /** Raw JSON, expected `{ [cli]: instanceId }`. */
  activeAgentInstances?: unknown;
  [key: string]: unknown;
};

function file(): string {
  return path.join(vaultStateDir(), "settings.json");
}

function raw(): Record<string, unknown> {
  try {
    const value = JSON.parse(fs.readFileSync(file(), "utf8").replaceAll('"--st-', '"--ph-'));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function readSettings(): VaultSettings {
  const r = raw();
  const backend = r.backend === "steward" ? "phaethon" : r.backend;
  return {
    ...r,
    backend: backend === "claude-cli" || backend === "codex-cli" || backend === "gemini-cli" ? backend : "phaethon",
    isolateClaudeConfig: r.isolateClaudeConfig === true,
  };
}

export function updateSettings(patch: Partial<VaultSettings>): VaultSettings {
  let current: Record<string, unknown> = {};
  if (fs.existsSync(file())) {
    const value = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("settings.json is not a JSON object; fix or remove it first");
    current = value;
  }
  writeJsonAtomic(file(), { ...current, ...patch });
  return readSettings();
}
