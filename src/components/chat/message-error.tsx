import { ActionBarPrimitive, MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

import { CONSOLE_BILLING_URL } from "@/components/settings/api-key";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { Icon } from "@/icons";
import { cliOf, getSettings, SETTINGS_CHANGED_EVENT, type ProviderId, type SettingsChangedDetail } from "@/lib/backend";
import { openSettings } from "@/lib/open-settings";
import { modelOf, providerName, splitRef, useModels } from "@/lib/space-model";
import { cn } from "@/lib/utils";
import { cancelSpaceRun, type AgentMessageCustom } from "@/runtime/agent-adapter";

import { InlineCode, useAnnounce } from "./announce";
import { SpaceIdContext } from "./approval-card";
import { revealCard } from "./card-arrival";
import { focusPaneComposer, paneShown, usePane } from "./pane";

type Action = "settings" | "retry" | "stop" | "billing" | "setup";

/** True while the first-run setup card sits under the conversation (no key yet). Provided by Thread. */
export const SetupBelowContext = createContext(false);

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
    body: "Check that the space’s folder is still in your Phaethon folder, or choose another space.",
  },
  cli: {
    title: "Claude Code stopped with an error",
    body: "Send your message again. If it keeps failing, the details say what Claude Code reported.",
    actions: ["retry"],
  },
  billing: {
    title: "Your Anthropic account is out of credit",
    body: "Add credit to the Anthropic account your API key belongs to (in its Billing page), then send again. Phaethon itself never charges you.",
    actions: ["billing", "retry"],
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

/**
 * The recovery for a provider other than Anthropic: its name in the words, no
 * Anthropic console, and the core's own message where it says what to do
 * (which key, which model, how to start a server on this computer).
 */
function forProvider(r: Recovery, code: string | undefined, id: ProviderId, name: string, local: boolean): Recovery {
  if (id === "anthropic") return r;
  switch (code) {
    case "noApiKey":
      return { title: "Phaethon can’t reply yet", body: "Finish setting up the model provider in Settings, then send again.", actions: ["settings", "retry"], ownWords: true };
    case "apiKey":
      return { ...r, body: `${name} didn’t accept the key saved in Settings. Check it or paste a new one, then send again.` };
    case "billing":
      return {
        title: `Your ${name} account is out of credit`,
        body: `Add credit to the ${name} account your API key belongs to, then send again. Phaethon itself never charges you.`,
        actions: ["retry"],
      };
    case "rateLimit":
      return { ...r, title: `${name} asked Phaethon to slow down` };
    case "unavailable":
      return local
        ? { title: `${name} had a problem`, body: "Check that it’s running and the model is loaded, then send again.", actions: ["retry"] }
        : { ...r, title: `${name}’s service is busy or down`, body: `This is on ${name}’s side and usually passes within minutes. Send again in a little while.` };
    case "badRequest":
      return { ...r, title: `${name} couldn’t accept this message`, ownWords: true };
    case "network":
      return local || id === "custom" ? { title: `Phaethon couldn’t reach ${name}`, body: `Check that it’s running and its address in Settings is right, then send again.`, actions: ["retry", "settings"], ownWords: true } : r;
    default:
      return r;
  }
}

/**
 * The recovery when a CLI other than Claude Code answers: its name in the
 * words, how to install it, and signing in to it in Settings (Codex and Gemini
 * CLI run with a setup of their own for the Phaethon folder, so signing in in
 * a terminal would sign in the wrong one). The core's own message stays under
 * Details.
 */
function forCli(r: Recovery, code: string | undefined, cli: ReturnType<typeof cliOf>): Recovery {
  if (!cli || cli.id === "claude") return r;
  switch (code) {
    case "missingCli":
      return {
        title: `${cli.name} isn’t installed`,
        body: (
          <>
            Install {cli.name}, then sign in to it in Settings › Assistant and send again. Or choose another assistant in Settings.
          </>
        ),
        actions: ["settings", "retry"],
      };
    case "notLoggedIn":
      return {
        title: `${cli.name} isn’t signed in`,
        body: `Sign in to ${cli.name} for this Phaethon folder in Settings › Assistant, then send again. Or choose another assistant there.`,
        actions: ["settings", "retry"],
      };
    case "cli":
      return { title: `${cli.name} stopped with an error`, body: `Send your message again. If it keeps failing, the details say what ${cli.name} reported.`, actions: ["retry", "settings"] };
    default:
      return r;
  }
}

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
  const setupBelow = useContext(SetupBelowContext);
  const textId = useId();
  const keySaved = useKeySavedSince(code === "noApiKey" || code === "apiKey");
  const models = useModels();
  const provider = splitRef(modelOf(models, spaceId).id).provider;
  const local = !!models.providers.find((p) => p.id === provider)?.local;
  let recovery = forCli(forProvider((code && RECOVERY[code]) || FALLBACK, code, provider, providerName(provider, models), local), code, cliOf(models.backend));
  if (keySaved) recovery = KEY_SAVED;
  else if (code === "noApiKey" && setupBelow) recovery = NO_KEY_SETUP_BELOW;
  const actions = recovery.actions ?? [];
  const body = typeof recovery.body === "function" ? recovery.body(retryAfter) : recovery.body;
  return (
    <MessagePrimitive.Error>
      <ErrorBanner code={code} resolved={keySaved}>
        <Icon name={keySaved ? "check" : "error"} className={cn("mt-0.5", keySaved ? "text-success-ink" : "text-danger-ink")} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          {/* Once the key is saved the problem is gone: the words change without being announced (a
              new element, not a live one), and Send again, which then takes focus when the key was saved
              right here, is described by them, so they are said once. */}
          <div key={keySaved ? "saved" : "alert"} id={textId} role={keySaved ? undefined : "alert"} className="flex flex-col gap-0.5">
            <p className={cn("font-semibold", keySaved ? "text-success-ink" : "text-danger-ink")} data-error-title="">
              {recovery.title}
            </p>
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
                ) : a === "billing" ? (
                  <Button key={a} asChild size="default" variant={i === 0 ? "default" : "outline"} data-error-action="billing">
                    <a href={CONSOLE_BILLING_URL} target="_blank" rel="noreferrer">
                      Open Billing
                      <span className="sr-only"> in the Anthropic console (opens in your browser)</span>
                    </a>
                  </Button>
                ) : a === "setup" ? (
                  <Button
                    key={a}
                    type="button"
                    size="default"
                    variant={i === 0 ? "default" : "outline"}
                    data-error-action="setup"
                    onClick={() => {
                      const field = pane?.rootRef.current?.querySelector<HTMLElement>("[data-setup-key]");
                      field?.scrollIntoView({ block: "center" });
                      field?.focus({ preventScroll: true });
                    }}
                  >
                    <Icon name="key" />
                    Set up now
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
                      aria-describedby={keySaved ? textId : undefined}
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
          {detail && !recovery.ownWords && !keySaved && <ErrorDetails text={detail} />}
        </div>
      </ErrorBanner>
    </MessagePrimitive.Error>
  );
}

/** The no-key error once a key has been saved: the problem is gone, so it says so and offers Send again. */
const KEY_SAVED: Recovery = {
  title: "Your key is saved",
  body: "Send your message again and Phaethon will answer it.",
  actions: ["retry"],
};

/** The no-key error while the setup card is right under it: the way out is there, not in Settings. */
const NO_KEY_SETUP_BELOW: Recovery = {
  title: "Phaethon needs an API key to reply",
  body: "Paste your Anthropic API key in the setup below, then send your message again. Your message is kept.",
  actions: ["setup", "settings"],
};

/**
 * True once an API key has been saved (anywhere: Settings, or the setup card)
 * after this error appeared, so a key error can say it is solved. Only
 * listens while `watch` (a key error) is true.
 */
function useKeySavedSince(watch: boolean): boolean {
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!watch) return;
    let live = true;
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<SettingsChangedDetail>).detail?.what !== "key") return;
      getSettings().then(
        (s) => live && setSaved(s.providerReady ?? s.hasAnthropicKey),
        () => {},
      );
    };
    window.addEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    return () => {
      live = false;
      window.removeEventListener(SETTINGS_CHANGED_EVENT, onChanged);
    };
  }, [watch]);
  return watch && saved;
}

/**
 * The banner around a failed reply. When it appears in the space on screen,
 * the conversation scrolls so its title is in view (the log otherwise sticks
 * to the bottom, and in a short window the title would sit above the fold).
 */
function ErrorBanner({ code, resolved, children }: { code: string | undefined; resolved: boolean; children: ReactNode }) {
  const pane = usePane();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // After the log has laid out (and followed its end), then placed: twice, as the log's
    // own stick-to-bottom may run in the frame after this one.
    let frame = requestAnimationFrame(function place() {
      const el = ref.current;
      if (!el?.isConnected || !paneShown(pane)) return;
      revealCard(el);
      frame = requestAnimationFrame(() => el.isConnected && revealCard(el));
    });
    return () => cancelAnimationFrame(frame);
  }, [pane]);
  return (
    <div
      ref={ref}
      data-error-code={code ?? "unknown"}
      data-error-resolved={resolved ? "" : undefined}
      // A transparent border: forced-colours mode draws it, so the banner keeps a boundary.
      className={cn(
        "flex w-full max-w-(--ph-measure) items-start gap-3 rounded-lg border border-transparent px-4 py-3 text-base text-ink",
        resolved ? "bg-success-soft" : "bg-danger-soft",
      )}
    >
      {children}
    </div>
  );
}
