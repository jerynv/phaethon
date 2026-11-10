// STUB: owned by storage worker
import fs from "node:fs";
import path from "node:path";
import { spaceDir } from "../core/vault.ts";

export type SpaceMeta = {
  model?: string | null;
  cliModels?: Record<string, string>;
  cliReasoning?: Record<string, unknown>;
  [key: string]: unknown;
};

/** `<space>/.phaethon/space.json` (tolerant stub). */
export function readSpaceMeta(id: string): SpaceMeta {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(spaceDir(id), ".phaethon", "space.json"), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as SpaceMeta) : {};
  } catch {
    return {};
  }
}
