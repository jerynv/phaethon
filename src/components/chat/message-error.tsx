import { ActionBarPrimitive, ErrorPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import type { AgentMessageCustom } from "@/runtime/agent-adapter";

import { InlineCode, useAnnounce } from "./announce";
import { focusComposer } from "./approval-card";

type Action = "settings" | "retry";

/**
 * What went wrong and the way out, per `ErrorCode` (src-tauri/src/agent.rs),
 * plus "ipc" (the call to the backend itself failed). The title names the
 * problem; the body says what to do; actions do it where Phaethon can.
 */
type Recovery = { title: string; body: ReactNode; actions?: Action[]; ownWords?: boolean };

const RECOVERY: Record<string, Recovery> = {
  noApiKey: {
    title: "Phaethon needs an API key to reply",
    body: "Add your Anthropic API key in Settings, then send your message again.",
    actions: ["settings", "retry"],
  },
  apiKey: {
    title: "Your API key was refused",
    body: "The provider didn’t accept the key saved in Settings. Check it or paste a new one, then send again.",
    actions: ["settings", "retry"],
  },
  missingCli: {
    title: "Claude Code isn’t installed",
    body: (
      <>
        Install Claude Code, then run <InlineCode text="`claude`" /> once in a terminal to log in and send again. Or
        switch to Phaethon’s own agent in Settings.
      </>
    ),
    actions: ["settings", "retry"],
  },
  notLoggedIn: {
    title: "Claude Code isn’t logged in",
    body: (
      <>
        Run <InlineCode text="`claude`" /> once in a terminal and log in, then send again. Or switch to Phaethon’s own
        agent in Settings.
      </>
    ),
    actions: ["retry", "settings"],
  },
  busy: {
    title: "This space is still answering",
    body: "Wait for the reply above to finish, or stop it, then send again.",
    actions: ["retry"],
  },
  invalidSpace: {
    title: "This space’s folder can’t be found",
    body: "Check that the folder still exists in your vault, or choose another space.",
  },
  cli: {
    title: "Claude Code stopped with an error",
    body: "Send your message again. If it keeps failing, the details say what Claude Code reported.",
    actions: ["retry"],
  },
  provider: {
    title: "The model provider had a problem",
    body: "This is usually brief. Wait a moment, then send again.",
    actions: ["retry"],
  },
  network: {
    title: "Phaethon couldn’t reach the internet",
    body: "Check your connection, then send again.",
    actions: ["retry"],
  },
  declined: {
    title: "The model declined to answer",
    body: "Try asking in a different way.",
  },
  storage: {
    title: "The conversation couldn’t be saved",
    body: "Nothing was sent. Check that the space’s folder can be written to, then send again.",
    actions: ["retry"],
  },
  attachment: {
    title: "A file couldn’t be attached",
    body: "Attach images, PDFs or text files within the size limits, then send again.",
    // The backend names the file and the limit in plain words; that is the useful part.
    ownWords: true,
  },
  ipc: {
    title: "Phaethon couldn’t reach its own backend",
    body: "Quit and reopen Phaethon. If it keeps happening, copy the details and report it.",
  },
};
const FALLBACK: Recovery = { title: "Phaethon couldn’t finish this reply", body: "Send your message again.", actions: ["retry"] };

/** The backend's own words, folded away: useful to report, not the headline. */
function ErrorDetails({ text }: { text: string }) {
  const announce = useAnnounce();
  const { isCopied, copyToClipboard } = useCopyToClipboard({ copiedDuration: 2000 });
  const said = useRef(false);
  useEffect(() => {
    if (isCopied && !said.current) announce("Details copied.");
    said.current = isCopied;
  }, [isCopied, announce]);
  return (
    <Details>
      <p className="font-mono wrap-anywhere text-ink" data-error-detail>
        <InlineCode text={text} />
      </p>
      <Button type="button" variant="ghost" size="xs" className="-ms-2" onClick={() => copyToClipboard(text)}>
        <Icon name={isCopied ? "check" : "copy"} />
        {isCopied ? "Copied" : "Copy"}
        <span className="sr-only"> details</span>
      </Button>
    </Details>
  );
}

/**
 * A failed reply: a quiet banner inside the message. The title and what to do
 * are role="alert", so they are announced at once (the status region stays
 * silent for errors); the actions and folded details follow.
 */
export function MessageError() {
  const code = useAuiState((s) => (s.message.metadata.custom as AgentMessageCustom | undefined)?.errorCode);
  const detail = useAuiState((s) =>
    s.message.status?.type === "incomplete" && s.message.status.reason === "error" && s.message.status.error != null
      ? String(s.message.status.error)
      : "",
  );
  const recovery = (code && RECOVERY[code]) || FALLBACK;
  const actions = recovery.actions ?? [];
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root
        data-error-code={code ?? "unknown"}
        // A transparent border: forced-colours mode draws it, so the banner keeps a boundary.
        className="flex w-full max-w-(--ph-measure) items-start gap-3 rounded-lg border border-transparent bg-danger-soft px-4 py-3 text-base text-ink"
      >
        <Icon name="error" className="mt-0.5 text-danger-ink" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div role="alert" className="flex flex-col gap-0.5">
            <p className="font-semibold text-danger-ink">{recovery.title}</p>
            <p className="text-ink">{recovery.ownWords && detail ? detail : recovery.body}</p>
          </div>
          {actions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {actions.map((a, i) =>
                a === "settings" ? (
                  <Button
                    key={a}
                    type="button"
                    size="default"
                    variant={i === 0 ? "default" : "outline"}
                    data-error-action="settings"
                    onClick={() => openSettings("agent")}
                  >
                    <Icon name="settings" />
                    Open Settings
                  </Button>
                ) : (
                  <ActionBarPrimitive.Reload key={a} asChild>
                    <Button
                      type="button"
                      size="default"
                      variant={i === 0 ? "default" : "outline"}
                      data-error-action="retry"
                      // The banner goes away as the new reply starts; keep focus where the user writes.
                      onClick={() => focusComposer()}
                    >
                      <Icon name="retry" />
                      Send again
                    </Button>
                  </ActionBarPrimitive.Reload>
                ),
              )}
            </div>
          )}
          {detail && !recovery.ownWords && <ErrorDetails text={detail} />}
        </div>
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}
