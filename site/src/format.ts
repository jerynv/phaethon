import type { Platform } from "./github.ts";

export const platformName: Record<Platform, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

export function size(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1_000))} KB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Formats a release label: "0.4.2" -> "v0.4.2", "nightly" -> "Nightly". */
export function formatVersion(version: string): string {
  if (/^nightly$/i.test(version)) return "Nightly";
  return /^\d/.test(version) ? `v${version}` : version;
}

/** "Nov 16, 2026" without `now` (the build, and the first paint that matches it); "3 hours ago" with it. */
export function when(iso: string, now?: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  if (now === undefined) return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const s = Math.trunc((t - now) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60]];
  for (const [unit, secs] of steps) if (Math.abs(s) >= secs) return rtf.format(Math.trunc(s / secs), unit);
  return "just now";
}

/** The visitor's platform, for the hero's button. Phones and tablets get the Mac build, since there's no mobile app. */
export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  const hint = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? "";
  if (/win/i.test(hint) || /Windows/.test(ua)) return "windows";
  if (/linux|chrome os/i.test(hint) || (/Linux|X11|CrOS/.test(ua) && !/Android/.test(ua))) return "linux";
  return "mac";
}
