import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../core/fsx.ts";
import { vaultStateDir } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { isTest } from "../env.ts";

/**
 * Shortcuts as a connector: anything the person has built in the Shortcuts
 * app (send an iMessage, add a calendar event, log hours) becomes a tool, but
 * only the shortcuts they allowed for a space, in
 * `<vault>/.phaethon/shortcuts.json`. Run with `/usr/bin/shortcuts`; input
 * and output go through files, never argv.
 */

export const SHORTCUTS_BIN = "/usr/bin/shortcuts";
const MAX_OUTPUT = 20_000;

export type ShortcutsSettings = { allowed: Record<string, string[]> };

export function shortcutsFile(): string {
  return path.join(vaultStateDir(), "shortcuts.json");
}

export function readShortcutsSettings(): ShortcutsSettings {
  try {
    const o = readJson<Record<string, unknown>>(shortcutsFile(), {});
    const allowed: Record<string, string[]> = {};
    if (o.allowed && typeof o.allowed === "object") for (const [k, v] of Object.entries(o.allowed as Record<string, unknown>)) if (Array.isArray(v)) allowed[k] = v.filter((s): s is string => typeof s === "string");
    return { allowed };
  } catch {
    return { allowed: {} };
  }
}

export function setAllowedShortcuts(space: string, names: string[]): ShortcutsSettings {
  const s = readShortcutsSettings();
  s.allowed[space] = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 100);
  if (!s.allowed[space]!.length) delete s.allowed[space];
  writeJsonAtomic(shortcutsFile(), s, { newline: true });
  return s;
}

export function allowedShortcuts(space: string): string[] {
  return readShortcutsSettings().allowed[space] ?? [];
}

const MAX_STREAM = 1024 * 1024;
export type Runner = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<{ code: number; out: string; err: string }>;

const run: Runner = (args, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    if (process.platform !== "darwin" || !fs.existsSync(SHORTCUTS_BIN)) return reject(new Refusal("Shortcuts is only on a Mac."));
    const child = spawn(SHORTCUTS_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const done = (f: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      signal?.removeEventListener("abort", onAbort);
      f();
    };
    const onAbort = () =>
      done(() => {
        child.kill("SIGKILL");
        reject(new Error("cancelled"));
      });
    signal?.addEventListener("abort", onAbort, { once: true });
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => {
      if (out.length < MAX_STREAM) out += String(d).slice(0, MAX_STREAM - out.length);
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_STREAM) err += String(d).slice(0, MAX_STREAM - err.length);
    });
    child.on("error", (e) => done(() => reject(e)));
    child.on("close", (code) => done(() => resolve({ code: code ?? -1, out, err })));
  });

/**
 * Tests never touch this computer's Shortcuts app: PHAETHON_FAKE_SHORTCUTS
 * (comma-separated names) is the list, and running one echoes its input.
 */
const fake: Runner = async (args) => {
  if (args[0] === "list") return { code: 0, out: (process.env.PHAETHON_FAKE_SHORTCUTS ?? "").split(",").map((s) => s.trim()).filter(Boolean).join("\n"), err: "" };
  const inFile = args[args.indexOf("--input-path") + 1];
  const outFile = args[args.indexOf("--output-path") + 1];
  if (inFile && outFile) fs.writeFileSync(outFile, `ran ${args[1]}: ${fs.readFileSync(inFile, "utf8")}`);
  return { code: 0, out: "", err: "" };
};

let runner: Runner | undefined;
const current = (): Runner => runner ?? (isTest() ? fake : run);
export function setShortcutsRunner(r: Runner | undefined): void {
  runner = r;
}

export async function listShortcuts(): Promise<string[]> {
  const r = await current()(["list"], 20_000);
  if (r.code !== 0) throw new Refusal(`Shortcuts couldn’t list your shortcuts: ${r.err.trim() || `exit ${r.code}`}`);
  return r.out.split("\n").map((s) => s.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export async function runShortcut(space: string, name: string, input: string, signal?: AbortSignal): Promise<string> {
  if (!allowedShortcuts(space).includes(name)) throw new Refusal(`“${name}” isn’t a shortcut this space may run. The user can allow it in Settings › Mail & connectors.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-shortcut-"));
  try {
    const inFile = path.join(dir, "input.txt");
    const outFile = path.join(dir, "output.txt");
    fs.writeFileSync(inFile, input ?? "");
    if (signal?.aborted) throw new Error("cancelled");
    const r = await current()(["run", name, "--input-path", inFile, "--output-path", outFile, "--output-type", "public.plain-text"], 120_000, signal);
    if (r.code !== 0) throw new Refusal(`The shortcut “${name}” failed: ${r.err.trim().slice(0, 400) || `exit ${r.code}`}`);
    let out = "";
    try {
      out = fs.readFileSync(outFile, "utf8");
    } catch {
      out = r.out;
    }
    out = out.trim();
    return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n[… output cut]` : out || "(The shortcut ran and returned nothing.)";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
