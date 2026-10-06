import { ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";

import { Icon } from "@/icons";
import type { AgentMessageCustom } from "@/runtime/agent-adapter";

/** A plain headline and the way out, per `ErrorCode` (src-tauri/src/agent.rs). */
const RECOVERY: Record<string, { title: string; action?: string }> = {
  noApiKey: { title: "Phaethon needs an API key", action: "Open Settings, at the bottom of the sidebar, to add your key." },
  apiKey: { title: "The API key was refused", action: "Open Settings to check or replace your key." },
  missingCli: { title: "Claude Code isn't installed" },
  notLoggedIn: { title: "Claude Code isn't logged in" },
  busy: { title: "Phaethon is still working on a reply", action: "Wait for it to finish, or stop it, then send again." },
  invalidSpace: { title: "This space can't be found", action: "Check that its folder still exists in your vault." },
  cli: { title: "Claude Code stopped with an error", action: "Send your message again." },
  provider: { title: "The model provider had a problem", action: "Wait a moment, then send your message again." },
  network: { title: "Phaethon couldn't reach the internet", action: "Check your connection, then send your message again." },
  declined: { title: "The model declined to answer", action: "Try asking in a different way." },
  storage: { title: "The conversation couldn't be saved", action: "Check that the space folder can be written to." },
  attachment: { title: "A file couldn't be attached", action: "Attach images, PDFs or text files within the size limits, then send again." },
  ipc: { title: "Phaethon couldn't reach its backend", action: "Quit and reopen Phaethon." },
};

/**
 * A failed reply: a quiet banner inside the message. role="alert", so it is
 * announced at once (the status region stays silent for errors).
 */
export function MessageError() {
  const code = useAuiState((s) => (s.message.metadata.custom as AgentMessageCustom | undefined)?.errorCode);
  const recovery = (code && RECOVERY[code]) || { title: "Phaethon couldn't finish this reply", action: "Send your message again." };
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        role="alert"
        className="flex w-full max-w-(--ph-measure) items-start gap-3 rounded-lg bg-danger-soft px-4 py-3 text-base text-ink"
      >
        <Icon name="error" className="mt-0.5 text-danger-ink" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="font-semibold text-danger-ink">{recovery.title}</p>
          <ErrorPrimitive.Message className="wrap-break-word" />
          {recovery.action && <p className="text-ink-secondary">{recovery.action}</p>}
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
