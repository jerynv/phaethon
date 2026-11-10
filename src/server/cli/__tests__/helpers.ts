import fs from "node:fs";
import path from "node:path";
import type { AgentEvent } from "../../../shared/agent.ts";
import { CollectingChannel } from "../../rpc/channel.ts";
import { ensureVault, spaceDir } from "../../core/vault.ts";
import { load } from "../../core/thread.ts";
import { toUi } from "../../threads/store.ts";
import type { CliId } from "../cli.ts";
import { runCliTurnClaimed, type CliTurnRequest } from "../turn.ts";

const FAKES = path.join(import.meta.dirname, "fakes");

/** A shell wrapper that runs one of the fake CLIs with this Node, logging into `dir`. */
export function fakeBin(dir: string, cli: CliId, name: string = cli): string {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${path.join(FAKES, `fake-${cli}.mjs`)}" "$@"\n`, { mode: 0o755 });
  return bin;
}

/** A fresh vault in the test's home, with the fake's log folder. */
export function setup(home: string, tag: string) {
  ensureVault();
  const log = path.join(home, `fake-${tag}`);
  fs.mkdirSync(log, { recursive: true });
  process.env.FAKE_DIR = log;
  return { log, school: spaceDir("school"), work: spaceDir("work") };
}

export class FakeLog {
  constructor(readonly dir: string) {}
  runs(): number {
    const f = path.join(this.dir, "count");
    return fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) : 0;
  }
  args(n: number): string[] {
    return JSON.parse(fs.readFileSync(path.join(this.dir, `args-${n}.json`), "utf8"));
  }
  env(n: number): Record<string, string | null> {
    return JSON.parse(fs.readFileSync(path.join(this.dir, `env-${n}.json`), "utf8"));
  }
  text(name: string): string {
    return fs.readFileSync(path.join(this.dir, name), "utf8");
  }
  has(name: string): boolean {
    return fs.existsSync(path.join(this.dir, name));
  }
  rpc(n: number): { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown }[] {
    const f = path.join(this.dir, `rpc-${n}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  }
  /** The value after a flag in run n's argv. */
  flag(n: number, name: string): string | undefined {
    const a = this.args(n);
    const i = a.indexOf(name);
    return i >= 0 ? a[i + 1] : undefined;
  }
}

export function request(cli: CliId, space: string, prompt: string, extra: Partial<CliTurnRequest> = {}): CliTurnRequest {
  return { cli, space, spaceDir: spaceDir(space), workingDir: null, prompt, attachments: [], configDir: null, addDirs: [], model: null, fullAccess: false, ...extra };
}

export async function send(req: CliTurnRequest, onEvent?: (e: AgentEvent) => void): Promise<AgentEvent[]> {
  const ch = new CollectingChannel<AgentEvent>(onEvent);
  await runCliTurnClaimed(req, ch);
  return ch.messages;
}

export function shown(space: string): [string, string][] {
  return toUi(load(space)).map((m) => [m.role, m.text]);
}

export function errors(events: AgentEvent[]): { code: string; message: string }[] {
  return events.flatMap((e) => (e.kind === "error" ? [{ code: e.code, message: e.message }] : []));
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A zombie still answers kill(0); on Linux its state says so.
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (/^\d+ \(.*\) Z/.test(stat)) return false;
    } catch {
      // not Linux
    }
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}
