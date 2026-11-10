// STUB: owned by storage
import fs from "node:fs";
import path from "node:path";
import { spaceDir, spacesRoot, isValidSpaceId } from "../core/vault.ts";
import { writeJsonAtomic } from "../core/fsx.ts";

export type SpaceMeta = {
  name?: string;
  model?: string;
  tutorMode?: string;
  educationEnabled?: boolean;
  cliModels?: Record<string, string>;
  cliReasoning?: Record<string, string>;
  [key: string]: unknown;
};

const file = (id: string) => path.join(spaceDir(id), ".phaethon", "space.json");

export function readSpaceMeta(id: string): SpaceMeta {
  try {
    const v = JSON.parse(fs.readFileSync(file(id), "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Keys set to `undefined` are removed; every other key is kept. */
export function updateSpaceMeta(id: string, patch: Partial<SpaceMeta>): SpaceMeta {
  const meta = readSpaceMeta(id);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete meta[k];
    else meta[k] = v;
  }
  writeJsonAtomic(file(id), meta);
  return meta;
}

export function touchSpace(_id: string): void {}

export function listSpaces(): { id: string; name: string }[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(spacesRoot());
  } catch {
    return [];
  }
  return names.filter(isValidSpaceId).sort().map((id) => ({ id, name: id }));
}
