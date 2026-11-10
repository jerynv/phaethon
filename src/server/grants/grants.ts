// STUB: owned by storage
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Refusal } from "../rpc/registry.ts";
import { cleanRel, resolveInOther } from "../core/resolve.ts";
import { spaceDir, vaultStateDir } from "../core/vault.ts";
import { writeJsonAtomic } from "../core/fsx.ts";

export type Grant = { id: string; to: string; from: string; path: string; created: string; scope: "always" };

const file = () => path.join(vaultStateDir(), "grants.json");

function readAll(): Grant[] {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8"));
    return Array.isArray(v?.grants) ? v.grants : [];
  } catch {
    return [];
  }
}

/** Saved "always" grants into `space`, sorted by (from, path). */
export function grantsFor(space: string): Grant[] {
  return readAll()
    .filter((g) => g && g.to === space && typeof g.from === "string" && typeof g.path === "string" && g.path)
    .sort((a, b) => (a.from === b.from ? (a.path < b.path ? -1 : 1) : a.from < b.from ? -1 : 1));
}

/** Whole-component prefix: `calendar` covers `calendar/oct.md`, never `calendar-old`; an empty path is never covered. */
export function covers(grantPath: string, rel: string): boolean {
  if (!grantPath || !rel) return false;
  const g = grantPath.split("/").filter(Boolean);
  const r = rel.split("/").filter(Boolean);
  return g.length > 0 && g.length <= r.length && g.every((p, i) => p === r[i]);
}

export function normalizeGrantPath(p: string): string {
  const parts = cleanRel(p);
  if (!parts.length) throw new Refusal("it names a whole space, and a grant has to name a folder or file");
  return parts.join("/");
}

/** Validates an access request; returns the normalized path. Messages go inside "Not asked: …". */
export function checkRequest(thisSpace: string, other: string, p: string): string {
  if (other === thisSpace) throw new Refusal(`${other} is this space; read it directly without asking`);
  let dir: string;
  try {
    dir = spaceDir(other);
  } catch {
    throw new Refusal(`there is no space called "${other}"`);
  }
  const norm = normalizeGrantPath(p);
  resolveInOther(dir, other, norm, true);
  return norm;
}

export function addAlways(to: string, from: string, p: string): Grant {
  const norm = normalizeGrantPath(p);
  let doc: { grants: unknown[] } = { grants: [] };
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (Array.isArray(v?.grants)) doc = v;
  } catch {
    // start fresh
  }
  const existing = (doc.grants as Grant[]).find((g) => g?.to === to && g?.from === from && g?.path === norm);
  if (existing) return existing;
  const grant: Grant = { id: crypto.randomUUID(), to, from, path: norm, created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), scope: "always" };
  doc.grants.push(grant);
  writeJsonAtomic(file(), doc);
  return grant;
}

export function cliDirs(_space: string): { label: string; path: string }[] {
  return [];
}
