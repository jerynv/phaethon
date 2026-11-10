import path from "node:path";
import { Refusal } from "../rpc/registry.ts";
import { components, isWithin, lstatOrNull, realpath } from "./fsx.ts";

/**
 * Turning a model- or user-supplied relative path into a real path inside a
 * space. These strings are model-facing and other code matches on them, so
 * keep them exact.
 */

const STATE = ".phaethon";

function isStateName(part: string | undefined): boolean {
  return part !== undefined && part.toLowerCase() === STATE;
}

/** The lexical check: relative, no `..`, not into `.phaethon`. Returns the components ("" = the space root). */
export function cleanRel(rel: string): string[] {
  const outside = `"${rel}" must be a path inside this space, like "notes/today.md"`;
  if (path.isAbsolute(rel) || (process.platform === "win32" && /^[a-zA-Z]:/.test(rel))) throw new Refusal(outside);
  const parts = components(rel).filter((c) => c !== ".");
  if (parts.some((c) => c === "..")) throw new Refusal(outside);
  if (isStateName(parts[0])) throw new Refusal(`"${rel}" is Phaethon's own state and cannot be used by tools`);
  return parts;
}

/**
 * The filesystem check. `root` is a space folder; with `mustExist` false (writes)
 * the deepest existing ancestor is canonicalized and checked, so a symlinked
 * folder can't redirect a new file outside.
 */
export function resolveIn(root: string, rel: string, mustExist: boolean): string {
  let realRoot: string;
  try {
    realRoot = realpath(root);
  } catch (e) {
    throw new Refusal(`space folder unavailable: ${(e as Error).message}`);
  }
  const clean = cleanRel(rel);
  const full = path.join(realRoot, ...clean);
  let existing = full;
  for (;;) {
    let st;
    try {
      st = lstatOrNull(existing);
    } catch (e) {
      throw new Refusal(`cannot open "${rel}": ${(e as Error).message}`);
    }
    if (st) break;
    if (mustExist) throw new Refusal(`"${rel}" does not exist`);
    if (existing === realRoot) break;
    existing = path.dirname(existing);
  }
  let real: string;
  try {
    real = realpath(existing);
  } catch (e) {
    throw new Refusal(`cannot open "${rel}": ${(e as Error).message}`);
  }
  if (!isWithin(real, realRoot)) throw new Refusal(`"${rel}" leads outside this space`);
  const inside = path.relative(realRoot, real);
  let stateReal: string | undefined;
  try {
    stateReal = realpath(path.join(realRoot, STATE));
  } catch {
    stateReal = undefined;
  }
  if (isStateName(components(inside)[0]) || (stateReal && isWithin(real, stateReal))) {
    throw new Refusal(`"${rel}" is Phaethon's own state and cannot be used by tools`);
  }
  const rest = path.relative(existing, full);
  return rest ? path.join(real, rest) : real;
}

/** The same check for another space, with that space named in the message. */
export function resolveInOther(root: string, spaceName: string, rel: string, mustExist: boolean): string {
  try {
    return resolveIn(root, rel, mustExist);
  } catch (e) {
    throw new Refusal((e as Error).message.replace("this space", `the ${spaceName} space`));
  }
}
