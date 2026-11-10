import fs from "node:fs";
import path from "node:path";
import { spacesRoot, vaultRoot } from "../core/vault.ts";
import { PARTS, visibleFor, type Part, type Visible } from "./visible.ts";
import type { Model } from "./model.ts";
import type { Picture } from "./types.ts";

/**
 * Test helpers (not used in production): a vault with imported courses and
 * the parts one space may see, like Rust's `lms::access::fixture`.
 */

export const ALL: readonly Part[] = PARTS;

/** Writes `<vault>/<rel>` (creating folders). */
export function put(rel: string, text: string | Uint8Array, root = vaultRoot()): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}

/** Courses on connection "canvas-x" with ids "1", "2"… (name = folder), visible to `space` with the parts given. */
export function fixture(space: string, courses: [folder: string, parts: readonly Part[]][], extra: Record<string, Record<string, unknown>> = {}): Visible {
  const root = vaultRoot();
  fs.mkdirSync(path.join(spacesRoot(), space), { recursive: true });
  const conn: Record<string, unknown> = {};
  courses.forEach(([folder], i) => {
    conn[String(i + 1)] = { name: folder, folder, ...(extra[folder] ?? {}) };
  });
  fs.mkdirSync(path.join(root, ".phaethon"), { recursive: true });
  fs.writeFileSync(path.join(root, ".phaethon", "lms.json"), JSON.stringify({ connections: [{ id: "canvas-x", kind: "canvas", courses: conn }] }, null, 2));
  const file = path.join(root, ".phaethon", "course-access.json");
  let access: Record<string, Record<string, string[]>> = {};
  try {
    access = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    access = {};
  }
  const mine: Record<string, string[]> = {};
  courses.forEach(([, parts], i) => {
    if (parts.length) mine[`canvas-x/${i + 1}`] = PARTS.filter((p) => parts.includes(p));
  });
  access[space] = mine;
  fs.writeFileSync(file, JSON.stringify(access, null, 2));
  return visibleFor(space);
}

// ---- A scripted model -------------------------------------------------------------

/**
 * A model that answers each call with the next scripted reply (a string, or
 * `{ fail }` to reject with that message) and keeps what it was asked.
 */
export type ScriptedReply = string | { fail: string };

export class Scripted implements Model {
  readonly asked: { system: string; user: string; pictures: Picture[] }[] = [];
  /** Whether it claims to look at pictures. */
  seeing = false;
  private readonly replies: ScriptedReply[];

  constructor(replies: ScriptedReply[] = []) {
    this.replies = [...replies];
  }

  static failing(message: string): Scripted {
    return new Scripted([{ fail: message }]);
  }

  calls(): number {
    return this.asked.length;
  }

  /** Adds replies after construction. */
  push(...replies: ScriptedReply[]): this {
    this.replies.push(...replies);
    return this;
  }

  async complete(system: string, user: string): Promise<string> {
    return this.answer(system, user, []);
  }

  showsPictures(): boolean {
    return this.seeing;
  }

  async completeSeeing(system: string, user: string, pictures: Picture[]): Promise<string> {
    return this.answer(system, user, this.seeing ? pictures : []);
  }

  private answer(system: string, user: string, pictures: Picture[]): string {
    this.asked.push({ system, user, pictures });
    const next = this.replies.shift();
    if (next === undefined) throw "no more scripted replies";
    if (typeof next !== "string") throw next.fail;
    return next;
  }
}
