import { ChevronRightIcon, CircleAlertIcon, RotateCcwIcon, SettingsIcon, SquareIcon } from "lucide-react";
import { useId } from "react";

import type { ErrorCode } from "#shared/agent.ts";
import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import type { SettingsView } from "../api";
import { CopyButton } from "./CopyButton";

type Action = "settings" | "agents" | "retry" | "stop";
type Recovery = { title: string; body: string; actions: Action[]; ownWords?: boolean };

const CLI_NAMES: Record<string, string> = { "claude-cli": "Claude Code", "codex-cli": "Codex", "gemini-cli": "Gemini CLI" };

function waitWords(secs: number): string {
  if (secs < 90) return `about ${Math.max(1, Math.round(secs))} second${Math.round(secs) === 1 ? "" : "s"}`;
  const min = Math.round(secs / 60);
  return `about ${min} minute${min === 1 ? "" : "s"}`;
}

/**
 * What went wrong and the way out, per error code: the title names the
 * problem, the body says what to do, the buttons do it where Phaethon can.
 */
export function recoveryFor(code: ErrorCode | "ipc" | undefined, settings: SettingsView | null, retryAfterSecs?: number): Recovery {
  const provider = settings?.providers.find((p) => p.id === settings.provider);
  const name = provider?.name ?? "The model provider";
  const local = !!provider?.local;
  const cli = settings ? CLI_NAMES[settings.backend] : undefined;
  switch (code) {
    case "noApiKey":
      return { title: "Phaethon can’t reply yet", body: `Add a key for ${name} in Settings › Assistant, then send your message again.`, actions: ["settings", "retry"] };
    case "apiKey":
      return { title: "Your API key was refused", body: `${name} didn’t accept the key saved in Settings. Check it or paste a new one, then send again.`, actions: ["settings", "retry"] };
    case "billing":
      return { title: `Your ${name} account is out of credit`, body: `Add credit to the ${name} account your key belongs to, then send again.`, actions: ["retry"] };
    case "rateLimit":
      return {
        title: `${name} asked Phaethon to slow down`,
        body: retryAfterSecs ? `Too many requests in a short time. Wait ${waitWords(retryAfterSecs)}, then send again.` : "Too many requests in a short time. Wait a minute, then send again.",
        actions: ["retry"],
      };
    case "unavailable":
      return local
        ? { title: `${name} had a problem`, body: "Check that it’s running and the model is loaded, then send again.", actions: ["retry"] }
        : { title: `${name}’s service is busy or down`, body: "It usually passes within minutes. Send again in a little while.", actions: ["retry"] };
    case "badRequest":
      return { title: `${name} couldn’t accept this message`, body: "Something in the message or its files wasn’t accepted. Try a shorter message or fewer files.", actions: ["retry"], ownWords: true };
    case "provider":
      return { title: "The model provider had a problem", body: "This is usually brief. Wait a moment, then send again.", actions: ["retry"] };
    case "network":
      return local
        ? { title: `Phaethon couldn’t reach ${name}`, body: "Check that it’s running and its address in Settings is right, then send again.", actions: ["retry", "settings"] }
        : { title: "Phaethon couldn’t reach the internet", body: "Check your connection, then send again.", actions: ["retry"] };
    case "missingCli":
      return { title: `${cli ?? "The coding agent"} isn’t installed`, body: `Install ${cli ?? "it"}, then connect it in Settings › Coding agents.`, actions: ["agents", "retry"] };
    case "notLoggedIn":
      return { title: `${cli ?? "The coding agent"} isn’t signed in`, body: `Sign in to ${cli ?? "it"} in Settings › Coding agents, then send again.`, actions: ["agents", "retry"] };
    case "cli":
      return { title: `${cli ?? "The coding agent"} stopped with an error`, body: "Send your message again. If it keeps failing, the details say what it reported.", actions: ["retry", "agents"], ownWords: false };
    case "busy":
      return { title: "Phaethon is still working on an earlier reply in this space", body: "Stop it, then send your message again. Or wait for it to finish.", actions: ["stop", "retry"] };
    case "invalidSpace":
      return { title: "This space’s folder can’t be found", body: "Check that its folder is still in your Phaethon folder, or choose another space.", actions: [] };
    case "declined":
      return { title: "The model declined to answer", body: "Try asking in a different way.", actions: [] };
    case "storage":
      return { title: "The conversation couldn’t be saved", body: "Nothing was sent. Check that the space’s folder can be written to, then send again.", actions: ["retry"] };
    case "attachment":
      return { title: "A file couldn’t be attached", body: "Attach images, PDFs, Word documents or text files within the size limits, then send again.", actions: [], ownWords: true };
    case "ipc":
      return { title: "Phaethon couldn’t reach its own core", body: "Quit and reopen Phaethon. If it keeps happening, copy the details and report it.", actions: ["retry"] };
    default:
      return { title: "Phaethon couldn’t finish this reply", body: "Send your message again.", actions: ["retry"] };
  }
}

/**
 * A failed reply: a quiet banner inside the message. The title and what to
 * do are one alert, announced at once; the buttons and folded details follow.
 */
export function ErrorRow({
  error,
  cutOff,
  settings,
  canRetry,
  onRetry,
  onStop,
}: {
  error: { code: ErrorCode | "ipc"; message: string; retryAfterSecs?: number };
  cutOff: boolean;
  settings: SettingsView | null;
  canRetry: boolean;
  onRetry: () => void;
  onStop: () => void;
}) {
  const nav = useNav();
  const detailId = useId();
  const r = recoveryFor(error.code, settings, error.retryAfterSecs);
  const actions = r.actions.filter((a) => a !== "retry" || canRetry);
  return (
    <div className="ph-block flex w-full items-start gap-3 rounded-xl border border-destructive/25 bg-destructive/6 px-4 py-3" data-error-code={error.code}>
      <CircleAlertIcon aria-hidden className="mt-0.5 size-4.5 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div role="alert" className="flex flex-col gap-0.5 text-[0.9375rem]">
          <p className="font-semibold text-destructive-foreground">{r.title}</p>
          {cutOff && <p>The reply above is incomplete: it was cut off here.</p>}
          <p>{r.ownWords && error.message ? error.message : r.body}</p>
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {actions.map((a, i) => {
              const variant = i === 0 ? "default" : "outline";
              if (a === "settings" || a === "agents")
                return (
                  <Button key={a} size="sm" variant={variant} onClick={() => nav.openSettings(a === "settings" ? "assistant" : "agents")}>
                    <SettingsIcon aria-hidden />
                    {a === "settings" ? "Open Assistant settings" : "Open Coding agents settings"}
                  </Button>
                );
              if (a === "stop")
                return (
                  <Button key={a} size="sm" variant={variant} onClick={onStop}>
                    <SquareIcon aria-hidden />
                    Stop the earlier reply
                  </Button>
                );
              return (
                <Button key={a} size="sm" variant={variant} onClick={onRetry}>
                  <RotateCcwIcon aria-hidden />
                  Send again
                </Button>
              );
            })}
          </div>
        )}
        {error.message && !r.ownWords && (
          <details className="group text-sm">
            <summary className="inline-flex min-h-6 cursor-pointer items-center gap-1 text-muted-foreground marker:content-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              <ChevronRightIcon aria-hidden className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
              Details
            </summary>
            <div className="mt-1 flex items-start gap-2">
              <p id={detailId} className="min-w-0 flex-1 rounded-md bg-background/70 px-2 py-1 font-mono text-xs wrap-anywhere">
                {error.message}
              </p>
              <CopyButton text={error.message} label="Copy details" iconOnly />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
