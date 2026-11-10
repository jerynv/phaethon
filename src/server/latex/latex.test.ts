import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, tempHome } from "../../../tests/harness.ts";
import { ensureVault, spacesRoot } from "../core/vault.ts";
import { cachePut, cachedPdf, compileCached, engines, resetFailures, save, tryCompile, workingBwrap } from "./compile.ts";
import { NO_SANDBOX_LINUX, NO_SANDBOX_WINDOWS, ULIMIT_BLOCK, bwrapArgs, limitWrapper, runPlan, sandboxProfile, sbStr, texEnv, type Probe } from "./sandbox.ts";
import { KINDS, cacheId, choose, figureDocument, isCacheId, logTail, needsRerun, parseError, slug, type Engine } from "./tex.ts";
import "./commands.ts";

const env = tempHome("phaethon-latex-");
afterAll(() => env.cleanup());
beforeAll(() => ensureVault());

function tmp(name: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `phaethon-latex-test-${name}-`));
  return fs.realpathSync.native(d);
}

describe("engines and figures", () => {
  it("chooses pdflatex unless the document needs another", () => {
    const all: Engine[] = KINDS.map((kind) => ({ kind, path: kind }));
    expect(choose(all, "\\documentclass{article}")!.kind).toBe("pdflatex");
    expect(choose(all, "\\usepackage{fontspec}")!.kind).toBe("xelatex");
    expect(choose(all, "\\usepackage{unicode-math}")!.kind).toBe("xelatex");
    expect(choose(all, "\\directlua{x=1}")!.kind).toBe("lualatex");
    expect(choose([{ kind: "xelatex", path: "xelatex" }], "plain")!.kind).toBe("xelatex");
    expect(choose([], "x")).toBeUndefined();
  });

  it("puts errors in plain words with their line", () => {
    let r = parseError("(./doc.tex\n! Undefined control sequence.\nl.12 Here is \\foo\n                {x}\n", 0);
    expect(r.line).toBe(12);
    expect(r.message).toBe("LaTeX doesn’t know the command \\foo (line 12). It may need a package the document doesn’t load, or be a typo.");
    r = parseError("! LaTeX Error: File `standalone.cls' not found.\n\nl.1 \\documentclass", 0);
    expect(r.message).toContain("“standalone” isn’t installed");
    expect(r.message).toContain("tlmgr install standalone");
    r = parseError("! Missing $ inserted.\n<inserted text>\nl.20 x^2", 7);
    expect(r.message).toContain("outside $…$ near line 13");
    expect(r.line).toBe(13);
    expect(parseError("! I can't write on file `../x.txt'.\n", 0).message).toContain("outside its own folder");
    r = parseError("no error here", 0);
    expect(r.message).toContain("couldn’t make a PDF");
    expect(r.line).toBeNull();
    expect(parseError("! Package pgfplots Error: Sorry, x.\nl.4 x", 0).message).toBe("LaTeX stopped near line 4: Package pgfplots Error: Sorry, x.");
    expect(parseError("! LaTeX Error: File `data.csv' not found.\nl.3 x", 0).message).toBe(
      "The document asks for the file “data.csv” (line 3), which isn’t there: a document here compiles on its own, without other files.",
    );
    expect(parseError("Output written. No pages of output.", 0).message).toBe("The document has nothing to show: it made no pages.");
    expect(parseError("! Emergency stop.\nl.9 ", 0).message).toBe("LaTeX stopped early near line 9: the document ended before it was complete.");
    expect(parseError("! Undefined control sequence.\nl.2 {}", 5)).toEqual({
      message: "LaTeX doesn’t know a command. It may need a package the document doesn’t load, or be a typo.",
      line: null,
    });
  });

  it("wraps figures into a cropped page with their lines moved up", () => {
    let { doc, before } = figureDocument("\\usetikzlibrary{matrix}\n\\begin{tikzpicture}\\draw (0,0)--(1,1);\\end{tikzpicture}");
    expect(doc.startsWith("\\documentclass{article}")).toBe(true);
    const lines = doc.split("\n");
    expect(lines.slice(0, before)).toContain("\\usetikzlibrary{matrix}");
    expect(lines[before]).toBe("");
    expect(lines[before + 1].startsWith("\\begin{tikzpicture}")).toBe(true);
    expect(doc).not.toContain("pgfplots");
    expect(doc.endsWith("\\shipout\\vbox{\\kern4pt\\hbox{\\kern4pt\\box0\\kern4pt}\\kern4pt}\n\\end{document}\n")).toBe(true);
    ({ doc } = figureDocument("\\draw (0,0) circle (1);"));
    expect(doc).toContain("\\begin{tikzpicture}\n\\draw (0,0) circle (1);\n\\end{tikzpicture}");
    ({ doc } = figureDocument("\\begin{tikzpicture}\\begin{axis}\\addplot{x};\\end{axis}\\end{tikzpicture}"));
    expect(doc).toContain("\\usepackage{pgfplots}");
  });

  it("reruns only when the log or the source asks", () => {
    expect(needsRerun("LaTeX Warning: Label(s) may have changed.", "")).toBe(true);
    expect(needsRerun("", "\\tableofcontents")).toBe(true);
    expect(needsRerun("(rerun not needed)", "\\tableofcontents")).toBe(false);
    expect(needsRerun("Rerun to get cross-references right. (rerun not needed)", "")).toBe(true);
    expect(needsRerun("", "plain")).toBe(false);
  });

  it("keeps the end of a long log on a character boundary", () => {
    expect(logTail("short")).toBe("short");
    const tail = logTail("é".repeat(40 * 1024));
    expect(tail.startsWith("…\n")).toBe(true);
    expect(tail).not.toContain("\uFFFD");
    expect(Buffer.byteLength(tail.slice(2))).toBeLessThanOrEqual(48 * 1024);
  });
});

describe("cache", () => {
  it("ids are stable hex, the Rust core's, and differ by engine, kind and source", () => {
    const a = cacheId("pdflatex", false, "x");
    // Computed independently from the Rust algorithm, so the old cache keeps hitting.
    expect(a).toBe("7fc74c43aa18d0b3193d5ccabe4e4791");
    expect(cacheId("pdflatex", true, "\\draw é;")).toBe("f4c39846426efab1d36b1eddb01d5a70");
    expect(isCacheId(a)).toBe(true);
    expect(cacheId("xelatex", false, "x")).not.toBe(a);
    expect(cacheId("pdflatex", true, "x")).not.toBe(a);
    expect(cacheId("pdflatex", false, "y")).not.toBe(a);
    for (const bad of ["", "../etc/passwd", "ABCDEF0123456789abcdef0123456789", "g0000000000000000000000000000000"]) expect(isCacheId(bad)).toBe(false);
    const dir = tmp("cache");
    expect(cachedPdf(dir, "../x")).toBeUndefined();
    cachePut(dir, a, Buffer.from("%PDF-1.5"));
    expect(fs.readFileSync(cachedPdf(dir, a)!, "utf8")).toBe("%PDF-1.5");
    fs.rmSync(dir, { recursive: true });
  });

  it("keeps only the newest 200", () => {
    const dir = tmp("prune");
    for (let i = 0; i < 202; i++) {
      const id = i.toString(16).padStart(32, "0");
      fs.writeFileSync(path.join(dir, `${id}.pdf`), "x");
      fs.utimesSync(path.join(dir, `${id}.pdf`), 1000 + i, 1000 + i);
    }
    cachePut(dir, "f".repeat(32), Buffer.from("%PDF"));
    const left = fs.readdirSync(dir).filter((f) => f.endsWith(".pdf"));
    expect(left.length).toBe(200);
    expect(left).not.toContain(`${"0".repeat(32)}.pdf`);
    expect(left).toContain(`${"f".repeat(32)}.pdf`);
    fs.rmSync(dir, { recursive: true });
  });

  it("without an engine says how to install one and runs nothing", async () => {
    const out = await compileCached(tmp("none"), [], "\\documentclass{article}", false, 60_000);
    expect(out.status).toBe("noEngine");
    if (out.status === "noEngine") expect(out.message).toMatch(/MacTeX.*TeX Live.*tectonic/);
  });
});

describe("save", () => {
  it("makes plain file names", () => {
    expect(slug("M301 Study Guide: Vectors & Matrices!", "document")).toBe("m301-study-guide-vectors-matrices");
    expect(slug("../../etc", "document")).toBe("etc");
    expect(slug("…", "figure")).toBe("figure");
    expect(slug("a".repeat(200), "d").length).toBeLessThanOrEqual(60);
  });

  it("never overwrites and stays in the space", () => {
    const space = tmp("save");
    expect(save(space, "\\documentclass{article}", Buffer.from("%PDF"), "Study guide", false)).toEqual({
      tex: "documents/study-guide.tex",
      pdf: "documents/study-guide.pdf",
      note: null,
    });
    expect(save(space, "second", Buffer.from("%PDF2"), "Study guide", false).tex).toBe("documents/study-guide-2.tex");
    expect(fs.readFileSync(path.join(space, "documents/study-guide.tex"), "utf8")).toBe("\\documentclass{article}");
    // A PDF alone with the name takes it too.
    fs.writeFileSync(path.join(space, "documents/notes.pdf"), "x");
    expect(save(space, "s", null, "notes", false).tex).toBe("documents/notes-2.tex");
    expect(fs.readFileSync(path.join(space, "documents/notes.pdf"), "utf8")).toBe("x");
    expect(() => save(space, "x".repeat(512 * 1024 + 1), null, "big", false)).toThrow("This document is too long to save from here.");
    const other = tmp("save-out");
    const space2 = tmp("save2");
    fs.symlinkSync(other, path.join(space2, "documents"));
    expect(() => save(space2, "s", null, "x", false)).toThrow("The space’s documents folder can’t be used: it leads outside the space.");
    expect(fs.readdirSync(other)).toEqual([]);
    for (const d of [space, other, space2]) fs.rmSync(d, { recursive: true });
  });
});

describe("walls, as arguments", () => {
  const probe: Probe = {
    real: (p) => (p === "/usr/bin/pdflatex" ? "/usr/bin/pdftex" : p),
    exists: (p) => p === "/lib32" || p === "/home/u/tl/texmf-dist",
    isSymlink: (p) => (p === "/bin" ? "usr/bin" : p === "/lib" ? "usr/lib" : null),
    userHome: "/home/u",
  };
  const home = { vars: [["TEXMFHOME", "/home/u/texmf"]] as Array<[string, string]> };

  it("writes the macOS profile verbatim", () => {
    const engine: Engine = { kind: "pdflatex", path: "/Library/TeX/texbin/pdflatex" };
    const p = sandboxProfile("/private/var/folders/x/phaethon-latex-1", engine, home, { real: (x) => (x.startsWith("/Library/TeX/texbin") ? "/usr/local/texlive/2026/bin/universal-darwin/pdflatex" : x), userHome: "/Users/u" });
    expect(p).toBe(
      "(version 1)\n(allow default)\n(deny network*)\n" +
        '(deny process-exec*)\n(allow process-exec* (subpath "/usr/local/texlive/2026/bin/universal-darwin") (subpath "/usr/local/texlive") (subpath "/Library/TeX") (literal "/bin/sh") (literal "/bin/bash") (literal "/bin/dash") (literal "/bin/zsh"))\n' +
        '(deny file-write*)\n(allow file-write* (subpath "/private/var/folders/x/phaethon-latex-1") (literal "/dev/null") (literal "/dev/tty"))\n' +
        '(deny file-read* (subpath "/Users") (subpath "/Volumes") (subpath "/private/etc") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/root") (subpath "/Library/Keychains"))\n' +
        '(allow file-read* (subpath "/private/var/folders/x/phaethon-latex-1") (subpath "/usr/local/texlive/2026/bin/universal-darwin") (subpath "/home/u/texmf") (subpath "/Users/u/Library/Fonts"))\n',
    );
    const tectonic = sandboxProfile("/w", { kind: "tectonic", path: "/opt/homebrew/bin/tectonic" }, { vars: [] }, { real: (x) => x, userHome: "/Users/u" })!;
    expect(tectonic).toContain('(subpath "/opt/homebrew")');
    expect(tectonic).toContain('(allow file-write* (subpath "/w") (subpath "/Users/u/Library/Caches/Tectonic")');
    expect(sbStr('/a"b')).toBeNull();
    expect(sbStr("/a\\b")).toBeNull();
    expect(sandboxProfile('/w"', engine, home, { real: (x) => x, userHome: null })).toBeNull();
    expect(runPlan("darwin", engine, '/w"', home, probe, null)).toEqual({ refused: "Phaethon couldn’t set up the walls LaTeX runs inside." });
  });

  it("builds bubblewrap's arguments with only TeX's trees and the compile folder", () => {
    const args = bwrapArgs("/tmp/phaethon-latex-1", { kind: "pdflatex", path: "/home/u/tl/bin/x86_64-linux/pdflatex" }, home, probe);
    const s = args.join(" ");
    expect(args.slice(0, 3)).toEqual(["--unshare-all", "--die-with-parent", "--new-session"]);
    expect(s).toContain("--ro-bind /usr /usr");
    expect(s).toContain("--symlink usr/bin /bin");
    expect(s).toContain("--symlink usr/lib /lib");
    expect(s).toContain("--ro-bind /lib32 /lib32");
    expect(s).toContain("--ro-bind-try /home/u/tl/bin/x86_64-linux /home/u/tl/bin/x86_64-linux");
    expect(s).toContain("--ro-bind-try /home/u/tl /home/u/tl");
    expect(s).toContain("--ro-bind-try /home/u/texmf /home/u/texmf");
    expect(s).toContain("--ro-bind-try /home/u/.local/share/fonts /home/u/.local/share/fonts");
    expect(s.endsWith("--bind /tmp/phaethon-latex-1 /tmp/phaethon-latex-1 --proc /proc --dev /dev --chdir /tmp/phaethon-latex-1 --")).toBe(true);
    // The only writable bind is the compile folder; nothing of /home, /etc, /tmp or /run as a whole.
    expect(args.filter((a) => a === "--bind" || a === "--bind-try").length).toBe(1);
    for (const whole of ["/home", "/home/u", "/etc", "/tmp", "/run", "/"]) expect(args).not.toContain(whole);
    expect(bwrapArgs("/w", { kind: "tectonic", path: "/usr/bin/tectonic" }, { vars: [] }, probe).join(" ")).toContain("--bind-try /home/u/.cache/Tectonic /home/u/.cache/Tectonic");
  });

  it("runs under sh with the file and CPU limits, and an environment of its own", () => {
    const engine: Engine = { kind: "pdflatex", path: "/usr/bin/pdflatex" };
    const plan = runPlan("linux", engine, "/w", home, probe, "/usr/bin/bwrap");
    if ("refused" in plan) throw new Error(plan.refused);
    expect(plan.file).toBe("/bin/sh");
    expect(plan.args.slice(0, 4)).toEqual(["-c", 'ulimit -f 131072 && ulimit -t 120 && exec "$@"', "sh", "/usr/bin/bwrap"]);
    expect(plan.args.slice(-5)).toEqual(["/usr/bin/pdflatex", "-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "doc.tex"]);
    expect(plan.env).toEqual(texEnv(engine, "/w", home));
    expect(plan.env).toMatchObject({ PATH: "/usr/bin:/usr/bin:/bin", HOME: "/w", TMPDIR: "/w", openout_any: "p", shell_escape: "f", TEXMFHOME: "/home/u/texmf" });
    const mac = runPlan("darwin", { kind: "tectonic", path: "/opt/homebrew/bin/tectonic" }, "/w", { vars: [] }, probe, null);
    if ("refused" in mac) throw new Error(mac.refused);
    expect(mac.args[3]).toBe("/usr/bin/sandbox-exec");
    expect(mac.args.slice(-6)).toEqual(["/opt/homebrew/bin/tectonic", "--untrusted", "--keep-logs", "--outdir", "/w", "doc.tex"]);
    expect(runPlan("linux", engine, "/w", home, probe, null)).toEqual({ refused: NO_SANDBOX_LINUX });
    expect(runPlan("win32", engine, "/w", home, probe, null)).toEqual({ refused: NO_SANDBOX_WINDOWS });
    expect(limitWrapper(["x"]).args.at(-1)).toBe("x");
  });

  it.skipIf(process.platform === "win32")("counts sh's ulimit -f in 512-byte blocks on this machine", () => {
    const dir = tmp("ulimit");
    spawnSync("/bin/sh", ["-c", "ulimit -f 4 && head -c 8192 /dev/zero > f"], { cwd: dir, stdio: "ignore" });
    expect(fs.statSync(path.join(dir, "f")).size).toBe(4 * ULIMIT_BLOCK);
    fs.rmSync(dir, { recursive: true });
  });
});

// ---- Real walls with a fake engine (a shell script standing in for pdflatex) ----

const walled = process.platform === "darwin" || (process.platform === "linux" && workingBwrap() !== null);

function fake(dir: string, script: string): Engine {
  const p = path.join(dir, "pdflatex");
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return { kind: "pdflatex", path: p };
}

async function failureLog(engine: Engine, timeoutMs = 20_000): Promise<string> {
  const r = await tryCompile(engine, "\\documentclass{article}", false, timeoutMs);
  if ("pdf" in r || r.failure.kind !== "error") throw new Error(JSON.stringify(r));
  return r.failure.log;
}

describe.skipIf(!walled)("walls, with a fake engine", () => {
  it("kills a fake engine that hangs at the deadline", async () => {
    const dir = tmp("fake-hang");
    const t = Date.now();
    const r = await tryCompile(fake(dir, "while :; do :; done"), "\\documentclass{article}", false, 2000);
    expect("failure" in r && r.failure.kind).toBe("timeout");
    expect(Date.now() - t).toBeLessThan(10_000);
    fs.rmSync(dir, { recursive: true });
  });

  it("brings a fake engine's error back in plain words", async () => {
    const dir = tmp("fake-err");
    const r = await tryCompile(fake(dir, "printf '! Undefined control sequence.\\nl.3 \\\\foo\\n' > doc.log; exit 1"), "\\documentclass{article}", false, 20_000);
    if ("pdf" in r || r.failure.kind !== "error") throw new Error(JSON.stringify(r));
    expect(r.failure.message).toContain("\\foo");
    expect(r.failure.line).toBe(3);
    expect(r.failure.log).toContain("Undefined control sequence");
    fs.rmSync(dir, { recursive: true });
  });

  it("runs a fake engine in its own empty folder and environment", async () => {
    const dir = tmp("fake-env");
    const log = await failureLog(fake(dir, 'export -p > doc.log; pwd >> doc.log; for f in * .*; do echo "$f"; done >> doc.log; exit 1'));
    expect(log).toMatch(/openout_any=['"]p['"]/);
    expect(log).toMatch(/shell_escape=['"]f['"]/);
    expect(log).not.toMatch(/USER=|VITEST|PHAETHON_HOME/);
    expect(log).toContain("phaethon-latex-");
    const lines = log.split("\n");
    expect(lines).toContain("doc.tex");
    expect(lines.some((l) => l.endsWith(".pdf"))).toBe(false);
    fs.rmSync(dir, { recursive: true });
  });

  it("can't read outside its folder or write anywhere else", async () => {
    const dir = tmp("fake-walls");
    const secret = path.join(tmp("secret"), "secret.txt");
    fs.writeFileSync(secret, "TOP-SECRET");
    const vaultFile = path.join(spacesRoot(), "school", "notes.md");
    fs.writeFileSync(vaultFile, "VAULT-SECRET");
    const outside = path.join(os.tmpdir(), `phaethon-wall-probe-${process.pid}`);
    const realHome = os.homedir();
    const log = await failureLog(
      fake(
        dir,
        [
          `cat /etc/passwd > /dev/null 2>&1 && echo READ:passwd`,
          `cat '${secret}' 2>/dev/null`,
          `cat '${vaultFile}' 2>/dev/null`,
          `ls -a '${realHome}' 2>/dev/null | grep -q . && echo READ:home`,
          `cat ../*/secret.txt 2>/dev/null`,
          `touch '${outside}' 2>/dev/null && echo WROTE:outside`,
          `echo ok > here.txt && echo WROTE:here`,
          `exit 1`,
        ]
          .map((l) => `{ ${l}; } >> doc.log`)
          .join("\n"),
      ),
    );
    expect(log).not.toContain("READ:passwd");
    expect(log).not.toContain("TOP-SECRET");
    expect(log).not.toContain("VAULT-SECRET");
    expect(log).not.toContain("READ:home");
    expect(log).toContain("WROTE:here");
    expect(fs.existsSync(outside)).toBe(false);
    fs.rmSync(dir, { recursive: true });
    fs.rmSync(path.dirname(secret), { recursive: true });
  });
});

// ---- Real TeX, when this machine has it ----

const tex = walled ? engines().filter((e) => e.kind !== "tectonic") : [];

describe.skipIf(tex.length === 0)("walls, with real TeX", () => {
  for (const engine of tex) {
    const probeDoc = (body: string) => `\\documentclass{article}\\begin{document}${body}\\undefinedprobe\\end{document}`;

    it(`${engine.kind}: absolute paths and shell escape reach nothing`, async () => {
      const marker = path.join(os.tmpdir(), `phaethon-write18-${process.pid}`);
      const r = await tryCompile(engine, probeDoc(`\\IfFileExists{/etc/passwd}{SEEN}{UNSEEN}\\immediate\\write18{touch ${marker}}\\typeout{PROBE-\\IfFileExists{/etc/hosts}{SEEN}{UNSEEN}}`), false, 30_000);
      if ("pdf" in r || r.failure.kind !== "error") throw new Error(JSON.stringify(r));
      expect(r.failure.log).toContain("PROBE-UNSEEN");
      expect(fs.existsSync(marker)).toBe(false);
      const input = await tryCompile(engine, "\\documentclass{article}\\begin{document}\\input{/etc/passwd}\\end{document}", false, 30_000);
      expect("failure" in input && input.failure.kind === "error" && input.failure.message).toContain("/etc/passwd");
    });

    it(`${engine.kind}: writes outside the folder fail`, async () => {
      const r = await tryCompile(engine, probeDoc(`\\immediate\\openout1=/tmp/phaethon-out-${process.pid}.tex \\immediate\\write1{x}\\immediate\\closeout1`), false, 30_000);
      if ("pdf" in r || r.failure.kind !== "error") throw new Error(JSON.stringify(r));
      expect(r.failure.message).toContain("outside its own folder");
      expect(fs.existsSync(`/tmp/phaethon-out-${process.pid}.tex`)).toBe(false);
    });

    it(`${engine.kind}: an endless loop is stopped at the deadline`, async () => {
      const t = Date.now();
      const r = await tryCompile(engine, "\\documentclass{article}\\begin{document}\\def\\x{\\x}\\x\\end{document}", false, 4000);
      expect("failure" in r && r.failure.kind).toBe("timeout");
      expect(Date.now() - t).toBeLessThan(15_000);
    });
  }

  it("a figure and a document compile to PDFs, the second time from the cache", async () => {
    resetFailures();
    const cache = tmp("real-cache");
    const fig = await compileCached(cache, tex, "\\begin{axis}\\addplot{x^2};\\end{axis}", true, 60_000);
    expect(fig.status).toBe("ok");
    const doc = "\\documentclass{article}\\begin{document}\\tableofcontents\\section{A}x\\end{document}";
    const first = await compileCached(cache, tex, doc, false, 60_000);
    expect(first.status).toBe("ok");
    if (first.status === "ok") expect(fs.readFileSync(cachedPdf(cache, first.id)!).subarray(0, 4).toString()).toBe("%PDF");
    const t = Date.now();
    expect(await compileCached(cache, tex, doc, false, 60_000)).toEqual(first);
    expect(Date.now() - t).toBeLessThan(200);
  });
});

describe("commands", () => {
  it("reports engines and refuses a PDF id that isn't one", async () => {
    const status = await call<{ engine: string | null; engines: string[]; message: string | null }>("latex_status");
    expect(Array.isArray(status.engines)).toBe(true);
    expect(status.message === null).toBe(status.engines.length > 0);
    await expect(call("latex_pdf", { id: "../../etc/passwd" })).rejects.toThrow("That PDF isn’t here any more. Compile the document again.");
  });

  it("saves into the space's documents folder, with a note when there is no PDF", async () => {
    const saved = await call<{ tex: string; pdf: string | null; note: string | null }>("latex_save", { space: "school", source: "\\draw (0,0) circle (1);", title: "Unit circle", figure: true });
    expect(saved.tex).toBe("documents/unit-circle.tex");
    const text = fs.readFileSync(path.join(spacesRoot(), "school", saved.tex), "utf8");
    expect(text.startsWith("\\documentclass{article}")).toBe(true);
    if (saved.pdf === null) expect(saved.note).toMatch(/^Only the source was saved: /);
    await expect(call("latex_save", { space: "../x", source: "x", title: "t" })).rejects.toThrow('"../x" is not a valid space name');
  });
});
