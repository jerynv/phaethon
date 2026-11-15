import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { nodeCli } from "../../../../tests/cli.ts";
import { afterAll, describe, expect, it } from "vitest";
import { claim, release } from "../../core/runs.ts";
import { stderrSummary } from "../cli.ts";
import { findOnPath, readLines, spawnInGroup, stopGroup } from "../process.ts";
import { alive, waitFor } from "./helpers.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-cli-process-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
const node = process.execPath;

function script(name: string, body: string): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

describe("process groups", () => {
  it("give the prompt on stdin and scrub a parent session's variables", async () => {
    const s = script("echo.mjs", "let t='';process.stdin.on('data',d=>t+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({t,cc:process.env.CLAUDECODE??null,keep:process.env.KEEP}))})");
    const gc = await spawnInGroup(node, [s], { cwd: tmp, env: { ...process.env, CLAUDECODE: "1", KEEP: "yes" }, cli: "claude", input: "a ".repeat(600_000) });
    let line = "";
    await readLines(gc.stdout, (l) => (line = l));
    await gc.exited;
    const out = JSON.parse(line);
    expect(out.t.length).toBe(1_200_000);
    expect(out.cc).toBeNull();
    expect(out.keep).toBe("yes");
  });

  it("stop escalates to SIGKILL for a child that ignores SIGTERM, and takes its descendants", async () => {
    const pidFile = path.join(tmp, "kid");
    const s = script(
      "stubborn.mjs",
      `import {spawn} from 'node:child_process';import fs from 'node:fs';process.on('SIGTERM',()=>{});const k=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','inherit']});fs.writeFileSync(${JSON.stringify(pidFile)},String(k.pid));console.log('ready');setInterval(()=>{},1000)`,
    );
    const run = claim("process-test")!;
    const gc = await spawnInGroup(node, [s], { cwd: tmp, env: process.env, run });
    expect(run.groups.has(gc.pid)).toBe(true);
    await new Promise<void>((r) => gc.stdout.once("data", () => r()));
    const kid = Number(fs.readFileSync(pidFile, "utf8"));
    const started = Date.now();
    await stopGroup(gc, run);
    const took = Date.now() - started;
    // Windows ends a job immediately; POSIX escalates after its grace period.
    if (process.platform !== "win32") expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(4000);
    expect(alive(gc.pid)).toBe(false);
    expect(await waitFor(() => !alive(kid))).toBe(true);
    expect(run.groups.size).toBe(0);
    release(run);
  });

  it("never hang on stderr held open by a descendant after a normal exit", async () => {
    const s = script("leaves.mjs", "import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','inherit']});process.stderr.write('boom\\n');setTimeout(()=>process.exit(3),50)");
    const gc = await spawnInGroup(node, [s], { cwd: tmp, env: process.env });
    const exit = await gc.exited;
    const started = Date.now();
    const stderr = await gc.stderrText(1000);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(exit.code).toBe(3);
    expect(stderrSummary(stderr)).toBe("boom");
  });

  it("end the whole group when the core itself dies without cleaning up", async () => {
    const pidFile = path.join(tmp, "orphan");
    const core = script(
      "core.mts",
      `import { spawnInGroup } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, "../process.ts")).href)};
import fs from "node:fs";
const gc = await spawnInGroup(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: ${JSON.stringify(tmp)}, env: process.env });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(gc.pid));
setInterval(() => {}, 1000);`,
    );
    const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const proc = spawn(node, ["--import", loader, core], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PHAETHON_TEST: "1" } });
    let err = "";
    proc.stderr.on("data", (d) => (err += d));
    expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== "", 10000), err).toBe(true);
    const orphan = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(orphan)).toBe(true);
    proc.kill("SIGKILL");
    // The watcher reads EOF on the pipe only the core held and sends the group SIGTERM.
    expect(await waitFor(() => !alive(orphan), 8000)).toBe(true);
    expect(err).toBe("");
  });

  it("find binaries on PATH, then in the extra folders, executables only", () => {
    const dir = path.join(tmp, "bins");
    fs.mkdirSync(dir);
    const bin = path.join(dir, process.platform === "win32" ? "tool.cmd" : "tool");
    fs.writeFileSync(bin, "", { mode: 0o644 });
    if (process.platform === "win32") {
      expect(findOnPath("tool", [dir])).toBe(bin);
      expect(findOnPath("tool.cmd", [dir])).toBe(bin);
      return;
    }
    expect(findOnPath("tool", [dir])).toBeNull();
    fs.chmodSync(path.join(dir, "tool"), 0o755);
    expect(findOnPath("tool", [dir])).toBe(path.join(dir, "tool"));
  });

  it("preserves literal arguments and stdin through npm launchers in folders with spaces", async () => {
    const bin = nodeCli(path.join(tmp, "a folder & unicode-λ"), "echo-args", `
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({ args: process.argv.slice(2), input }));
`);
    const args = ["a value", 'a"b', "a&b|c", "%PATH%", "!VAR!", "a\nb\rc", "a\\", ""];
    const gc = await spawnInGroup(bin, args, { cwd: tmp, env: process.env, input: "a multiline\nprompt\n" });
    let line = "";
    await readLines(gc.stdout, (s) => line = s);
    expect(await gc.exited).toMatchObject({ code: 0 });
    expect(JSON.parse(line)).toEqual({ args, input: "a multiline\nprompt\n" });
    gc.dispose();
  });

  it.skipIf(process.platform !== "win32")("refuses multiline arguments to non-npm batch files", async () => {
    const bin = script("custom.cmd", "@echo off\r\necho should-not-run\r\n");
    await expect(spawnInGroup(bin, ["first\r\nsecond"], { cwd: tmp, env: process.env })).rejects.toThrow("single-line");
  });
});
