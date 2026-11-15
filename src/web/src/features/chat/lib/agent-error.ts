import type { ErrorCode } from "#shared/agent.ts";

/**
 * A failed reply in words: a one-line title, how serious, and the one action
 * that would fix it (docs/UI-REBUILD.md › Errors). The core's message is
 * shown under the title, clamped.
 */
export type ErrorView = {
  title: string;
  tone: "error" | "warning";
  action: { label: string; kind: "providers" | "agents" | "retry" | "continue" } | null;
};

export function describeAgentError(code: ErrorCode | "ipc", retryAfterSecs?: number): ErrorView {
  switch (code) {
    case "noApiKey":
      return { title: "This model needs an API key", tone: "warning", action: { label: "Add a key", kind: "providers" } };
    case "apiKey":
      return { title: "The API key was refused", tone: "error", action: { label: "Check the key", kind: "providers" } };
    case "billing":
      return { title: "The provider account needs credit", tone: "warning", action: { label: "Open providers", kind: "providers" } };
    case "rateLimit":
      return { title: retryAfterSecs ? `Rate limited · try again in ${retryAfterSecs}s` : "Rate limited", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "unavailable":
      return { title: "The provider is unavailable right now", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "network":
      return { title: "Couldn’t reach the provider", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "missingCli":
      return { title: "The coding agent isn’t installed", tone: "warning", action: { label: "Open coding agents", kind: "agents" } };
    case "notLoggedIn":
      return { title: "The coding agent isn’t signed in", tone: "warning", action: { label: "Open coding agents", kind: "agents" } };
    case "cli":
      return { title: "The coding agent stopped", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "busy":
      return { title: "Still answering the previous message", tone: "warning", action: null };
    case "declined":
      return { title: "The model declined to answer", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "storage":
      return { title: "Couldn’t save the conversation", tone: "error", action: null };
    case "attachment":
      return { title: "An attachment couldn’t be used", tone: "error", action: null };
    case "invalidSpace":
      return { title: "This space can’t be used", tone: "error", action: null };
    case "badRequest":
      return { title: "The provider refused the request", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "ipc":
      return { title: "Lost the connection to Phaethon’s core", tone: "error", action: { label: "Retry", kind: "retry" } };
    default:
      return { title: "The reply failed", tone: "error", action: { label: "Retry", kind: "retry" } };
  }
}
