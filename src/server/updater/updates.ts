import { UPDATE_FEED, type UpdateCheckResult, type UpdateDownloadResult, type UpdateError, type UpdateFound } from "#shared/host.ts";
import { isDevBuild } from "../diagnostics/build.ts";
import { host } from "../host.ts";
import type { Channel } from "../rpc/channel.ts";

/**
 * In-app updates from the project's GitHub releases. electron-updater runs in
 * Electron's main process (it has to replace the app and restart it); the core
 * keeps what Settings › About shows and talks to main through host ops, so
 * the renderer names no address, key or file and gets the same commands and
 * Channel events as before (`update_state`, `update_check`, `update_install`).
 *
 * What protects a person:
 * - The feed is fixed in the build (UPDATE_FEED, https only).
 * - electron-updater checks each download's sha512 from the release's
 *   latest*.yml before installing; on Windows it also checks the installer's
 *   code-signing publisher when the app is signed, and macOS's updater only
 *   accepts a build signed like the running app.
 * - No downgrades and no prereleases; one check or install at a time; a
 *   development build checks but never installs over itself.
 *
 * Phaethon 0.1.x (Tauri) installs read `latest.json` with a minisign key and
 * can't install an Electron build: they need one manual install of 0.2.
 */

/** Wait after launch before the quiet check, so it never competes with startup. */
export const LAUNCH_DELAY_MS = 20_000;
/** Release notes longer than this are cut (they are shown, never run). */
export const NOTES_MAX_CHARS = 20_000;
/** The pause between "installed" and the restart, so it can be said first. */
export const RESTART_PAUSE_MS = 1500;
/** How long to wait for the app to quit into its installer before saying it didn't. */
export const QUIT_WAIT_MS = 60_000;

export type Setup = { ready: true; source: string } | { ready: false; reason: string };

export type Status =
  | { state: "notSetUp"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "upToDate"; checkedAt: number }
  | { state: "available"; version: string; notes: string | null; date: string | null }
  | { state: "error"; message: string; during: "check" | "launch" };

export type UpdateView = { currentVersion: string; source: string | null; canInstall: boolean; status: Status };

export type InstallEvent = { kind: "downloading"; received: number; total: number | null } | { kind: "installing" } | { kind: "restarting" };

export const NO_DESKTOP = "Updates come with the Phaethon desktop app.";

type Feed = { provider: "github"; owner: string; repo: string } | { provider: "generic"; url: string };

/** Whether a feed is set up: a GitHub repository, or an https address without placeholders. */
export function setupOf(feed: Feed | null | undefined): Setup {
  if (!feed) return { ready: false, reason: "This build has no update settings." };
  if (feed.provider === "github") {
    const part = /^[A-Za-z0-9_.-]+$/;
    if (!feed.owner || !feed.repo) return { ready: false, reason: "This build doesn’t name a place to get updates from." };
    if (!part.test(feed.owner) || !part.test(feed.repo)) return { ready: false, reason: "This build names a place to get updates from that isn’t a secure (https) address." };
    return { ready: true, source: `${feed.owner}/${feed.repo}` };
  }
  if (!feed.url) return { ready: false, reason: "This build doesn’t name a place to get updates from." };
  let url: URL;
  try {
    url = new URL(feed.url);
  } catch {
    return { ready: false, reason: "This build names a place to get updates from that isn’t a secure (https) address." };
  }
  if (url.protocol !== "https:" || !url.hostname || feed.url.includes("<")) {
    return { ready: false, reason: "This build names a place to get updates from that isn’t a secure (https) address." };
  }
  return { ready: true, source: url.hostname };
}

/** Release notes as plain text: GitHub sends them as HTML. Tags go, block ends become line breaks. */
export function notesText(notes: string | null | undefined): string | null {
  if (notes == null) return null;
  const text = notes
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<\/\s*(p|div|li|h[1-6]|ul|ol|pre|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n");
  return text;
}

/** Release notes trimmed, empty as none, and cut when very long. */
export function cleanNotes(notes: string | null | undefined): string | null {
  const t = notes?.trim();
  if (!t) return null;
  const chars = Array.from(t);
  if (chars.length <= NOTES_MAX_CHARS) return t;
  return chars.slice(0, NOTES_MAX_CHARS).join("").trimEnd() + "…";
}

export const SIGNATURE_WORDS =
  "The update didn’t pass Phaethon’s signature check, so it wasn’t installed and nothing was changed. It may have been altered on the way. Try again later, or download Phaethon from its releases page yourself.";
export const NETWORK_WORDS = "Phaethon couldn’t reach the place updates come from. Check your internet connection, then try again.";
export const NO_RELEASE_WORDS = "Phaethon couldn’t find a release it can read there. No release may have been published yet.";
export const NO_TARGET_WORDS = "The newest release has no build for this computer yet.";
export const INSECURE_WORDS = "Phaethon only takes updates over a secure (https) connection.";
export const PERMISSION_WORDS =
  "Phaethon doesn’t have permission to replace itself where it’s installed. Move it to your Applications folder, or download the new version and install it yourself.";

/** What went wrong, said to a person. Signature and checksum failures are said plainly: nothing was installed. */
export function words(e: UpdateError): string {
  const code = e.code ?? "";
  const m = e.message ?? "";
  if (code === "ERR_UPDATER_INVALID_SIGNATURE" || code === "ERR_CHECKSUM_MISMATCH" || /sha512 checksum mismatch|code signature|did not pass validation|not signed/i.test(m)) {
    return SIGNATURE_WORDS;
  }
  if (/^(ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ESOCKETTIMEDOUT)$/.test(code) || /net::ERR_|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|socket hang up/.test(m)) {
    return NETWORK_WORDS;
  }
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" || code === "ERR_UPDATER_ASSET_NOT_FOUND" || code === "ERR_UPDATER_NO_FILES_PROVIDED" || code === "ERR_UPDATER_ZIP_FILE_NOT_FOUND") {
    return NO_TARGET_WORDS;
  }
  if (
    code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND" ||
    code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" ||
    code === "ERR_UPDATER_RELEASE_NOT_FOUND" ||
    code === "ERR_UPDATER_INVALID_RELEASE_FEED" ||
    code === "ERR_UPDATER_INVALID_UPDATE_INFO" ||
    code === "ERR_UPDATER_INVALID_VERSION" ||
    e.statusCode === 404
  ) {
    return NO_RELEASE_WORDS;
  }
  if (/insecure|https? is required|ERR_INSECURE/i.test(m)) return INSECURE_WORDS;
  if (code === "EACCES" || code === "EPERM" || /EACCES|EPERM|permission denied/i.test(m)) return PERMISSION_WORDS;
  return `The update couldn’t be installed: ${m.replace(/\.+$/, "")}. Nothing was changed; you can try again.`;
}

/** About a hundred progress events at most, so the channel isn't flooded. */
export function progressThrottle(say: (received: number, total: number | null) => void): (received: number, total: number | null) => void {
  let said = 0;
  return (received, total) => {
    const step = total ? Math.max(Math.floor(total / 100), 1) : 256 * 1024;
    if (received - said >= step || (total !== null && received === total)) {
      said = received;
      say(received, total);
    }
  };
}

// ---- State ------------------------------------------------------------------

const DEFAULT_FEED: Feed = UPDATE_FEED;

let feed: Feed | null = DEFAULT_FEED;
let status: Status | undefined;
let found: UpdateFound | null = null;
let busy = false;
let launchTimer: NodeJS.Timeout | undefined;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pause: (ms: number) => Promise<unknown> = sleep;

function setup(): Setup {
  if (!host().available) return { ready: false, reason: NO_DESKTOP };
  return setupOf(feed);
}

function current(): Status {
  if (status) return status;
  const s = setup();
  return s.ready ? { state: "idle" } : { state: "notSetUp", reason: s.reason };
}

export function view(): UpdateView {
  const s = setup();
  const st = !s.ready ? { state: "notSetUp" as const, reason: s.reason } : current();
  return { currentVersion: process.env.PHAETHON_VERSION ?? "0.0.0-dev", source: s.ready ? s.source : null, canInstall: !isDevBuild(), status: st };
}

/** Ask the feed once. A failure is kept as an error status, in words. */
export async function runCheck(during: "check" | "launch"): Promise<void> {
  if (!setup().ready || busy) return;
  busy = true;
  status = { state: "checking" };
  try {
    let result: UpdateCheckResult;
    try {
      result = await host().call<UpdateCheckResult>({ op: "updateCheck" });
    } catch (e) {
      result = { kind: "failed", error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (result.kind === "available") {
      found = result.update;
      status = { state: "available", version: found.version, notes: cleanNotes(notesText(found.notes)), date: found.date ? found.date.slice(0, 10) : null };
    } else if (result.kind === "none") {
      found = null;
      status = { state: "upToDate", checkedAt: Date.now() };
    } else {
      status = { state: "error", message: words(result.error), during };
    }
  } finally {
    busy = false;
  }
}

/** Download the update the last check found, verify it, install it and restart. */
export async function install(onEvent: Channel<InstallEvent>): Promise<void> {
  if (isDevBuild()) throw new Error("This is a development build of Phaethon, so it doesn’t install updates over itself.");
  if (busy) throw new Error("Phaethon is already checking for or installing an update.");
  if (!found || !host().available) throw new Error("There’s no update to install. Check for updates first.");
  busy = true;
  try {
    const progress = progressThrottle((received, total) => onEvent.send({ kind: "downloading", received, total }));
    const off = host().on((event) => {
      if (event.kind === "updateProgress") progress(event.received, event.total);
    });
    let result: UpdateDownloadResult;
    try {
      result = await host().call<UpdateDownloadResult>({ op: "updateDownload" });
    } catch (e) {
      result = { kind: "failed", error: { message: e instanceof Error ? e.message : String(e) } };
    } finally {
      off();
    }
    // A failed install keeps the update on offer (About shows it again); the failure goes back to the button.
    if (result.kind === "failed") throw new Error(words(result.error));
    onEvent.send({ kind: "installing" });
    onEvent.send({ kind: "restarting" });
    await pause(RESTART_PAUSE_MS);
    try {
      await host().call({ op: "updateInstall" });
    } catch (e) {
      throw new Error(`The update couldn’t be installed: it stopped unexpectedly (${e instanceof Error ? e.message : String(e)}). You can try again.`);
    }
    // The app quits from here, so on success this never resolves for the renderer.
    await pause(QUIT_WAIT_MS);
    throw new Error("The update couldn’t be installed: it stopped unexpectedly (Phaethon didn’t restart). You can try again.");
  } finally {
    busy = false;
  }
}

export function scheduleLaunchCheck(): void {
  if (!setup().ready) return;
  launchTimer = setTimeout(() => void runCheck("launch"), LAUNCH_DELAY_MS);
  launchTimer.unref();
}

export function cancelLaunchCheck(): void {
  clearTimeout(launchTimer);
  launchTimer = undefined;
}

/** Tests: start over, optionally with another feed and no restart pause. */
export function resetForTest(options: { feed?: Feed | null; pause?: (ms: number) => Promise<unknown> } = {}): void {
  feed = options.feed === undefined ? DEFAULT_FEED : options.feed;
  pause = options.pause ?? sleep;
  status = undefined;
  found = null;
  busy = false;
  cancelLaunchCheck();
}
