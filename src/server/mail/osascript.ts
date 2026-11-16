import { spawn } from "node:child_process";

/**
 * Runs an Apple Events script with `/usr/bin/osascript`. The script goes over
 * stdin and its arguments in an environment variable as JSON, never in argv,
 * so neither an address nor a message body shows up in `ps` or can be read as
 * a flag. The script returns JSON on stdout.
 */

export const OSASCRIPT = "/usr/bin/osascript";

export class AppleEventsError extends Error {
  constructor(
    message: string,
    readonly code: "notAllowed" | "notInstalled" | "timeout" | "failed",
  ) {
    super(message);
  }
}

/** The message macOS's error numbers mean for the person. */
export function explain(stderr: string, app: string): AppleEventsError {
  const s = stderr.trim();
  if (/-1743|not authori[sz]ed|Not authorized to send Apple events/i.test(s))
    return new AppleEventsError(
      `Phaethon isn’t allowed to control ${app}. Turn it on in System Settings › Privacy & Security › Automation, under Phaethon.`,
      "notAllowed",
    );
  if (/-2700.*(not found|can.t find)|Application can.t be found|-10814|-600/i.test(s)) return new AppleEventsError(`${app} isn’t installed or couldn’t be opened.`, "notInstalled");
  const m = /execution error: (?:Error: )?(.*?)(?: \(-?\d+\))?$/m.exec(s);
  return new AppleEventsError(`${app} said: ${(m?.[1] ?? s).slice(0, 300) || "an unknown error"}`, "failed");
}

export type ScriptRunner = (script: string, args: unknown, opts: { language: "JavaScript" | "AppleScript"; app: string; timeoutMs: number }) => Promise<string>;

export const runOsascript: ScriptRunner = (script, args, opts) =>
  new Promise((resolve, reject) => {
    if (process.platform !== "darwin") return reject(new AppleEventsError(`${opts.app} can only be used on a Mac.`, "notInstalled"));
    const child = spawn(OSASCRIPT, ["-l", opts.language], {
      env: { ...process.env, PHAETHON_ARGS: JSON.stringify(args ?? null) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      reject(new AppleEventsError(`${opts.app} didn’t answer within ${Math.round(opts.timeoutMs / 1000)} seconds.`, "timeout"));
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(new AppleEventsError(`Couldn’t run osascript: ${e.message}`, "failed"));
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(explain(err, opts.app));
    });
    child.stdin.end(script);
  });

/** The prelude every JXA script starts with: `args` from the environment. */
export const JXA_PRELUDE = `ObjC.import("Foundation");
const args = JSON.parse(ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("PHAETHON_ARGS")) || "null");
`;
