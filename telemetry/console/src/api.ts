import type { TelemetryCategory } from "../../../src/shared/telemetry";

export { TELEMETRY_CATEGORIES, type TelemetryCategory } from "../../../src/shared/telemetry";

export const CATEGORY_LABELS: Record<TelemetryCategory, string> = {
  usage: "Usage",
  diagnostics: "Diagnostics",
  reports: "Testing reports",
  traces: "Chat traces",
};

export type StaffRole = "owner" | "viewer";
export type Session = { email: string; role: StaffRole };
export const roleName = (role: StaffRole) => (role === "owner" ? "Super admin" : "Viewer");
export type StaffMember = { id: string; email: string; username: string; role: StaffRole; disabled: boolean };
export type AccessChange = {
  id: string;
  actorEmail: string;
  targetEmail: string;
  action: string;
  createdAt: string;
};

export type Overview = {
  totals: Record<TelemetryCategory, number>;
  days: { day: string; count: number }[];
  events: { event: string; count: number }[];
  outcomes: { outcome: string; count: number }[];
};
export type EventSummary = {
  id: string;
  category: TelemetryCategory;
  event: string;
  receivedAt: string;
  sentAt: string;
  appVersion: string;
  platform: string;
};
export type EventPage = { items: EventSummary[]; nextCursor: string | null };
export type Detail = {
  envelope: unknown;
  payload: {
    category: TelemetryCategory;
    event: string;
    data: { text?: string; messages?: { role: string; text: string }[] };
  };
  receivedAt: string;
  verification: string;
};

export class SessionExpired extends Error {}
export class AccessDenied extends Error {}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) throw new SessionExpired("Sign in to continue.");
  if (!response.ok) {
    const ErrorType = response.status === 403 ? AccessDenied : Error;
    throw new ErrorType(await failureMessage(response));
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

/** Shows the worker's own explanation only for statuses where it writes one for people. */
async function failureMessage(response: Response): Promise<string> {
  if ([400, 403, 409].includes(response.status)) {
    const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (typeof detail?.error === "string" && detail.error.length <= 200) return detail.error;
  }
  if (response.status === 429) return "Too many attempts. Try again shortly.";
  return "Couldn’t complete the request. Try again.";
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function eventName(name: string): string {
  if (name === "turn_completed") return "Reply attempt finished";
  return name.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

export const formatCount = new Intl.NumberFormat().format;

export function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
