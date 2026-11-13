import fs from "node:fs";
import path from "node:path";

/** A Node script behind the same launchers npm installs, on every test host. */
export function nodeCli(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(entry, body);
  const windows = process.platform === "win32";
  const bin = path.join(dir, windows ? `${name}.cmd` : name);
  fs.writeFileSync(bin, windows
    ? `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nSET "_prog=node"\r\n"%_prog%" "%dp0%\\${name}.mjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`, { mode: 0o755 });
  return bin;
}
