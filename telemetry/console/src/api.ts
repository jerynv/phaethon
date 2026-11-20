export type Category = "usage" | "diagnostics" | "reports" | "traces";
export const CATEGORIES: Category[] = ["usage", "diagnostics", "reports", "traces"];
export const LABELS: Record<Category, string> = { usage: "Usage", diagnostics: "Diagnostics", reports: "Testing reports", traces: "Chat traces" };
export type StaffRole = "owner" | "viewer";
export type Session = { email: string; role: StaffRole };
export type StaffMember = { id: string; email: string; username: string; role: StaffRole; disabled: boolean };
export type AccessChange = { id: string; actorEmail: string; targetEmail: string; action: string; createdAt: string };
export type Overview = {
  totals: Record<Category, number>;
  days: { day: string; count: number }[];
  events: { event: string; count: number }[];
  outcomes: { outcome: string; count: number }[];
};
export type EventSummary = { id: string; category: Category; event: string; receivedAt: string; sentAt: string; appVersion: string; platform: string };
export type EventPage = { items: EventSummary[]; nextCursor: string | null };
export type Detail = {
  envelope: unknown;
  payload: { category: Category; event: string; data: { text?: string; messages?: { role: string; text: string }[] } };
  receivedAt: string;
  verification: string;
};

export class SessionExpired extends Error {}
export class AccessDenied extends Error {}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { ...options, credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json", ...options.headers } });
  if (response.status === 401) throw new SessionExpired("Sign in to continue.");
  if (!response.ok) {
    const detail = [400, 403, 409].includes(response.status) ? await response.json().catch(() => null) as { error?: unknown } | null : null;
    const ErrorType = response.status === 403 ? AccessDenied : Error;
    throw new ErrorType(typeof detail?.error === "string" && detail.error.length <= 200 ? detail.error : response.status === 429 ? "Too many attempts. Try again shortly." : "Couldn’t complete the request. Try again.");
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function eventName(name: string): string {
  if (name === "turn_completed") return "Reply attempt finished";
  return name.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}
