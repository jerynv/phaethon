import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import {
  CONSOLE_BILLING_URL,
  CONSOLE_KEYS_URL,
  KEY_STORE,
  canSaveUnchecked,
  checkAndSave,
  outcomeText,
  type KeyOutcome,
} from "@/components/settings/api-key";
import { ExternalLink, KeyOutcomeLine } from "@/components/settings/agent-section";
import {
  CLAUDE_CODE_INSTALL_URL,
  CLAUDE_CODE_MISSING,
  ClaudeCodeMissing,
  switchToClaudeCode,
} from "@/components/settings/claude-code";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon, type IconName } from "@/icons";
import { checkApiKey } from "@/lib/backend";
import type { Space } from "@/lib/spaces";

type Phase = "setup" | "saved" | "credit" | "cli";

/** After setup, the next useful place: the message box, or the card's own heading if it is gone. */
function focusComposer(fallback: HTMLElement | null) {
  requestAnimationFrame(() => {
    const composer = document.querySelector<HTMLElement>("[data-composer-input]");
    (composer && composer.getClientRects().length > 0 ? composer : fallback)?.focus();
  });
}

/**
 * The key error on the conversation's last message, when there is one: a
 * message sent before setup that is waiting to be sent again.
 */
function waitingKeyError(card: HTMLElement | null): HTMLElement | null {
  const log = card?.closest<HTMLElement>("[role=log]");
  if (!log) return null;
  const messages = log.querySelectorAll<HTMLElement>("[data-role]");
  const last = messages[messages.length - 1];
  const error = last?.querySelector<HTMLElement>('[data-error-code="noApiKey"], [data-error-code="apiKey"]');
  return error ?? null;
}

/**
 * Once the key is saved, the waiting message's error turns into "Your key is
 * saved" with Send again (as soon as it hears of the key): focus goes to Send
 * again, with the error and the button in view. Falls back to the message box.
 */
function focusSendAgain(error: HTMLElement, fallback: HTMLElement | null) {
  let frames = 0;
  const attempt = () => {
    const button = error.isConnected ? error.querySelector<HTMLElement>('[data-error-action="retry"]') : null;
    if (!button) {
      if (++frames < 90) requestAnimationFrame(attempt);
      else focusComposer(fallback);
      return;
    }
    const log = error.closest<HTMLElement>("[role=log]");
    if (log) {
      // The error's top in view when it fits, and always the button.
      const l = log.getBoundingClientRect();
      const e = error.getBoundingClientRect();
      const margin = 16;
      if (e.top < l.top + margin || e.bottom > l.bottom - margin) log.scrollTop += e.top - l.top - margin;
      const b = button.getBoundingClientRect();
      if (b.bottom > l.bottom - margin) log.scrollTop += b.bottom - l.bottom + margin;
    }
    button.focus({ preventScroll: true });
  };
  requestAnimationFrame(attempt);
}

/**
 * First-run setup, shown in a space's empty conversation while Phaethon's own
 * assistant has no API key. Written for someone who has never heard of an API
 * key: what it is, that it is a separate pay-as-you-go Anthropic account (not
 * ChatGPT, not a Claude.ai subscription), roughly what it costs, where to get
 * one, then a field that checks the key before saving it. The other way in,
 * Claude Code, is offered second and quieter.
 *
 * Keyboard and screen readers: a region named by its heading; the key field is
 * a form (Enter checks and saves); the result is said in a polite status line
 * and shown under the field; on success focus moves to the message box.
 * Saving fires SETTINGS_CHANGED_EVENT (src/lib/backend.ts), which is how the
 * chat knows to put the card away; `onResult` is called first so the chat can
 * keep this card up to show what happened (a key with no credit needs one
 * more step).
 */
export function SetupCard({ space, onResult }: { space: Space; onResult?: () => void }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [cliMissing, setCliMissing] = useState(false);
  const [said, setSaid] = useState("");
  // A message sent before setup waits above, with its own Send again.
  const [waiting, setWaiting] = useState<"none" | "waiting" | "sent">("none");
  const sectionRef = useRef<HTMLElement>(null);
  const headingId = useId();
  const keyId = useId();
  const hintId = useId();
  const outcomeId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const creditKey = useRef("");
  const [rechecking, setRechecking] = useState(false);
  const [recheck, setRecheck] = useState("");

  // Once the waiting message is sent again (its error goes), the card stops pointing at it.
  useEffect(() => {
    const log = sectionRef.current?.closest("[role=log]");
    if (waiting !== "waiting" || !log) return;
    const watch = new MutationObserver(() => {
      if (!waitingKeyError(sectionRef.current)) setWaiting("sent");
    });
    watch.observe(log, { childList: true, subtree: true });
    return () => watch.disconnect();
  }, [waiting]);

  function announce(text: string) {
    // Cleared first so the same words twice are said twice.
    setSaid("");
    requestAnimationFrame(() => setSaid(text));
  }

  async function save(skipCheck: boolean) {
    if (saving) return;
    setSaving(true);
    setOutcome(null);
    const result = await checkAndSave(draft, skipCheck, () => onResult?.());
    setSaving(false);
    setOutcome(result);
    const error = result.kind === "saved" || result.kind === "no-credit" ? waitingKeyError(sectionRef.current) : null;
    setWaiting(error ? "waiting" : "none");
    // With a message waiting, Send again (described by "Your key is saved…") says it once, as it takes focus.
    if (!error || result.kind !== "saved") announce(outcomeText(result));
    if (result.kind === "saved") {
      setDraft("");
      setPhase("saved");
      if (error) focusSendAgain(error, headingRef.current);
      else focusComposer(headingRef.current);
    } else if (result.kind === "no-credit") {
      // Saved, but it can't answer until the account has credit: say only that, with the way there.
      // The key (already typed here) is kept in memory only while this card shows, for Check again.
      creditKey.current = draft.trim();
      setDraft("");
      setPhase("credit");
      requestAnimationFrame(() => headingRef.current?.focus());
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  /** After adding credit: ask Anthropic again whether the saved key can answer now. */
  async function checkAgain() {
    const key = creditKey.current;
    if (!key || rechecking) return;
    setRechecking(true);
    setRecheck("");
    let said: string;
    try {
      const r = await checkApiKey(key);
      if (r.ok) {
        creditKey.current = "";
        setPhase("saved");
        said = "Your account has credit now. Phaethon is ready to answer.";
        const error = waitingKeyError(sectionRef.current);
        if (error) focusSendAgain(error, headingRef.current);
        else focusComposer(headingRef.current);
      } else if (r.problem === "billing") {
        said = "There’s still no credit on this account. A new payment can take a few minutes to arrive; check again shortly.";
      } else {
        said = `Phaethon couldn’t check the key just now. ${r.message}`;
      }
    } catch (e) {
      said = `Phaethon couldn’t reach Anthropic to check. ${String(e)}`;
    }
    setRechecking(false);
    setRecheck(said);
    announce(said);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  async function useClaudeCode() {
    if (switching) return;
    setSwitching(true);
    setSwitchError("");
    setCliMissing(false);
    try {
      onResult?.();
      await switchToClaudeCode();
      setPhase("cli");
      announce("Phaethon now uses Claude Code on this computer.");
      focusComposer(headingRef.current);
    } catch (e) {
      if (e instanceof ClaudeCodeMissing) {
        setCliMissing(true);
        announce(CLAUDE_CODE_MISSING);
      } else setSwitchError(`Phaethon couldn’t switch to Claude Code. ${String(e)}`);
    } finally {
      setSwitching(false);
    }
  }

  const bad = outcome?.kind === "problem";

  return (
    <section
      ref={sectionRef}
      aria-labelledby={headingId}
      data-setup-card=""
      className="mx-auto flex w-full max-w-(--ph-measure) flex-col gap-4 rounded-xl border border-line bg-raised px-6 py-5 text-left text-md text-ink shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 grid size-(--ph-control-height-lg) shrink-0 place-items-center rounded-full ${phase === "credit" ? "bg-warning-soft text-warning-ink" : "bg-accent-soft text-accent-soft-ink"}`}
        >
          <Icon name={phase === "setup" ? "key" : phase === "credit" ? "warning" : "check"} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="self-start rounded-xs text-xl font-semibold text-ink">
            {phase === "setup" ? (
              <>
                Set up Phaethon<span className="sr-only"> to answer in {space.name}</span>
              </>
            ) : phase === "credit" ? (
              "One more step: add credit"
            ) : (
              "You’re set up"
            )}
          </h2>
        </div>
      </div>

      {phase === "saved" && (
        <p data-setup-done="" className="text-ink">
          Your key works and is saved in {KEY_STORE}.{" "}
          {waiting === "waiting"
            ? "Your message is waiting above: press Send again to send it."
            : waiting === "none"
              ? "Type your first message in the box below."
              : ""}
        </p>
      )}
      {phase === "credit" && (
        <div data-setup-credit="" className="flex flex-col gap-2">
          <p>
            Your key is saved, but your Anthropic account has no credit yet, so Phaethon can’t answer. Add credit under Billing in the
            Anthropic console; nothing else needs changing here.{" "}
            {waiting === "waiting" ? "Then press Send again on your message above." : waiting === "none" ? "Then type your first message below." : ""}
          </p>
          <p>
            <ExternalLink href={CONSOLE_BILLING_URL}>Open Billing in the Anthropic console</ExternalLink>
          </p>
          {creditKey.current && (
            <div className="flex flex-col items-start gap-1.5">
              <Button
                type="button"
                variant="outline"
                data-setup-recheck=""
                aria-disabled={rechecking || undefined}
                className="aria-disabled:cursor-progress"
                onClick={() => void checkAgain()}
              >
                <Icon name="retry" />
                {rechecking ? "Checking…" : "Check again"}
              </Button>
              {recheck && (
                <p className="text-sm text-ink" data-setup-recheck-result="">
                  {recheck}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {phase === "cli" && (
        <p data-setup-done="" className="text-ink">
            Phaethon now uses Claude Code on this computer. Type your first message below. If Claude Code isn’t installed or signed in yet,
            Phaethon will say how to do that when you send it.
        </p>
      )}

      {phase === "setup" && (
        <>
          {/* The key field comes first, so it is in view even in a small window at large text; where to
              get a key follows, and what an API key is (and what it costs) is folded underneath. */}
          <form onSubmit={submit} className="flex flex-col gap-2">
            <label htmlFor={keyId} className="font-medium text-ink">
              Paste your Anthropic API key
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                ref={inputRef}
                id={keyId}
                data-setup-key=""
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draft}
                readOnly={saving}
                onChange={(e) => {
                  setDraft(e.target.value);
                  if (outcome) setOutcome(null);
                }}
                aria-describedby={[hintId, outcome && outcomeId].filter(Boolean).join(" ")}
                aria-invalid={bad ? true : undefined}
                className="min-h-(--ph-control-height-lg) min-w-(--ph-settings-label-min) flex-1 rounded-md border border-line-strong bg-bg px-3 py-1.5 font-mono text-base text-ink read-only:text-ink-secondary aria-invalid:border-danger"
              />
              <Button type="submit" aria-disabled={saving || undefined} className="min-h-(--ph-control-height-lg) aria-disabled:cursor-progress">
                {saving ? "Checking…" : "Check and save"}
              </Button>
            </div>
            <p id={hintId} className="text-sm text-ink-secondary">
              It starts with sk-ant-. Phaethon checks it with Anthropic before saving it.
            </p>
            {outcome && <KeyOutcomeLine id={outcomeId} outcome={outcome} />}
            {canSaveUnchecked(outcome) && (
              <Button type="button" variant="outline" className="self-start" onClick={() => void save(true)}>
                Save without checking
              </Button>
            )}
          </form>

          <div className="flex flex-col gap-1" data-setup-get="">
            <h3 className="font-semibold text-ink">No key yet?</h3>
            <p className="text-ink-secondary">
              Sign in at <ExternalLink href={CONSOLE_KEYS_URL}>console.anthropic.com</ExternalLink>, add some credit under Billing, then
              choose Create Key, copy it and paste it above.
            </p>
          </div>

          <Details summary="What is an API key?" className="text-md">
            <div data-setup-facts="" className="flex flex-col gap-2 text-ink-secondary">
              <p>
                Phaethon writes its replies with Claude, an AI made by Anthropic. To use it, Phaethon needs an API key: a long code, like a
                password, from your own Anthropic account.
              </p>
              <ul className="flex flex-col gap-2">
                <Fact icon="info">
                  <strong className="font-semibold text-ink">A separate account.</strong> A ChatGPT or Claude.ai subscription doesn’t include
                  an API key.
                </Fact>
                <Fact icon="key">
                  <strong className="font-semibold text-ink">Pay as you go.</strong> Light use usually costs a few dollars a month. You can set
                  a spending limit in the Anthropic console.
                </Fact>
                <Fact icon="lock">
                  <strong className="font-semibold text-ink">Kept on this computer.</strong> Your key stays in {KEY_STORE} and never syncs.
                </Fact>
              </ul>
            </div>
          </Details>

          <div className="flex flex-col items-start gap-2 border-t border-line pt-4">
            <p className="text-sm text-ink-secondary">
              Already use Claude Code on this computer? Phaethon can answer through it instead, with your Claude plan and no API key. It can
              read your files but can’t change them yet.
            </p>
            <Button
              type="button"
              variant="outline"
              data-setup-cli=""
              aria-disabled={switching || undefined}
              onClick={() => void useClaudeCode()}
              className="aria-disabled:cursor-progress"
            >
              {switching ? "Switching…" : "Use Claude Code instead"}
            </Button>
            {cliMissing ? (
              // Not an alarm: nothing went wrong, Claude Code just isn't here yet. The same words and link as Settings.
              <div data-cli-missing="" className="flex items-start gap-2 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning-ink">
                <Icon name="warning" className="mt-0.5 shrink-0" />
                <p className="min-w-0">
                  {CLAUDE_CODE_MISSING} <ExternalLink href={CLAUDE_CODE_INSTALL_URL}>How to install Claude Code</ExternalLink>
                </p>
              </div>
            ) : (
              switchError && (
                <p className="flex items-start gap-1.5 text-sm text-danger-ink">
                  <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                  <span className="min-w-0">{switchError}</span>
                </p>
              )
            )}
          </div>
        </>
      )}

      <p role="status" className="sr-only">
        {said}
      </p>
    </section>
  );
}

function Fact({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Icon name={icon} className="mt-0.5 shrink-0 text-ink-tertiary" />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
