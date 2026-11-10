import { execFile, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_IDENTIFIER, homeDir } from "../env.ts";
import { killGroup } from "../core/runs.ts";
import { resolveIn } from "../core/resolve.ts";
import { runPlan, sandboxRefusal, type Probe, type TexHome } from "./sandbox.ts";
import {
  KINDS,
  MAX_CACHED,
  MAX_PDF,
  MAX_RUNS,
  MAX_SOURCE,
  NO_TEX,
  cacheId,
  choose,
  figureDocument,
  isCacheId,
  isDocument,
  kindBin,
  kindName,
  logTail,
  needsRerun,
  parseError,
  slug,
  type Engine,
} from "./tex.ts";

// ---- Finding TeX ------------------------------------------------------------

function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    return st.isFile() && (process.platform === "win32" || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** The first executable `name` on PATH, then in `extra`. */
export function findOnPath(name: string, extra: string[]): string | undefined {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [...dirs, ...extra]) {
    const p = path.join(dir, exe);
    if (isExecutable(p)) return p;
  }
  return undefined;
}

/** Where TeX is installed but not on PATH for an app opened from Finder. */
export function texDirs(): string[] {
  const dirs = ["/Library/TeX/texbin"];
  try {
    const years = fs
      .readdirSync("/usr/local/texlive")
      .map((y) => path.join("/usr/local/texlive", y, "bin"))
      .filter((p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory())
      .sort()
      .reverse();
    for (const bin of years) {
      for (const platform of fs.readdirSync(bin)) {
        const p = path.join(bin, platform);
        if (fs.statSync(p, { throwIfNoEntry: false })?.isDirectory()) dirs.push(p);
      }
    }
  } catch {
    // No TeX Live there.
  }
  const home = homeDir();
  for (const d of [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin"]) dirs.push(path.join(home, d));
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".cargo/bin"), "/usr/bin");
  return dirs;
}

/** Every engine on this computer, in the order they are preferred. */
export function engines(): Engine[] {
  const extra = texDirs();
  const found: Engine[] = [];
  for (const kind of KINDS) {
    const p = findOnPath(kindBin(kind), extra);
    if (p) found.push({ kind, path: p });
  }
  return found;
}

// ---- The sandbox on this machine ---------------------------------------------

let bwrapMemo: string | null | undefined;

/** A bubblewrap that can actually make its namespaces here (user namespaces may be disabled), or null. */
export function workingBwrap(): string | null {
  if (bwrapMemo !== undefined) return bwrapMemo;
  bwrapMemo = null;
  if (process.platform !== "linux") return bwrapMemo;
  const candidate = ["/usr/bin/bwrap", "/bin/bwrap"].find(isExecutable) ?? findOnPath("bwrap", []);
  if (!candidate) return bwrapMemo;
  const probe = spawnSync(candidate, ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "true"], { stdio: "ignore", timeout: 10_000 });
  if (probe.status === 0) bwrapMemo = candidate;
  return bwrapMemo;
}

function probe(): Probe {
  return {
    real: (p) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return p;
      }
    },
    exists: (p) => fs.existsSync(p),
    isSymlink: (p) => {
      try {
        return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null;
      } catch {
        return null;
      }
    },
    userHome: homeDir(),
  };
}

const texHomes = new Map<string, TexHome>();

/** TeX's per-user trees, asked of kpsewhich once per TeX install with the real environment. */
async function texHome(engine: Engine): Promise<TexHome> {
  const dir = path.dirname(engine.path);
  const seen = texHomes.get(dir);
  if (seen) return seen;
  const home: TexHome = { vars: [] };
  if (engine.kind !== "tectonic") {
    for (const name of ["TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG"]) {
      const value = await new Promise<string | null>((resolve) => {
        execFile(path.join(dir, "kpsewhich"), [`-var-value=${name}`], { timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
      });
      // A plain absolute path only: anything else (a list, a variable) is left to TeX's default.
      if (value && value.startsWith("/") && !/[;:{$"\\]/.test(value)) home.vars.push([name, value]);
    }
  }
  texHomes.set(dir, home);
  return home;
}

// ---- Compiling ------------------------------------------------------------

/** Why a compile made no PDF. */
export type Failure =
  | { kind: "error"; message: string; line: number | null; log: string }
  | { kind: "timeout"; log: string }
  | { kind: "setup"; message: string };

class Fail extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind === "setup" ? failure.message : failure.kind);
  }
}

const setup = (message: string) => new Fail({ kind: "setup", message });

let workCounter = 0;

/** A private folder for one compile (mode 0700, canonical). */
function makeWorkDir(): string {
  const n = workCounter++;
  const nanos = Number(process.hrtime.bigint() % 1_000_000_000n);
  const dir = path.join(os.tmpdir(), `phaethon-latex-${process.pid}-${n}-${nanos}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  return fs.realpathSync.native(dir);
}

type Ran = "ok" | "failed" | "timedOut";

/** One run of `engine` on `doc.tex` in `work`, walled, until `deadline`. */
async function runOnce(engine: Engine, work: string, deadline: number, bwrap: string | null): Promise<Ran> {
  const home = await texHome(engine);
  const plan = runPlan(process.platform, engine, work, home, probe(), bwrap);
  if ("refused" in plan) throw setup(plan.refused);
  return new Promise<Ran>((resolve, reject) => {
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(plan.file, plan.args, { cwd: work, env: plan.env, stdio: "ignore", detached: true });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(setup(`LaTeX couldn’t be started: ${e.message}`));
    });
    child.once("spawn", () => {
      timer = setTimeout(
        () => {
          timedOut = true;
          if (child.pid) killGroup(child.pid, "SIGKILL");
        },
        Math.max(0, deadline - Date.now()),
      );
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // Anything the run left behind in its group goes too.
      if (child.pid) killGroup(child.pid, "SIGKILL");
      resolve(timedOut ? "timedOut" : code === 0 ? "ok" : "failed");
    });
  });
}

function readLog(work: string): string {
  try {
    return fs.readFileSync(path.join(work, "doc.log")).toString("utf8");
  } catch {
    return "";
  }
}

/** Compile `source` (a document, or with `figure` a figure's body) with `engine` inside the walls; the PDF's bytes. */
export async function compile(engine: Engine, source: string, figure: boolean, timeoutMs: number): Promise<Buffer> {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE) throw setup(`This document is longer than Phaethon compiles (${MAX_SOURCE / 1024} KB at most).`);
  // Checked before any folder or kpsewhich run: an OS without walls does no work at all.
  const bwrap = workingBwrap();
  const refusal = sandboxRefusal(process.platform, bwrap);
  if (refusal) throw setup(refusal);
  const { doc, before: offset } = figure && !isDocument(source) ? figureDocument(source) : { doc: source, before: 0 };
  let work: string;
  try {
    work = makeWorkDir();
  } catch (e) {
    throw setup(`Phaethon couldn’t make a folder to compile in: ${(e as Error).message}`);
  }
  try {
    try {
      fs.writeFileSync(path.join(work, "doc.tex"), doc);
    } catch (e) {
      throw setup(`Phaethon couldn’t write the document to compile: ${(e as Error).message}`);
    }
    const deadline = Date.now() + timeoutMs;
    const runs = engine.kind === "tectonic" ? 1 : MAX_RUNS;
    for (let run = 1; run <= runs; run++) {
      const ran = await runOnce(engine, work, deadline, bwrap);
      if (ran === "timedOut") throw new Fail({ kind: "timeout", log: logTail(readLog(work)) });
      if (ran === "failed") {
        const log = readLog(work);
        throw new Fail({ kind: "error", ...parseError(log, offset), log: logTail(log) });
      }
      if (run === runs || !needsRerun(readLog(work), source)) break;
    }
    const pdf = path.join(work, "doc.pdf");
    let size: number;
    try {
      size = fs.statSync(pdf).size;
    } catch {
      const log = readLog(work);
      throw new Fail({ kind: "error", ...parseError(log, offset), log: logTail(log) });
    }
    if (size > MAX_PDF) throw setup(`The PDF is larger than Phaethon shows (${MAX_PDF / 1024 / 1024} MB at most).`);
    try {
      return fs.readFileSync(pdf);
    } catch (e) {
      throw setup(`Phaethon couldn’t read the PDF: ${(e as Error).message}`);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** The failure a compile ended with, or null for a PDF. */
export async function tryCompile(engine: Engine, source: string, figure: boolean, timeoutMs: number): Promise<{ pdf: Buffer } | { failure: Failure }> {
  try {
    return { pdf: await compile(engine, source, figure, timeoutMs) };
  } catch (e) {
    if (e instanceof Fail) return { failure: e.failure };
    throw e;
  }
}

// ---- Cache ------------------------------------------------------------------

/** Tauri's app cache folder plus `latex`, where the Rust core kept its PDFs. */
export function cacheDir(): string {
  if (process.env.PHAETHON_CACHE_DIR) return path.join(process.env.PHAETHON_CACHE_DIR, "latex");
  // Tests point app data at a throwaway folder; the cache sits beside it.
  if (process.env.PHAETHON_APP_DATA) return path.join(path.dirname(process.env.PHAETHON_APP_DATA), "cache", "latex");
  const home = homeDir();
  let base: string;
  switch (process.platform) {
    case "darwin":
      base = path.join(home, "Library", "Caches");
      break;
    case "win32":
      base = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      break;
    default:
      base = process.env.XDG_CACHE_HOME || path.join(home, ".cache");
  }
  return path.join(base, APP_IDENTIFIER, "latex");
}

export function cachedPdf(cache: string, id: string): string | undefined {
  if (!isCacheId(id)) return undefined;
  const p = path.join(cache, `${id}.pdf`);
  return fs.statSync(p, { throwIfNoEntry: false })?.isFile() ? p : undefined;
}

export function cachePut(cache: string, id: string, pdf: Uint8Array): void {
  try {
    fs.mkdirSync(cache, { recursive: true });
  } catch {
    return;
  }
  const tmp = path.join(cache, `${id}.part`);
  try {
    fs.writeFileSync(tmp, pdf);
    fs.renameSync(tmp, path.join(cache, `${id}.pdf`));
  } catch {
    // Not kept; the caller notices.
  }
  try {
    const files = fs
      .readdirSync(cache)
      .filter((f) => f.endsWith(".pdf"))
      .map((f) => {
        const p = path.join(cache, f);
        return { p, t: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => a.t - b.t || (a.p < b.p ? -1 : 1));
    for (const { p } of files.slice(0, Math.max(0, files.length - MAX_CACHED))) fs.rmSync(p, { force: true });
  } catch {
    // Pruning is best effort.
  }
}

/** How a compile came out, for the renderer (tagged by `status`). */
export type Outcome =
  | { status: "ok"; id: string; engine: string }
  | { status: "failed"; message: string; line: number | null; log: string }
  | { status: "noEngine"; message: string }
  | { status: "unavailable"; message: string };

/** Compiles still failing from this session, so a message shown again doesn't recompile them. */
const failures = new Map<string, Outcome>();
/** One compile at a time: a conversation with many figures doesn't start many TeX runs at once. */
let turn: Promise<unknown> = Promise.resolve();

export function resetFailures(): void {
  failures.clear();
}

export async function compileCached(cache: string, found: readonly Engine[], source: string, figure: boolean, timeoutMs: number): Promise<Outcome> {
  const engine = choose(found, source);
  if (!engine) return { status: "noEngine", message: NO_TEX };
  const id = cacheId(engine.kind, figure, source);
  const ok: Outcome = { status: "ok", id, engine: kindName(engine.kind) };
  if (cachedPdf(cache, id)) return ok;
  const failed = failures.get(id);
  if (failed) return failed;
  const mine = turn.then(async (): Promise<Outcome> => {
    if (cachedPdf(cache, id)) return ok;
    const result = await tryCompile(engine, source, figure, timeoutMs);
    if ("pdf" in result) {
      cachePut(cache, id, result.pdf);
      if (!cachedPdf(cache, id)) return { status: "unavailable", message: "Phaethon couldn’t keep the PDF it made." };
      return ok;
    }
    const f = result.failure;
    if (f.kind === "setup") return { status: "unavailable", message: f.message };
    const outcome: Outcome =
      f.kind === "error"
        ? { status: "failed", message: f.message, line: f.line, log: f.log }
        : {
            status: "failed",
            message: `LaTeX took longer than ${Math.floor(timeoutMs / 1000)} seconds, so Phaethon stopped it. The document may loop for ever.`,
            line: null,
            log: f.log,
          };
    if (failures.size > 200) failures.clear();
    failures.set(id, outcome);
    return outcome;
  });
  turn = mine.catch(() => undefined);
  return mine;
}

// ---- Save to space ------------------------------------------------------------

export type Saved = { tex: string; pdf: string | null; note: string | null };

const OUTSIDE = "The space’s documents folder can’t be used: it leads outside the space.";

/**
 * Writes `source` (and its PDF) into `documents/` in the space as `<slug>.tex`
 * and `<slug>.pdf`, choosing `<slug>-2` and on when either name is taken:
 * nothing is ever overwritten.
 */
export function save(space: string, source: string, pdf: Uint8Array | null, title: string, figure: boolean): Saved {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE) throw new Error("This document is too long to save from here.");
  const base = slug(title, figure ? "figure" : "document");
  for (let n = 1; n <= 999; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const texRel = `documents/${name}.tex`;
    const pdfRel = `documents/${name}.pdf`;
    let tex: string;
    let pdfPath: string;
    try {
      tex = resolveIn(space, texRel, false);
      pdfPath = resolveIn(space, pdfRel, false);
    } catch {
      throw new Error(OUTSIDE);
    }
    if (fs.lstatSync(tex, { throwIfNoEntry: false }) || fs.lstatSync(pdfPath, { throwIfNoEntry: false })) continue;
    try {
      fs.mkdirSync(path.dirname(tex), { recursive: true });
    } catch (e) {
      throw new Error(`The documents folder couldn’t be made: ${(e as Error).message}`);
    }
    let fd: number;
    try {
      fd = fs.openSync(tex, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw new Error(`${texRel} couldn’t be written: ${(e as Error).message}`);
    }
    try {
      fs.writeSync(fd, source);
    } catch (e) {
      throw new Error(`${texRel} couldn’t be written: ${(e as Error).message}`);
    } finally {
      fs.closeSync(fd);
    }
    if (!pdf) return { tex: texRel, pdf: null, note: null };
    let pfd: number;
    try {
      pfd = fs.openSync(pdfPath, "wx");
    } catch (e) {
      return { tex: texRel, pdf: null, note: `The PDF couldn’t be saved beside it: ${(e as Error).message}` };
    }
    try {
      fs.writeSync(pfd, pdf);
    } catch (e) {
      throw new Error(`${pdfRel} couldn’t be written: ${(e as Error).message}`);
    } finally {
      fs.closeSync(pfd);
    }
    return { tex: texRel, pdf: pdfRel, note: null };
  }
  throw new Error("There are too many documents with this name in the space already.");
}
