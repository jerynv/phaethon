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
      return { title: "Your API key wasn’t accepted", tone: "error", action: { label: "Check key", kind: "providers" } };
    case "billing":
      return { title: "Your provider account is out of credit", tone: "warning", action: { label: "Open AI & Models", kind: "providers" } };
    case "rateLimit":
      return { title: retryAfterSecs ? `Rate limited · try again in ${retryAfterSecs}s` : "Rate limited", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "unavailable":
      return { title: "This provider is temporarily unavailable", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "network":
      return { title: "Couldn’t connect to the provider", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "missingCli":
      return { title: "This coding agent isn’t installed yet", tone: "warning", action: { label: "Open AI & Models", kind: "agents" } };
    case "notLoggedIn":
      return { title: "Sign in to this coding agent to continue", tone: "warning", action: { label: "Open AI & Models", kind: "agents" } };
    case "cli":
      return { title: "The coding agent stopped unexpectedly", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "busy":
      return { title: "Still finishing the previous reply", tone: "warning", action: null };
    case "declined":
      return { title: "The model couldn’t answer this request", tone: "warning", action: { label: "Retry", kind: "retry" } };
    case "storage":
      return { title: "Couldn’t save this conversation", tone: "error", action: null };
    case "attachment":
      return { title: "One of your attachments couldn’t be read", tone: "error", action: null };
    case "invalidSpace":
      return { title: "Couldn’t open this space", tone: "error", action: null };
    case "badRequest":
      return { title: "The request couldn’t be sent", tone: "error", action: { label: "Retry", kind: "retry" } };
    case "ipc":
      return { title: "Lost connection to Phaethon", tone: "error", action: { label: "Retry", kind: "retry" } };
    default:
      return { title: "Something went wrong while replying", tone: "error", action: { label: "Retry", kind: "retry" } };
  }
}
