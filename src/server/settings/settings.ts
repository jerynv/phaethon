// STUB: owned by storage
import fs from "node:fs";
import path from "node:path";
import { vaultStateDir } from "../core/vault.ts";
import { writeJsonAtomic } from "../core/fsx.ts";

/** `<vault>/.phaethon/settings.json`, tolerant: one bad field never resets the others. */
export type Backend = "phaethon" | "claude-cli" | "codex-cli" | "gemini-cli";
export type VaultSettings = {
  backend: Backend;
  model: string | null;
  effort: string | null;
  provider: string | null;
  providerModels: Record<string, string>;
  providerUrls: Record<string, string>;
  isolateClaudeConfig: boolean;
  appearance?: unknown;
  [key: string]: unknown;
};

const file = () => path.join(vaultStateDir(), "settings.json");

function raw(): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8").replaceAll('"--st-', '"--ph-'));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const map = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, s] of Object.entries(v)) if (typeof s === "string") out[k] = s;
  return out;
};

export function readSettings(): VaultSettings {
  const r = raw();
  const b = r.backend === "steward" ? "phaethon" : r.backend;
  return {
    ...r,
    backend: b === "claude-cli" || b === "codex-cli" || b === "gemini-cli" ? b : "phaethon",
    model: str(r.model),
    effort: str(r.effort),
    provider: str(r.provider),
    providerModels: map(r.providerModels),
    providerUrls: map(r.providerUrls),
    isolateClaudeConfig: r.isolateClaudeConfig === true,
  };
}

export function updateSettings(patch: Partial<VaultSettings>): VaultSettings {
  const r = raw();
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete r[k];
    else r[k] = v;
  }
  writeJsonAtomic(file(), r);
  return readSettings();
}
