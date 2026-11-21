import type { Event, WebContents } from "electron";
import { setTimeout as delay } from "node:timers/promises";

const LOAD_TIMEOUT_MS = 20_000;
const TRANSIENT_ERRORS = new Set([
  "ERR_CONNECTION_ABORTED",
  "ERR_CONNECTION_CLOSED",
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_TIMED_OUT",
  "ERR_NETWORK_CHANGED",
  "ERR_TIMED_OUT",
]);

async function attempt(contents: WebContents, url: string): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loaded!: () => void;
  const committed = new Promise<null>((resolve) => { loaded = () => resolve(null); });
  const didNavigate = (_event: Event, _url: string, status: number) => {
    // The sign-in form may already be usable while its images are still loading.
    if (status > 0) loaded();
  };
  contents.on("did-navigate", didNavigate);
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      resolve("ERR_TIMED_OUT");
      if (!contents.isDestroyed()) contents.stop();
    }, LOAD_TIMEOUT_MS);
  });
  try {
    const load = contents.loadURL(url).then(() => null, (error: unknown) => {
      // Electron's error message can contain the full SSO URL. Use only its code.
      const code = (error as { code?: unknown })?.code;
      return typeof code === "string" && /^ERR_[A-Z0-9_]+$/.test(code) ? code : "ERR_FAILED";
    });
    return await Promise.race([committed, load, timeout]);
  } finally {
    clearTimeout(timer);
    contents.removeListener("did-navigate", didNavigate);
  }
}

/** Retry the initial GET once, starting at the course site for a fresh SSO redirect. */
export async function loadSignInPage(contents: WebContents, url: string, hasLoadedPage: () => boolean): Promise<string | null> {
  let error = await attempt(contents, url);
  if (error && TRANSIENT_ERRORS.has(error) && !hasLoadedPage() && !contents.isDestroyed()) {
    await delay(500);
    if (!hasLoadedPage() && !contents.isDestroyed()) error = await attempt(contents, url);
  }
  return contents.isDestroyed() ? null : error;
}
