import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

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
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/icons";
import { setBackend } from "@/lib/backend";
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
 * chat knows to put the card away.
 */
export function SetupCard({ space }: { space: Space }) {
  const [phase, setPhase] = useState<Phase>("setup");
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [said, setSaid] = useState("");
  const headingId = useId();
  const keyId = useId();
  const hintId = useId();
  const outcomeId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  function announce(text: string) {
    // Cleared first so the same words twice are said twice.
    setSaid("");
    requestAnimationFrame(() => setSaid(text));
  }

  async function save(skipCheck: boolean) {
    if (saving) return;
    setSaving(true);
    setOutcome(null);
    const result = await checkAndSave(draft, skipCheck);
    setSaving(false);
    setOutcome(result);
    announce(outcomeText(result));
    if (result.kind === "saved") {
      setDraft("");
      setPhase("saved");
      focusComposer(headingRef.current);
    } else if (result.kind === "no-credit") {
      // Saved, but it can't answer until the account has credit: say only that, with the way there.
      setDraft("");
      setPhase("credit");
      requestAnimationFrame(() => headingRef.current?.focus());
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  async function useClaudeCode() {
    if (switching) return;
    setSwitching(true);
    setSwitchError("");
    try {
      await setBackend("claude-cli");
      setPhase("cli");
      announce("Phaethon now uses Claude Code on this computer.");
      focusComposer(headingRef.current);
    } catch (e) {
      setSwitchError(`Phaethon couldn’t switch to Claude Code. ${String(e)}`);
    } finally {
      setSwitching(false);
    }
  }

  const bad = outcome?.kind === "problem";

  return (
    <section
      aria-labelledby={headingId}
      data-setup-card=""
      className="mx-auto flex w-full max-w-(--ph-measure) flex-col gap-4 rounded-xl border border-line bg-raised px-6 py-5 text-left text-md text-ink shadow-sm"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-(--ph-control-height-lg) shrink-0 place-items-center rounded-full bg-accent-soft text-accent-soft-ink">
          <Icon name={phase === "setup" ? "key" : phase === "credit" ? "warning" : "check"} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} ref={headingRef} tabIndex={-1} className="self-start rounded-xs text-xl font-semibold text-ink">
            {phase === "setup" ? `Set up Phaethon to answer in ${space.name}` : phase === "credit" ? "One more step: add credit" : "You’re set up"}
          </h2>
          {phase === "setup" && (
            <p className="text-ink-secondary">
              Phaethon writes its replies with Claude, an AI made by Anthropic. To use it, Phaethon needs an API key: a long code, like a
              password, from your own Anthropic account.
            </p>
          )}
        </div>
      </div>

      {phase === "saved" && (
        <p data-setup-done="" className="text-ink">Your key works and is saved in {KEY_STORE}. Type your first message in the box below.</p>
      )}
      {phase === "credit" && (
        <div data-setup-credit="" className="flex flex-col gap-2">
          <p>
            Your key is saved, but your Anthropic account has no credit yet, so Phaethon can’t answer. Add credit under Billing in the
            Anthropic console; nothing else needs changing here. Then type your first message below.
          </p>
          <p>
            <ExternalLink href={CONSOLE_BILLING_URL}>Open Billing in the Anthropic console</ExternalLink>
          </p>
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
          <ul className="flex flex-col gap-2 text-ink-secondary">
            <Fact icon="info">
              <strong className="font-semibold text-ink">A separate account.</strong> A ChatGPT or Claude.ai subscription doesn’t include an
              API key.
            </Fact>
            <Fact icon="key">
              <strong className="font-semibold text-ink">Pay as you go.</strong> Light use usually costs a few dollars a month. You can set a
              spending limit in the Anthropic console.
            </Fact>
            <Fact icon="lock">
              <strong className="font-semibold text-ink">Kept on this computer.</strong> Your key stays in {KEY_STORE} and never syncs.
            </Fact>
          </ul>

          <ol className="flex flex-col gap-4">
            <Step n={1} title="Get a key">
              <p className="text-ink-secondary">
                Sign in at <ExternalLink href={CONSOLE_KEYS_URL}>console.anthropic.com</ExternalLink>, add some credit under Billing, then
                choose Create Key and copy it.
              </p>
            </Step>
            <Step n={2} title="Paste it here">
              <form onSubmit={submit} className="flex flex-col gap-2">
                <label htmlFor={keyId} className="font-medium text-ink">
                  Your Anthropic API key
                </label>
                <p id={hintId} className="text-sm text-ink-secondary">
                  It starts with sk-ant-. Phaethon checks it with Anthropic before saving it.
                </p>
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
                {outcome && <KeyOutcomeLine id={outcomeId} outcome={outcome} />}
                {canSaveUnchecked(outcome) && (
                  <Button type="button" variant="outline" className="self-start" onClick={() => void save(true)}>
                    Save without checking
                  </Button>
                )}
              </form>
            </Step>
          </ol>

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
            {switchError && (
              <p className="flex items-start gap-1.5 text-sm text-danger-ink">
                <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                <span className="min-w-0">{switchError}</span>
              </p>
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

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span
        aria-hidden="true"
        className="grid size-(--ph-control-height) shrink-0 place-items-center rounded-full border border-line-strong text-sm font-semibold text-ink"
      >
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h3 className="font-semibold text-ink">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}
