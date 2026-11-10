import fs from "node:fs";
import path from "node:path";
import { Refusal, messageOf } from "../rpc/registry.ts";
import { isNotFound, lstatOrNull, prettyJson } from "../core/fsx.ts";
import { isValidSpaceId, spaceDir, spacesRoot } from "../core/vault.ts";
import { visibleCourses } from "../lms/access.ts";

/**
 * The spaces in a vault, as the sidebar and Settings show them. A space is a
 * valid folder under `<vault>/spaces/`; its display name, description and
 * colour (and per-space model and tutor settings) live in
 * `<space>/.phaethon/space.json`. The file is user-editable and may sync, so
 * every field is checked on the way in and a bad one is replaced by its
 * default without failing the space. Unknown fields are kept on every write.
 * When a space was last used is kept apart, in `<space>/.phaethon/last-used`.
 */

export const NAME_MAX = 60;
export const DESCRIPTION_MAX = 160;
const META_MAX_BYTES = 64 * 1024;
const SLUG_MAX = 48;

export type SpaceView = {
  id: string;
  name: string;
  description: string;
  hue: number;
  educationEnabled: boolean;
  lastUsed: number | null;
};

export type TutorMode = "quiz" | "explain" | "socratic" | "cram";
export const TUTOR_MODES: readonly TutorMode[] = ["quiz", "explain", "socratic", "cram"];

/** space.json as other modules read it: each field validated, `raw` as saved (null when absent or unreadable). */
export type SpaceMeta = {
  name: string;
  description: string;
  hue: number;
  /** The saved flag, or undefined when the file has none (legacy detection then decides). */
  educationEnabled: boolean | undefined;
  /** The saved model reference, unparsed (providers validate it). */
  model: string | undefined;
  /** cli id → model, only entries that pass `isValidCliModel`. */
  cliModels: Record<string, string>;
  /** As saved; the reasoning module validates it strictly. */
  cliReasoning: unknown;
  tutorMode: TutorMode | undefined;
  raw: Record<string, unknown> | null;
};

// ---- Small checks --------------------------------------------------------------

const WS = /^\p{White_Space}+|\p{White_Space}+$/gu;
/** Rust's `str::trim` (Unicode White_Space only). */
export function trimWs(s: string): string {
  return s.replace(WS, "");
}

function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

const CONTROL = /\p{Cc}/u;

export function checkName(name: string): string {
  const n = trimWs(name);
  if (!n) throw new Refusal("A space needs a name.");
  if (charCount(n) > NAME_MAX) throw new Refusal(`A space’s name can be at most ${NAME_MAX} characters.`);
  if (CONTROL.test(n)) throw new Refusal("A space’s name can’t contain line breaks or tabs.");
  return n;
}

export function checkDescription(d: string): string {
  const t = trimWs(d);
  if (charCount(t) > DESCRIPTION_MAX) throw new Refusal(`A description can be at most ${DESCRIPTION_MAX} characters.`);
  if (CONTROL.test(t)) throw new Refusal("A description can’t contain line breaks or tabs.");
  return t;
}

export function checkHue(h: number): number {
  if (typeof h !== "number" || !Number.isFinite(h) || h < 0 || h > 360) throw new Refusal("A colour must be a hue from 0 to 360.");
  return Math.round(h);
}

function attempt<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** "side-project_2" shows as "Side project 2". */
export function defaultName(id: string): string {
  const spaced = id.replace(/[-_]/g, " ");
  const [first, ...rest] = [...spaced];
  return first === undefined ? "" : first.toUpperCase() + rest.join("");
}

/** School and Work get the Sky and Clay presets; any other id a stable hue from FNV-1a stepped by the golden angle. */
export function defaultHue(id: string): number {
  if (id === "school") return 240;
  if (id === "work") return 50;
  let h = 0x811c9dc5;
  for (const b of Buffer.from(id, "utf8")) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return Math.round(((h % 1000) * 137.507764) % 360) % 360;
}

/** A folder name from a display name: ASCII letters and digits, other runs as one dash, at most 48, "space" if empty. */
export function slug(name: string): string {
  let out = "";
  outer: for (const ch of name) {
    for (const c of ch.toLowerCase()) {
      if (/^[a-z0-9]$/.test(c)) out += c;
      else if (out && !out.endsWith("-")) out += "-";
      if (out.length >= SLUG_MAX) break outer;
    }
  }
  out = out.replace(/-+$/, "");
  return out || "space";
}

/** `agent::is_valid_cli_model`: a compat model name of at most 100 bytes. */
export function isValidCliModel(m: string): boolean {
  const bytes = Buffer.byteLength(m);
  return (
    bytes > 0 &&
    bytes <= 100 &&
    !/^[-./:]/.test(m) &&
    !m.includes("..") &&
    /^[A-Za-z0-9\-_.:/@+]+$/.test(m)
  );
}

// ---- space.json ----------------------------------------------------------------

export function metaFile(dir: string): string {
  return path.join(dir, ".phaethon", "space.json");
}

/**
 * space.json as JSON, null when it does not exist. Refuses a `.phaethon` or
 * space.json that is a symlink, anything not a plain file, and anything too large.
 */
export function readMetaRaw(dir: string): unknown {
  const state = lstatOrNull(path.join(dir, ".phaethon"));
  if (!state) return null;
  if (!state.isDirectory()) throw new Error(".phaethon is not a folder");
  const file = metaFile(dir);
  const m = lstatOrNull(file);
  if (!m) return null;
  if (!m.isFile() || m.size > META_MAX_BYTES) throw new Error("space.json is not a small plain file");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** `<space>/.phaethon`, created if missing; refused when it is anything but a real folder. */
function stateDirForWrite(dir: string): string {
  const state = path.join(dir, ".phaethon");
  const st = lstatOrNull(state);
  if (st && !st.isDirectory()) throw new Error(".phaethon in this space is not a folder");
  fs.mkdirSync(state, { recursive: true });
  return state;
}

export function writeMeta(dir: string, meta: Record<string, unknown>): void {
  const state = stateDirForWrite(dir);
  const file = metaFile(dir);
  const st = lstatOrNull(file);
  if (st && !st.isFile()) throw new Error("space.json in this space is not a plain file");
  const tmp = path.join(state, "space.json.tmp");
  fs.writeFileSync(tmp, prettyJson(meta) + "\n");
  fs.renameSync(tmp, file);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function existsFollowing(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The map for a read-modify-write: the saved object, `{}` when there is none,
 * and a refusal (`This space’s settings file can’t be read, so {what}. Fix or
 * delete {path}.`) when a file is there but can't be read as an object.
 */
export function loadMetaForChange(dir: string, what: string): Record<string, unknown> {
  let read: unknown;
  let failed = false;
  try {
    read = readMetaRaw(dir);
  } catch {
    failed = true;
  }
  if (!failed && read === null) return {};
  if (!failed && isObject(read)) return read;
  if (existsFollowing(metaFile(dir))) {
    throw new Refusal(`This space’s settings file can’t be read, so ${what}. Fix or delete ${metaFile(dir)}.`);
  }
  return {};
}

function rawMeta(dir: string): { meta: Record<string, unknown> | null; canMigrate: boolean } {
  try {
    const v = readMetaRaw(dir);
    if (v === null) return { meta: null, canMigrate: true };
    if (isObject(v)) return { meta: v, canMigrate: true };
    return { meta: null, canMigrate: false };
  } catch {
    return { meta: null, canMigrate: false };
  }
}

/** Every validated field of space `id`'s space.json. */
export function readSpaceMeta(id: string): SpaceMeta {
  return metaOf(id, spaceDir(id));
}

function metaOf(id: string, dir: string): SpaceMeta {
  const { meta } = rawMeta(dir);
  const field = (k: string) => (meta ? meta[k] : undefined);
  const name = field("name");
  const description = field("description");
  const hue = field("hue");
  const cliModels: Record<string, string> = {};
  const savedCli = field("cliModels");
  if (isObject(savedCli)) {
    for (const [cli, m] of Object.entries(savedCli)) {
      if (typeof m === "string" && isValidCliModel(trimWs(m))) cliModels[cli] = trimWs(m);
    }
  }
  const tutor = field("tutorMode");
  return {
    name: (typeof name === "string" ? attempt(() => checkName(name)) : undefined) ?? defaultName(id),
    description: (typeof description === "string" ? attempt(() => checkDescription(description)) : undefined) ?? "",
    hue: (typeof hue === "number" ? attempt(() => checkHue(hue)) : undefined) ?? defaultHue(id),
    educationEnabled: typeof field("educationEnabled") === "boolean" ? (field("educationEnabled") as boolean) : undefined,
    model: typeof field("model") === "string" ? (field("model") as string) : undefined,
    cliModels,
    cliReasoning: field("cliReasoning"),
    tutorMode: typeof tutor === "string" && (TUTOR_MODES as readonly string[]).includes(tutor) ? (tutor as TutorMode) : undefined,
    raw: meta,
  };
}

export type MetaPatch = Record<string, unknown> | ((meta: Record<string, unknown>) => void);

/**
 * Changes space.json, keeping every other field. In an object patch a value of
 * `null` removes the key and `undefined` leaves it alone. `unreadable` finishes
 * the refusal sentence for a file that can't be read ("so the model wasn’t
 * changed"); `failed` prefixes a write error.
 */
export function updateSpaceMeta(id: string, patch: MetaPatch, opts: { unreadable?: string; failed?: string } = {}): SpaceMeta {
  const dir = spaceDir(id);
  const meta = loadMetaForChange(dir, opts.unreadable ?? "it wasn’t changed");
  if (typeof patch === "function") patch(meta);
  else {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (v === null) delete meta[k];
      else meta[k] = v;
    }
  }
  try {
    writeMeta(dir, meta);
  } catch (e) {
    throw new Refusal(`${opts.failed ?? "The change couldn’t be saved"}: ${messageOf(e)}`);
  }
  return metaOf(id, dir);
}

// ---- last-used -----------------------------------------------------------------

function usedFile(dir: string): string {
  return path.join(dir, ".phaethon", "last-used");
}

export function touchAt(dir: string, ms: number): void {
  const state = stateDirForWrite(dir);
  const file = usedFile(dir);
  const st = lstatOrNull(file);
  if (st && !st.isFile()) throw new Error("last-used in this space is not a plain file");
  const tmp = path.join(state, "last-used.tmp");
  fs.writeFileSync(tmp, `${ms}\n`);
  fs.renameSync(tmp, file);
}

/** The saved last use, null unless it is a small plain file holding a whole number; a future time counts as now. */
export function readLastUsed(dir: string): number | null {
  try {
    if (!lstatOrNull(path.join(dir, ".phaethon"))?.isDirectory()) return null;
    const file = usedFile(dir);
    const m = lstatOrNull(file);
    if (!m || !m.isFile() || m.size > 64) return null;
    const text = trimWs(fs.readFileSync(file, "utf8"));
    if (!/^\d+$/.test(text) || text.length > 20) return null;
    const ms = Number(text);
    if (BigInt(text) > 18446744073709551615n) return null;
    return Math.min(ms, Date.now());
  } catch {
    return null;
  }
}

// ---- Education -----------------------------------------------------------------

function hasVisibleCourses(id: string): boolean {
  try {
    const v = visibleCourses(id) as unknown;
    if (Array.isArray(v)) return v.length > 0;
    if (v instanceof Map || v instanceof Set) return v.size > 0;
    if (isObject(v)) {
      const c = v.courses;
      if (Array.isArray(c)) return c.length > 0;
      if (c instanceof Map || c instanceof Set) return c.size > 0;
      if (isObject(c)) return Object.keys(c).length > 0;
    }
    return false;
  } catch {
    return false;
  }
}

/** Study work or a visible course from before the education switch existed. */
function legacyEducation(id: string, dir: string): boolean {
  if (hasVisibleCourses(id)) return true;
  for (const folder of ["study/decks", "study/quizzes", ".phaethon/study/attempts"]) {
    const p = path.join(dir, folder);
    try {
      if (!lstatOrNull(p)?.isDirectory()) continue;
      for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
        const ext = path.extname(entry.name);
        if (entry.isFile() && (ext === ".md" || ext === ".json")) return true;
      }
    } catch {
      // Unreadable: no evidence.
    }
  }
  for (const file of ["study/exams.json", "study/plan.md"]) {
    try {
      const m = lstatOrNull(path.join(dir, file));
      if (m?.isFile() && m.size > 2) return true;
    } catch {
      // Unreadable: no evidence.
    }
  }
  return false;
}

// ---- Views ---------------------------------------------------------------------

/**
 * The space as shown. Reading never writes: a space.json without
 * `educationEnabled` shows what legacy detection finds, and the answer is
 * saved only when the space is used (`touchSpace`). The Rust core wrote
 * space.json for every such space on every list, which churned synced vaults.
 */
function view(id: string, dir: string): SpaceView {
  const meta = metaOf(id, dir);
  return {
    id,
    name: meta.name,
    description: meta.description,
    hue: meta.hue,
    educationEnabled: meta.educationEnabled ?? legacyEducation(id, dir),
    lastUsed: readLastUsed(dir),
  };
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** Every valid space, most recently used first; never-used ones follow by name, then id. */
export function listSpaces(): SpaceView[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(spacesRoot(), { withFileTypes: true });
  } catch (e) {
    if (isNotFound(e)) return [];
    throw new Refusal(`The spaces folder couldn’t be read: ${messageOf(e)}`);
  }
  const out: SpaceView[] = [];
  for (const entry of entries) {
    // Symlinks are never listed (Dirent types don't follow links).
    if (!entry.isDirectory() || !isValidSpaceId(entry.name)) continue;
    let dir: string;
    try {
      dir = spaceDir(entry.name);
    } catch {
      continue;
    }
    out.push(view(entry.name, dir));
  }
  out.sort(
    (a, b) =>
      (b.lastUsed ?? -1) - (a.lastUsed ?? -1) ||
      compareBytes(a.name.toLowerCase(), b.name.toLowerCase()) ||
      compareBytes(a.id, b.id),
  );
  return out;
}

export function getSpace(id: string): SpaceView {
  return view(id, spaceDir(id));
}

/** Marks `id` used now (the core's clock), and freezes legacy education detection into space.json once. */
export function touchSpace(id: string): void {
  const dir = spaceDir(id);
  try {
    touchAt(dir, Date.now());
  } catch (e) {
    throw new Refusal(`This space’s last use couldn’t be saved: ${messageOf(e)}`);
  }
  const { meta, canMigrate } = rawMeta(dir);
  if (canMigrate && typeof meta?.educationEnabled !== "boolean") {
    try {
      writeMeta(dir, { ...(meta ?? {}), educationEnabled: legacyEducation(id, dir) });
    } catch {
      // Detection runs again next time.
    }
  }
}

export function createSpace(name: string, description?: string | null, hue?: number | null, educationEnabled = false): SpaceView {
  const n = checkName(name);
  const d = description == null ? undefined : checkDescription(description);
  const h = hue == null ? undefined : checkHue(hue);
  const root = spacesRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (e) {
    throw new Refusal(`The spaces folder couldn’t be created: ${messageOf(e)}`);
  }
  const base = slug(n);
  let id: string | undefined;
  for (let i = 1; i <= 999; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    try {
      // Not recursive: anything already there (a folder, a file, a link) counts as taken.
      fs.mkdirSync(path.join(root, candidate));
      id = candidate;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Refusal(`The space’s folder couldn’t be created: ${messageOf(e)}`);
    }
  }
  if (!id) throw new Refusal("Too many spaces already have that name. Choose a different one.");
  const dir = spaceDir(id);
  const meta: Record<string, unknown> = { name: n };
  if (d) meta.description = d;
  meta.hue = h ?? defaultHue(id);
  meta.educationEnabled = educationEnabled;
  try {
    writeMeta(dir, meta);
  } catch (e) {
    throw new Refusal(`The space was created, but its name couldn’t be saved: ${messageOf(e)}`);
  }
  return view(id, dir);
}

export function updateSpace(
  id: string,
  fields: { name?: string | null; description?: string | null; hue?: number | null; educationEnabled?: boolean | null },
): SpaceView {
  const dir = spaceDir(id);
  const name = fields.name == null ? undefined : checkName(fields.name);
  const description = fields.description == null ? undefined : checkDescription(fields.description);
  const hue = fields.hue == null ? undefined : checkHue(fields.hue);
  const meta = loadMetaForChange(dir, "it wasn’t changed");
  if (name !== undefined) meta.name = name;
  if (description !== undefined) meta.description = description;
  if (hue !== undefined) meta.hue = hue;
  if (typeof fields.educationEnabled === "boolean") meta.educationEnabled = fields.educationEnabled;
  try {
    writeMeta(dir, meta);
  } catch (e) {
    throw new Refusal(`The change couldn’t be saved: ${messageOf(e)}`);
  }
  return view(id, dir);
}
