/** The operating system, as the desktop preload reports it (else guessed from the browser). */
export function platform(): "darwin" | "win32" | "linux" | "other" {
  const p = typeof window === "undefined" ? undefined : window.phaethonDesktop?.platform;
  if (p === "darwin" || p === "win32" || p === "linux") return p;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "darwin";
  if (/Windows/.test(ua)) return "win32";
  if (/Linux/.test(ua)) return "linux";
  return "other";
}

export const isMac = (): boolean => platform() === "darwin";

/** The command key: ⌘ on a Mac, Ctrl elsewhere, as drawn and as aria-keyshortcuts names it. */
export const modKey = (): { cap: string; aria: string } => (isMac() ? { cap: "⌘", aria: "Meta" } : { cap: "Ctrl", aria: "Control" });

/** What the system file manager is called, for "Show in …". */
export function fileManagerName(): string {
  const p = platform();
  return p === "darwin" ? "Finder" : p === "win32" ? "File Explorer" : "Files";
}

/** "3 min ago", "Yesterday", "Mar 4": short and stable for list rows. */
export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const d = new Date(ms);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

/** "now", "4m", "3h", "2d", then "Nov 6": the compact form for list rows. */
export function compactTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short" });
}
