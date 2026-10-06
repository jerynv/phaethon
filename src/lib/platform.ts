/**
 * Which desktop the app is running on, for the parts of the shell that follow
 * the platform's conventions (the macOS window buttons live inside our title
 * bar; Windows and Linux get our own minimize / maximize / close).
 */
export type Platform = "mac" | "windows" | "linux";

declare global {
  interface Window {
    /** Set by the UI preview harness to render another platform's chrome. */
    __PHAETHON_PLATFORM__?: Platform;
  }
}

function detect(): Platform {
  const forced = typeof window !== "undefined" ? window.__PHAETHON_PLATFORM__ : undefined;
  if (forced === "mac" || forced === "windows" || forced === "linux") return forced;
  if (typeof navigator === "undefined") return "mac";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${nav.userAgent ?? ""}`.toLowerCase();
  if (hint.includes("mac")) return "mac";
  if (hint.includes("win")) return "windows";
  return "linux";
}

let cached: Platform | null = null;

/** The current platform. Stable for the life of the page. */
export function platform(): Platform {
  cached ??= detect();
  return cached;
}

/**
 * Mark <html data-platform="..."> before the first render, so tokens that
 * depend on the platform (the title bar inset for the macOS window buttons)
 * are right on the first frame.
 */
export function initPlatform(): Platform {
  const p = platform();
  document.documentElement.dataset.platform = p;
  return p;
}

/** The platform's command key, for shortcuts and their labels. */
export function modKeyLabel(): string {
  return platform() === "mac" ? "⌘" : "Ctrl";
}
