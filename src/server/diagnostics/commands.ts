import { host } from "../host.ts";
import { log } from "../log.ts";
import { commands } from "../rpc/registry.ts";
import { isDevBuild } from "./build.ts";

/**
 * `dev_log`: the UI's own diagnostics (CSP violations, a summary once it has
 * mounted) on the core's stderr. Inert in a release unless PHAETHON_DIAGNOSTICS
 * is set, and capped so a runaway page can't flood the terminal. A message
 * starting `ui mounted:` also asks the shell for a snapshot of the window,
 * which it writes only where its own environment says (never a path from the page).
 */
export const MAX_DEV_LOG = 2000;

export function diagnosticsOn(): boolean {
  return isDevBuild() || process.env.PHAETHON_DIAGNOSTICS !== undefined;
}

export function devLog(message: unknown, write: (line: string) => void = (line) => process.stderr.write(line)): boolean {
  if (!diagnosticsOn()) return false;
  const text = Array.from(String(message ?? "")).slice(0, MAX_DEV_LOG).join("");
  write(`[webview] ${text}\n`);
  if (text.startsWith("ui mounted:") && host().available) {
    host()
      .call({ op: "snapshot" })
      .catch((e) => log.warn("window snapshot failed", e));
  }
  return true;
}

commands({
  dev_log: (args: { message: string }) => {
    devLog(args.message);
    return null;
  },
});
