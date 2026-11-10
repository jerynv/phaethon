import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claim, release, type Run } from "../core/runs.ts";
import { CLI, cliName, INELIGIBLE_MESSAGE, stderrSummary, type CliId } from "./cli.ts";
import { abortion } from "./drive.ts";
import { baseArgs, policyFile } from "./gemini.ts";
import { account, binary, cliCommand, codexLoggedIn, type CliCommand } from "./instances.ts";
import { spawnInGroup, stopGroup } from "./process.ts";

/**
 * Signing in through each CLI's own sign-in, with the chosen home: Phaethon
 * starts it, the CLI opens the browser itself, and Phaethon learns how it
 * went only from what the CLI says. It never reads, copies or passes on what
 * the CLI saves. A sign-in is kept as a run (`"\0sign-in:<cli>"`, or
 * `"\0sign-in:instance:<id>"` for Claude Code) so Stop and quitting reach it.
 */

export type SignInStatus = "signedIn" | "notSignedIn" | "cancelled" | "busy" | "missing";
export type SignInOutcome = { status: SignInStatus; message: string };

/** How long a sign-in may wait for the person in the browser. */
export const SIGN_IN_WAIT_MS = 15 * 60 * 1000;
/** What Gemini CLI asks before it opens the browser. */
const CONSENT = "Do you want to continue?";

const outcome = (status: SignInStatus, message: string): SignInOutcome => ({ status, message });

/** The run key of a CLI's sign-in. A space id never starts with NUL. */
export function runKey(cli: CliId): string {
  return `\0sign-in:${cli}`;
}

export function instanceRunKey(id: string): string {
  return `\0sign-in:instance:${id}`;
}

type Ended = { kind: "exited"; said: string; success: boolean } | { kind: "cancelled" } | { kind: "timedOut" } | { kind: "failed"; error: string };

/** Runs a sign-in to its end, a stop, or the wait limit. When `consent` shows up in its output, answers yes once. */
async function runSignIn(cmd: CliCommand, args: string[], run: Run, consent: string | null, extraEnv: Record<string, string> = {}, waitMs = SIGN_IN_WAIT_MS): Promise<Ended> {
  let gc;
  try {
    gc = await spawnInGroup(cmd.file, [...cmd.args, ...args], { cwd: cmd.cwd, env: { ...cmd.env, ...extraEnv }, run });
  } catch (e) {
    return { kind: "failed", error: (e as Error).message };
  }
  let said = "";
  let answered = false;
  const hear = (d: Buffer) => {
    said += d.toString("utf8");
    if (said.length > 64 * 1024) said = said.slice(-48 * 1024);
    if (consent && !answered && said.includes(consent)) {
      answered = true;
      gc.stdin?.write("y\n");
    }
  };
  gc.stdout.on("data", hear);
  gc.child.stderr?.on("data", hear);
  const pipesClosed = Promise.all([new Promise((r) => gc.stdout.once("close", r)), new Promise((r) => gc.child.stderr?.once("close", r) ?? r(null))]);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), waitMs)));
  const done = await Promise.race([Promise.all([pipesClosed, gc.exited]).then(() => "done" as const), abortion(run.abort.signal), timedOut]);
  clearTimeout(timer);
  if (done !== "done") {
    await stopGroup(gc, run);
    return done === "abort" ? { kind: "cancelled" } : { kind: "timedOut" };
  }
  const exit = await gc.exited;
  await stopGroup(gc, run);
  return { kind: "exited", said, success: exit.code === 0 };
}

/** Claude Code's own browser sign-in (`claude auth login`) with the instance's config folder. */
export async function claudeSignIn(dir: string | null, instance: string): Promise<SignInOutcome> {
  const bin = binary("claude", dir);
  if (!bin) return outcome("missing", CLI.claude.missing);
  const run = claim(instanceRunKey(instance));
  if (!run) return outcome("busy", "Sign-in is already running.");
  try {
    const ended = await runSignIn(cliCommand("claude", bin, os.tmpdir(), dir), ["auth", "login"], run, null);
    switch (ended.kind) {
      case "cancelled":
        return outcome("cancelled", "Sign-in stopped.");
      case "timedOut":
        return outcome("notSignedIn", "Sign-in timed out.");
      case "failed":
        return outcome("notSignedIn", `Claude Code couldn’t start: ${ended.error}`);
      case "exited":
        if (!ended.success) return outcome("notSignedIn", "Claude Code did not finish signing in.");
        return (await account("claude", dir)).loggedIn === true ? outcome("signedIn", "Signed in to Claude Code.") : outcome("notSignedIn", "Claude Code did not finish signing in.");
    }
  } finally {
    release(run);
  }
}

/** Signs in to `cli` with `home` as its home, waiting for the person to finish in the browser (or a stop). */
export async function signIn(cli: CliId, home: string): Promise<SignInOutcome> {
  if (!CLI[cli].ownHome) return claudeSignIn(home, "claude");
  const bin = binary(cli, home);
  if (!bin) return outcome("missing", CLI[cli].missing);
  const run = claim(runKey(cli));
  if (!run) return outcome("busy", `Phaethon is already waiting for you to sign in to ${cliName(cli)}.`);
  try {
    return cli === "codex" ? await codexSignIn(bin, home, run) : await geminiSignIn(bin, home, run);
  } finally {
    release(run);
  }
}

function codexNotFinished(said: string): SignInOutcome {
  const why = stderrSummary(said);
  return outcome("notSignedIn", why ? `Codex didn’t finish signing in: ${why}` : "Codex didn’t finish signing in. Try again.");
}

async function codexSignIn(bin: string, home: string, run: Run): Promise<SignInOutcome> {
  const ended = await runSignIn(cliCommand("codex", bin, os.tmpdir(), home), ["login"], run, null);
  switch (ended.kind) {
    case "cancelled":
      return outcome("cancelled", "Signing in to Codex was stopped.");
    case "failed":
      return outcome("notSignedIn", `Codex couldn’t start: ${ended.error}`);
    case "timedOut":
      return outcome("notSignedIn", "Codex waited too long for you to sign in. Try again.");
    case "exited":
      if (!ended.success) return codexNotFinished(ended.said);
      // Only Codex's own status says whether it worked.
      return (await codexLoggedIn(bin, home)) === true ? outcome("signedIn", "Signed in to Codex for this Phaethon folder.") : codexNotFinished(ended.said);
  }
}

/** Chooses "Sign in with Google" in Gemini CLI's settings in `home` when nothing is chosen yet. Only that file is touched. */
export function prepareGeminiHome(home: string): void {
  const dir = path.join(home, ".gemini");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "settings.json");
  let settings: Record<string, unknown>;
  try {
    const text = fs.readFileSync(file, "utf8");
    try {
      const v = JSON.parse(text);
      // Gemini CLI allows comments; a file Phaethon can't read is left alone.
      if (!v || typeof v !== "object" || Array.isArray(v)) return;
      settings = v;
    } catch {
      return;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    settings = {};
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(settings.security) && isObj(settings.security.auth) && typeof settings.security.auth.selectedType === "string") return;
  if (!isObj(settings.security)) settings.security = {};
  const security = settings.security as Record<string, unknown>;
  if (!isObj(security.auth)) security.auth = {};
  (security.auth as Record<string, unknown>).selectedType = "oauth-personal";
  const tmp = path.join(dir, `settings.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, file);
}

/** What Gemini CLI's words at the end of a sign-in mean. */
export function geminiOutcome(said: string): SignInOutcome {
  if (said.includes("IneligibleTierError")) return outcome("notSignedIn", INELIGIBLE_MESSAGE);
  const line = said.split(/\r?\n/).find((l) => l.includes("Error authenticating"));
  if (line !== undefined) {
    let why = line.trim();
    while (why.startsWith("Error authenticating:")) why = why.slice("Error authenticating:".length);
    why = why.trim();
    const at = why.indexOf("Error: ");
    if (at >= 0) why = why.slice(at + "Error: ".length);
    return outcome("notSignedIn", `Gemini CLI didn’t finish signing in: ${why}`);
  }
  if (said.includes("No input provided")) return outcome("signedIn", "Signed in to Gemini CLI for this Phaethon folder.");
  const why = stderrSummary(said);
  return outcome("notSignedIn", why ? `Gemini CLI didn’t finish signing in: ${why}` : "Gemini CLI didn’t finish signing in. Try again.");
}

async function geminiSignIn(bin: string, home: string, run: Run): Promise<SignInOutcome> {
  let cwd: string;
  let policy: string;
  try {
    prepareGeminiHome(home);
    cwd = path.join(home, "sign-in");
    fs.mkdirSync(cwd, { recursive: true });
    policy = policyFile(true);
  } catch (e) {
    return outcome("notSignedIn", `Phaethon couldn’t prepare Gemini CLI’s folder: ${(e as Error).message}`);
  }
  // Headless runs need a trusted folder: this empty one. No message is sent.
  const ended = await runSignIn(cliCommand("gemini", bin, cwd, home), baseArgs(policy, "text", null), run, CONSENT, { GEMINI_CLI_TRUST_WORKSPACE: "true" });
  switch (ended.kind) {
    case "cancelled":
      return outcome("cancelled", "Signing in to Gemini CLI was stopped.");
    case "failed":
      return outcome("notSignedIn", `Gemini CLI couldn’t start: ${ended.error}`);
    case "timedOut":
      return outcome("notSignedIn", "Gemini CLI waited too long for you to sign in. Try again.");
    case "exited":
      return geminiOutcome(ended.said);
  }
}
