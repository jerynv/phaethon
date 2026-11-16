import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * The real icons of the apps Phaethon connects to (Mail, Outlook, Shortcuts),
 * read from the apps installed on this Mac and turned into a small PNG with
 * `sips`. Never bundled: an app that isn't here has no icon, and the UI falls
 * back to its own mark. Cached for the life of the core.
 */

const run = promisify(execFile);

const APPS: Record<string, string[]> = {
  "apple-mail": ["/System/Applications/Mail.app", "/Applications/Mail.app"],
  outlook: ["/Applications/Microsoft Outlook.app"],
  shortcuts: ["/System/Applications/Shortcuts.app", "/Applications/Shortcuts.app"],
};

const cache = new Map<string, Promise<string | null>>();

async function iconFile(app: string): Promise<string | null> {
  for (const bundle of APPS[app] ?? []) {
    if (!fs.existsSync(bundle)) continue;
    let name = "AppIcon";
    try {
      const { stdout } = await run("/usr/bin/plutil", ["-extract", "CFBundleIconFile", "raw", path.join(bundle, "Contents", "Info.plist")]);
      if (stdout.trim()) name = stdout.trim();
    } catch {
      // the usual name
    }
    const file = path.join(bundle, "Contents", "Resources", name.endsWith(".icns") ? name : `${name}.icns`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function render(app: string): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const icns = await iconFile(app);
  if (!icns) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phaethon-icon-"));
  try {
    const out = path.join(dir, "icon.png");
    await run("/usr/bin/sips", ["-s", "format", "png", "--resampleHeightWidthMax", "64", icns, "--out", out], { timeout: 15_000 });
    return `data:image/png;base64,${fs.readFileSync(out).toString("base64")}`;
  } catch {
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A data URL of the app's own icon, or null when it isn't installed or can't be read. */
export function appIcon(app: string): Promise<string | null> {
  if (!APPS[app]) return Promise.resolve(null);
  let p = cache.get(app);
  if (!p) {
    p = render(app);
    cache.set(app, p);
  }
  return p;
}
