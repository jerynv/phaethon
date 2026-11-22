// `pnpm dist:dev [--install] [--sign]`: builds Phaethon Dev for this machine
// (see electron-builder.dev.yml and src/shared/channel.ts) into release-dev/.
// --install (macOS) copies it to /Applications, beside the release.
// On macOS it's signed ad hoc, which runs on the machine that built it and
// needs no keychain (so it builds over SSH too); --sign uses the keychain's
// signing identity instead.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const install = process.argv.includes("--install");
const adHoc = process.platform === "darwin" && !process.argv.includes("--sign");
const env = { ...process.env, PHAETHON_CHANNEL: "dev" };
delete env.PHAETHON_TELEMETRY_BUILD_ENDPOINT;
// Ad hoc builds turn hardened runtime off: its library validation rejects frameworks without a Team ID.
if (adHoc) env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const signArgs = adHoc ? ["-c.mac.identity=-", "-c.mac.hardenedRuntime=false"] : [];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

run("pnpm", ["build"]);
run("pnpm", ["exec", "electron-builder", "--config", "electron-builder.dev.yml", "--dir", "--publish", "never", ...signArgs]);

const out = path.join(root, "release-dev");
const built = fs.readdirSync(out).map((d) => path.join(out, d)).filter((d) => fs.statSync(d).isDirectory() && /-unpacked$|^mac/.test(path.basename(d)));
const app = built.map((d) => path.join(d, "Phaethon Dev.app")).find((p) => fs.existsSync(p));
console.log(`\nPhaethon Dev is in ${app ?? built.join(", ")}`);

if (install) {
  if (process.platform !== "darwin" || !app) {
    console.error("--install copies the app to /Applications on macOS only.");
    process.exit(1);
  }
  const target = "/Applications/Phaethon Dev.app";
  const running = spawnSync("pgrep", ["-f", `${target}/Contents/MacOS/`]).status === 0;
  if (running) {
    console.error("Phaethon Dev is open. Quit it, then run this again.");
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
  execFileSync("ditto", [app, target]);
  console.log(`Installed ${target}`);
}
