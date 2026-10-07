import { ActionBarPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { useContext, useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "@/icons";
import { openSettings } from "@/lib/open-settings";
import { cancelSpaceRun, type AgentMessageCustom } from "@/runtime/agent-adapter";

import { InlineCode, useAnnounce } from "./announce";
import { SpaceIdContext } from "./approval-card";
import { focusPaneComposer, usePane } from "./pane";

type Action = "settings" | "retry" | "stop";

/**
 * What went wrong and the way out, per `ErrorCode` (src-tauri/src/agent.rs),
 * plus "ipc" (the call to the backend itself failed). The title names the
 * problem; the body says what to do; actions do it where Phaethon can.
 */
type Recovery = {
  title: string;
  body: ReactNode | ((retryAfterSecs: number | undefined) => ReactNode);
  actions?: Action[];
  ownWords?: boolean;
};

/** "about 30 seconds", "about 2 minutes". */
function waitWords(secs: number): string {
  if (secs < 90) return `about ${Math.max(1, Math.round(secs))} second${Math.round(secs) === 1 ? "" : "s"}`;
  const min = Math.round(secs / 60);
  return `about ${min} minute${min === 1 ? "" : "s"}`;
}

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
    // The earlier reply may not be on screen (another conversation, or one
    // started before a restart), so this never points at "the reply above".
    title: "Phaethon is still working on an earlier reply in this space",
    body: "Stop it, then send your message again. Or wait for it to finish.",
    actions: ["stop", "retry"],
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
  billing: {
    title: "Your Anthropic account is out of credit",
    body: "Add credit to the Anthropic account your API key belongs to (in its Billing page), then send again. Phaethon itself never charges you.",
    actions: ["retry"],
  },
  rateLimit: {
    title: "Anthropic asked Phaethon to slow down",
    body: (secs) =>
      secs
        ? `Too many requests in a short time. Wait ${waitWords(secs)}, then send again.`
        : "Too many requests in a short time. Wait a minute, then send again.",
    actions: ["retry"],
  },
  unavailable: {
    title: "Anthropic’s service is busy or down",
    body: "This is on Anthropic’s side and usually passes within minutes. Send again in a little while.",
    actions: ["retry"],
  },
  badRequest: {
    title: "Anthropic couldn’t accept this message",
    body: "Something in the message or its files wasn’t accepted. The details say what. Try a shorter message or fewer files.",
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
 * A failed reply: a quiet banner inside the message. Only the title and what
 * to do are role="alert" (one alert, not nested, without the buttons), so they
 * are announced at once; the actions and the folded details follow. When part
 * of the reply had already arrived, the banner says the reply was cut off.
 */
export function MessageError() {
  const pane = usePane();
  const spaceId = useContext(SpaceIdContext);
  const announce = useAnnounce();
  const custom = useAuiState((s) => s.message.metadata.custom as AgentMessageCustom | undefined);
  const code = custom?.errorCode;
  const retryAfter = custom?.retryAfterSecs;
  const detail = useAuiState((s) =>
    s.message.status?.type === "incomplete" && s.message.status.reason === "error" && s.message.status.error != null
      ? String(s.message.status.error)
      : "",
  );
  const cutOff = useAuiState((s) => s.message.content.some((p) => p.type === "text" && p.text.trim() !== ""));
  const recovery = (code && RECOVERY[code]) || FALLBACK;
  const actions = recovery.actions ?? [];
  const body = typeof recovery.body === "function" ? recovery.body(retryAfter) : recovery.body;
  return (
    <MessagePrimitive.Error>
      <div
        data-error-code={code ?? "unknown"}
        // A transparent border: forced-colours mode draws it, so the banner keeps a boundary.
        className="flex w-full max-w-(--ph-measure) items-start gap-3 rounded-lg border border-transparent bg-danger-soft px-4 py-3 text-base text-ink"
      >
        <Icon name="error" className="mt-0.5 text-danger-ink" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div role="alert" className="flex flex-col gap-0.5">
            <p className="font-semibold text-danger-ink">{recovery.title}</p>
            {cutOff && (
              <p className="text-ink" data-error-cut-off="">
                The reply above is incomplete: it was cut off here.
              </p>
            )}
            <p className="text-ink">{recovery.ownWords && detail ? detail : body}</p>
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
                ) : a === "stop" ? (
                  <Button
                    key={a}
                    type="button"
                    size="default"
                    variant={i === 0 ? "default" : "outline"}
                    data-error-action="stop"
                    onClick={() => {
                      cancelSpaceRun(spaceId);
                      announce("Asked the earlier reply to stop. You can send again now.");
                    }}
                  >
                    <Icon name="stop" />
                    Stop the earlier reply
                  </Button>
                ) : (
                  <ActionBarPrimitive.Reload key={a} asChild>
                    <Button
                      type="button"
                      size="default"
                      variant={i === 0 ? "default" : "outline"}
                      data-error-action="retry"
                      // The banner goes away as the new reply starts; keep focus where the user writes.
                      onClick={() => focusPaneComposer(pane)}
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
      </div>
    </MessagePrimitive.Error>
  );
}
