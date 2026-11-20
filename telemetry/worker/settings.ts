import type { TelemetryCategory } from "../../src/shared/telemetry.ts";
import type { Env } from "./bindings.ts";

export const MINUTE_MS = 60_000;
export const DAY_MS = 86_400_000;

/** Reports and traces hold user-written text; the other categories are metrics. */
export function isContentCategory(category: TelemetryCategory): boolean {
  return category === "reports" || category === "traces";
}

function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error("Invalid configuration");
  return number;
}

export function sessionTtlSeconds(env: Env): number {
  return integerSetting(env.SESSION_TTL_SECONDS, 28_800, 60, 86_400);
}

export function retentionDays(env: Env, category: TelemetryCategory): number {
  return isContentCategory(category)
    ? integerSetting(env.CONTENT_RETENTION_DAYS, 90, 1, 3650)
    : integerSetting(env.METADATA_RETENTION_DAYS, 365, 1, 3650);
}
