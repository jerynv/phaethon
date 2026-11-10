import { app } from "electron";
import { autoUpdater } from "electron-updater";
import { UPDATE_FEED, type HostEventBody, type UpdateCheckResult, type UpdateDownloadResult, type UpdateError } from "../shared/host.ts";

/**
 * electron-updater, driven only by the core's host ops (the renderer never
 * reaches it). Nothing downloads or installs on its own: the core asks to
 * check, to download (sha512-verified against the release's latest*.yml
 * before it counts as downloaded) and to quit into the installer.
 *
 * Phaethon 0.1.x was a Tauri app whose updater reads latest.json with a
 * minisign key; it can't move itself to an Electron build. Those installs
 * need one manual download of 0.2 or later.
 */

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.fullChangelog = false;
  // A development build may check (Settings shows the result) but the core never lets it install.
  autoUpdater.forceDevUpdateConfig = !app.isPackaged;
  autoUpdater.setFeedURL({ ...UPDATE_FEED });
  autoUpdater.logger = {
    info: () => {},
    debug: () => {},
    warn: (m: unknown) => console.warn("[updater]", m),
    error: (m: unknown) => console.error("[updater]", m),
  };
  // Errors also reach the promise that asked; without a listener the emitter would throw.
  autoUpdater.on("error", () => {});
}

function errorOf(e: unknown): UpdateError {
  const err = e as { message?: string; code?: string; statusCode?: number } | undefined;
  return { message: err?.message ?? String(e), code: typeof err?.code === "string" ? err.code : undefined, statusCode: typeof err?.statusCode === "number" ? err.statusCode : undefined };
}

function notesOf(notes: unknown): string | null {
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) return notes.map((n: { note?: string | null }) => n?.note ?? "").join("\n\n") || null;
  return null;
}

export async function updateCheck(): Promise<UpdateCheckResult> {
  configure();
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) return { kind: "none" };
    const info = result.updateInfo;
    return { kind: "available", update: { version: info.version, notes: notesOf(info.releaseNotes), date: info.releaseDate || null } };
  } catch (e) {
    return { kind: "failed", error: errorOf(e) };
  }
}

export async function updateDownload(emit: (event: HostEventBody) => void): Promise<UpdateDownloadResult> {
  configure();
  const progress = (p: { transferred: number; total: number }) => emit({ kind: "updateProgress", received: p.transferred, total: p.total || null });
  autoUpdater.on("download-progress", progress);
  try {
    await autoUpdater.downloadUpdate();
    return { kind: "ok" };
  } catch (e) {
    return { kind: "failed", error: errorOf(e) };
  } finally {
    autoUpdater.off("download-progress", progress);
  }
}

/** Quits into the downloaded update's installer, which starts the new version. */
export function updateInstall(): null {
  configure();
  // After this reply has gone back; quitting runs before-quit, which stops the core first.
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return null;
}
