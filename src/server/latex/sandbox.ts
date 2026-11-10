import path from "node:path";
import { isWithin } from "../core/fsx.ts";
import { CPU_SECONDS, MAX_FILE, type Engine } from "./tex.ts";

/**
 * The walls TeX runs inside. TeX is written by a model, so it is untrusted:
 * it can name any file (`\input{/etc/passwd}`; TeX Live 2026 made
 * `openin_any` a no-op), write files, run programs and loop for ever.
 *
 * - macOS: `sandbox-exec` with the Rust core's profile, verbatim.
 * - Linux: bubblewrap (`bwrap`) with an equivalent confinement: no network, a
 *   read-only system (`/usr` and TeX's own trees), no `/home`, `/etc` (beyond
 *   TeX and font settings), `/tmp` or `/run`, and writes only in the compile folder.
 * - Anything else: nothing is compiled.
 *
 * Both run under `/bin/sh` setting the file-size and CPU limits first (Node
 * has no pre_exec), as the leader of a new process group.
 */

/** TeX's own trees in the home folder (TEXMFHOME, TEXMFVAR, TEXMFCONFIG) that kpsewhich named. */
export type TexHome = { vars: Array<[string, string]> };

export const NO_SANDBOX_WINDOWS =
  "Phaethon compiles LaTeX only inside a sandbox, which it has on macOS and Linux so far. The document’s source is below.";
export const NO_SANDBOX_LINUX =
  "Phaethon compiles LaTeX only inside a sandbox. On Linux that sandbox is bubblewrap: install the “bubblewrap” package, then open this again. The document’s source is below.";
export const NO_WALLS = "Phaethon couldn’t set up the walls LaTeX runs inside.";

export type Probe = {
  /** realpath, or the path itself when it can't be resolved. */
  real: (p: string) => string;
  exists: (p: string) => boolean;
  isSymlink: (p: string) => string | null;
  userHome: string | null;
};

/** A path as an SBPL string, or null when it can't be one safely. */
export function sbStr(p: string): string | null {
  if (/["\\\n]/.test(p)) return null;
  return `"${p}"`;
}

/** The macOS sandbox profile for one compile in `work` (null when a required path can't be quoted). */
export function sandboxProfile(work: string, engine: Engine, home: TexHome, probe: Pick<Probe, "real" | "userHome">): string | null {
  const engineDir = path.dirname(probe.real(engine.path));
  const workS = sbStr(work);
  const engineS = sbStr(engineDir);
  if (!workS || !engineS) return null;
  const readOk = [workS, engineS];
  for (const [, p] of home.vars) {
    const s = sbStr(probe.real(p));
    if (s) readOk.push(s);
  }
  const h = probe.userHome;
  if (h) {
    const fonts = sbStr(path.join(h, "Library/Fonts"));
    if (fonts) readOk.push(fonts);
    if (engine.kind === "tectonic") {
      const cache = sbStr(path.join(h, "Library/Caches/Tectonic"));
      if (cache) readOk.push(cache);
    }
  }
  const subpaths = (v: string[]) => v.map((s) => `(subpath ${s})`).join(" ");
  const execOk = [engineS, '"/usr/local/texlive"', '"/Library/TeX"'];
  if (isWithin(engine.path, "/opt/homebrew") || isWithin(engineDir, "/opt/homebrew")) execOk.push('"/opt/homebrew"');
  const writeOk = [workS];
  if (engine.kind === "tectonic" && h) {
    const cache = sbStr(path.join(h, "Library/Caches/Tectonic"));
    if (cache) writeOk.push(cache);
  }
  return (
    "(version 1)\n(allow default)\n(deny network*)\n" +
    `(deny process-exec*)\n(allow process-exec* ${subpaths(execOk)} (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/dash") (literal "/bin/zsh"))\n` +
    `(deny file-write*)\n(allow file-write* ${subpaths(writeOk)} (literal "/dev/null") (literal "/dev/tty"))\n` +
    '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/etc") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/root") (subpath "/Library/Keychains"))\n' +
    `(allow file-read* ${subpaths(readOk)})\n`
  );
}

/** System folders a Linux TeX needs to read, beyond `/usr`: its settings, generated formats and font caches. */
const LINUX_READ_TRY = ["/etc/texmf", "/etc/fonts", "/etc/ld.so.cache", "/etc/alternatives", "/var/lib/texmf", "/var/cache/fontconfig", "/opt/texlive"];
/** Top-level folders that are symlinks into /usr on merged-/usr systems, or real folders elsewhere. */
const LINUX_ROOT_LINKS = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"];

/**
 * bubblewrap's arguments for one compile in `work`. Nothing of the home
 * folder, `/etc` (beyond TeX's and fontconfig's settings), `/tmp`, `/run` or
 * other users is mounted; the network and every other namespace are unshared;
 * the compile folder is the only writable place.
 */
export function bwrapArgs(work: string, engine: Engine, home: TexHome, probe: Probe): string[] {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--ro-bind", "/usr", "/usr"];
  for (const dir of LINUX_ROOT_LINKS) {
    const target = probe.isSymlink(dir);
    if (target !== null) args.push("--symlink", target, dir);
    else if (probe.exists(dir)) args.push("--ro-bind", dir, dir);
  }
  const roTry = (p: string) => args.push("--ro-bind-try", p, p);
  for (const p of LINUX_READ_TRY) roTry(p);
  const engineDir = path.dirname(engine.path);
  const realDir = path.dirname(probe.real(engine.path));
  for (const dir of new Set([engineDir, realDir])) {
    if (isWithin(dir, "/usr")) continue;
    roTry(dir);
    // A TeX Live installed elsewhere (`<root>/bin/<platform>/pdflatex`) reads its tree from <root>.
    const root = path.dirname(path.dirname(dir));
    if (root !== "/" && !isWithin(root, "/usr") && probe.exists(path.join(root, "texmf-dist"))) roTry(root);
  }
  for (const [, p] of home.vars) roTry(probe.real(p));
  const h = probe.userHome;
  if (h) {
    roTry(path.join(h, ".local/share/fonts"));
    roTry(path.join(h, ".fonts"));
    if (engine.kind === "tectonic") {
      const cache = path.join(h, ".cache/Tectonic");
      args.push("--bind-try", cache, cache);
    }
  }
  args.push("--bind", work, work, "--proc", "/proc", "--dev", "/dev", "--chdir", work, "--");
  return args;
}

/** The engine's own arguments after its path. */
export function engineArgs(engine: Engine, work: string): string[] {
  if (engine.kind === "tectonic") return ["--untrusted", "--keep-logs", "--outdir", work, "doc.tex"];
  return ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"];
}

/** The whole environment TeX gets; nothing is inherited. */
export function texEnv(engine: Engine, work: string, home: TexHome): Record<string, string> {
  const env: Record<string, string> = {
    PATH: [path.dirname(engine.path), "/usr/bin", "/bin"].join(":"),
    HOME: work,
    TMPDIR: work,
    TEXMFOUTPUT: work,
    TEXMFCACHE: work,
    openout_any: "p",
    openin_any: "p",
    shell_escape: "f",
    // Long log lines, so an error's line and command aren't wrapped apart.
    max_print_line: "1000",
    error_line: "254",
    half_error_line: "238",
  };
  for (const [k, v] of home.vars) env[k] = v;
  return env;
}

/**
 * `/bin/sh` sets RLIMIT_FSIZE and RLIMIT_CPU (soft = hard) and then execs the
 * sandbox. POSIX `sh` counts `ulimit -f` in 512-byte blocks (dash, and bash
 * started as sh on macOS and Linux); a test checks that on each machine.
 */
export const ULIMIT_BLOCK = 512;
export function limitWrapper(command: string[]): { file: string; args: string[] } {
  const script = `ulimit -f ${MAX_FILE / ULIMIT_BLOCK} && ulimit -t ${CPU_SECONDS} && exec "$@"`;
  return { file: "/bin/sh", args: ["-c", script, "sh", ...command] };
}

export type Plan = { file: string; args: string[]; env: Record<string, string> } | { refused: string };

/**
 * How one run of `engine` happens on `platform`, or why it can't. `bwrap` is
 * the path of a working bubblewrap on Linux (null when none works).
 */
export function runPlan(
  platform: NodeJS.Platform,
  engine: Engine,
  work: string,
  home: TexHome,
  probe: Probe,
  bwrap: string | null,
): Plan {
  const env = texEnv(engine, work, home);
  const tex = [engine.path, ...engineArgs(engine, work)];
  if (platform === "darwin") {
    const profile = sandboxProfile(work, engine, home, probe);
    if (!profile) return { refused: NO_WALLS };
    return { ...limitWrapper(["/usr/bin/sandbox-exec", "-p", profile, ...tex]), env };
  }
  if (platform === "linux") {
    if (!bwrap) return { refused: NO_SANDBOX_LINUX };
    return { ...limitWrapper([bwrap, ...bwrapArgs(work, engine, home, probe), ...tex]), env };
  }
  return { refused: NO_SANDBOX_WINDOWS };
}

/** Whether `platform` has a sandbox at all (checked before any work, so an unsandboxed OS does nothing). */
export function sandboxRefusal(platform: NodeJS.Platform, bwrap: string | null): string | null {
  if (platform === "darwin") return null;
  if (platform === "linux") return bwrap ? null : NO_SANDBOX_LINUX;
  return NO_SANDBOX_WINDOWS;
}
