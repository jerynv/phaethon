// Launches the real desktop app headless (offscreen, software GL), waits, and
// saves a screenshot of the main window. Usage:
//   node scripts/capture.mjs <out.png> [delayMs]
// Set PHAETHON_HOME to run against a throwaway home folder.
import { spawnSync } from "node:child_process";
import path from "node:path";
import electron from "electron";

const out = path.resolve(process.argv[2] ?? "capture.png");
const delay = process.argv[3] ?? "4000";
const root = path.resolve(import.meta.dirname, "..");
const result = spawnSync(
  electron,
  ["--ozone-platform=headless", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", root],
  { env: { ...process.env, PHAETHON_CAPTURE: out, PHAETHON_CAPTURE_DELAY: delay }, stdio: ["ignore", "inherit", "pipe"], timeout: 120000 },
);
const noise = /dbus|fontconfig|gpu|egl|angle|viz_main|gl_display|gl_ozone|sandbox_linux/i;
for (const line of String(result.stderr ?? "").split("\n")) if (line && !noise.test(line)) console.error(line);
console.log(result.status === 0 ? `saved ${out}` : `electron exited with ${result.status ?? result.signal}`);
process.exit(result.status ?? 1);
