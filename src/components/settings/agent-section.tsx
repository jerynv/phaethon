import { RadioGroup } from "radix-ui";
import { useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { clearApiKey, setApiKey, setBackend, type Backend, type Settings } from "@/lib/backend";

import { SectionHeader, SettingGroup, SettingRow, radioArrowKeys } from "./controls";
import { useStatus } from "./status";

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  {
    value: "phaethon",
    label: "Phaethon, with your Anthropic API key",
    hint: "Phaethon runs the agent itself. It sees only the space you are in, and asks before changing any file.",
  },
  {
    value: "claude-cli",
    label: "Claude Code on this computer",
    hint: "Uses the claude command you installed and logged into yourself. Read-only for now.",
  },
];

const CONSOLE_KEYS_URL = "https://console.anthropic.com/settings/keys";

/**
 * Which agent answers, and the Anthropic API key. The key field is write-only:
 * once saved it goes to the system keychain and is never shown again.
 *
 * Keyboard: the agent choice is a radio group (arrows move and choose). The
 * key is a form: Enter saves. Remove saved key asks first, inline: focus moves
 * to "Keep key", and either answer puts focus somewhere that still exists.
 */
export function AgentSection({
  headingId,
  settings,
  loadError,
  retryLoad,
  act,
}: {
  headingId: string;
  settings: Settings | null;
  /** Why the settings could not be read, if they could not. */
  loadError: string;
  /** Reads the settings again; resolves true once they loaded. */
  retryLoad: () => Promise<boolean>;
  /**
   * Run a change, then reload settings and announce `done`. Errors go to
   * `onError` when given (shown at the field), otherwise to the window banner.
   */
  act: (work: () => Promise<void>, done: string, onError?: (message: string) => void, reloadThread?: boolean) => Promise<boolean>;
}) {
  const { say } = useStatus();
  const [keyDraft, setKeyDraft] = useState("");
  const [keyError, setKeyError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  /** The backend last asked for, so one key press never sends two changes. */
  const backendAsked = useRef<Backend | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const backendLabel = useId();
  const keyId = useId();
  const keyHintId = useId();
  const keyErrorId = useId();
  const keySavedId = useId();
  const confirmId = useId();

  function chooseBackend(v: string) {
    const b = BACKENDS.find((x) => x.value === v);
    if (!b || backendAsked.current === b.value) return;
    backendAsked.current = b.value;
    void act(() => setBackend(b.value), `Now using ${b.label}.`, undefined, true).finally(() => {
      backendAsked.current = null;
    });
  }

  async function saveKey(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!keyDraft.trim()) {
      setKeyError("Paste a key first. It starts with sk-ant-.");
      inputRef.current?.focus();
      return;
    }
    setKeyError("");
    setSaved(false);
    setSaving(true);
    const ok = await act(
      () => setApiKey(keyDraft),
      "API key saved to this computer’s keychain.",
      (message) => {
        setKeyError(`Not saved. ${message}`);
        requestAnimationFrame(() => inputRef.current?.focus());
      },
    );
    setSaving(false);
    if (ok) {
      setKeyDraft("");
      setSaved(true);
    }
  }

  async function removeKey() {
    if (removing) return;
    setRemoving(true);
    const ok = await act(clearApiKey, "API key removed from this computer’s keychain.");
    setRemoving(false);
    if (ok) {
      setConfirmRemove(false);
      setSaved(false);
      // The Remove button is gone with the key; the empty key field is the next useful place.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  function askToRemove() {
    setConfirmRemove(true);
    requestAnimationFrame(() => keepRef.current?.focus());
  }

  function keepKey() {
    setConfirmRemove(false);
    requestAnimationFrame(() => removeRef.current?.focus());
  }

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    const ok = await retryLoad();
    setRetrying(false);
    if (ok) {
      say("Settings loaded.");
      requestAnimationFrame(() => document.getElementById(headingId)?.focus());
    } else {
      say("Settings still could not be loaded.");
    }
  }

  const describedBy = [keyHintId, keyError && keyErrorId, saved && !keyError && keySavedId].filter(Boolean).join(" ");

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Agent"
        description="Which agent answers in your spaces, and the key it uses. These apply to every space in this vault."
      />
      {!settings ? (
        loadError ? (
          <LoadProblem raw={loadError}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-disabled={retrying || undefined}
              onClick={() => void retry()}
              className="aria-disabled:cursor-progress"
            >
              <Icon name="retry" />
              {retrying ? "Trying again…" : "Try again"}
            </Button>
          </LoadProblem>
        ) : (
          <p className="text-base text-ink-secondary" role="status">
            Loading your agent settings…
          </p>
        )
      ) : (
        <>
          <SettingGroup title="Which agent answers" bare>
            <div>
              <span id={backendLabel} className="sr-only">
                Which agent answers
              </span>
              <RadioGroup.Root
                aria-labelledby={backendLabel}
                value={settings.backend}
                onValueChange={chooseBackend}
                onKeyDownCapture={radioArrowKeys(chooseBackend)}
                className="flex flex-col gap-2"
              >
                {BACKENDS.map((b) => (
                  <RadioGroup.Item
                    key={b.value}
                    value={b.value}
                    aria-describedby={`${backendLabel}-${b.value}`}
                    className={cn(
                      "group flex w-full min-w-0 items-start gap-3 rounded-lg border border-line-strong bg-raised px-4 py-3 text-left shadow-sm transition-colors duration-(--ph-duration-fast) hover:bg-hover",
                      "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-soft",
                    )}
                  >
                    <span className="mt-0.5 grid size-(--ph-icon-size) shrink-0 place-items-center rounded-full border-2 border-ink-tertiary group-data-[state=checked]:border-accent-fill">
                      <RadioGroup.Indicator className="size-[50%] rounded-full bg-accent-fill" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="text-base font-medium text-ink">{b.label}</span>
                      <span id={`${backendLabel}-${b.value}`} className="text-sm text-ink-secondary group-data-[state=checked]:text-accent-soft-ink">
                        {b.hint}
                      </span>
                    </span>
                  </RadioGroup.Item>
                ))}
              </RadioGroup.Root>
            </div>
          </SettingGroup>

          <SettingGroup title="Anthropic API key" description="Only used when Phaethon runs the agent itself.">
            <form onSubmit={(e) => void saveKey(e)} className="flex flex-col gap-3 px-4 py-3.5" aria-label="Anthropic API key">
              <p id={keyHintId} className="flex items-start gap-2 text-sm text-ink-secondary">
                <Icon name={settings.hasAnthropicKey ? "lock" : "key"} className="mt-0.5 shrink-0 text-ink-tertiary" />
                {settings.hasAnthropicKey ? (
                  <span>A key is saved in this computer’s keychain. Phaethon never shows it again; enter a new one to replace it.</span>
                ) : (
                  <span>
                    No key saved yet. Create one at{" "}
                    <a href={CONSOLE_KEYS_URL} target="_blank" rel="noreferrer" className="text-accent-ink underline decoration-1 hover:decoration-2">
                      console.anthropic.com
                    </a>
                    . It goes into this computer’s keychain, never into your vault files, so it never syncs.
                  </span>
                )}
              </p>
              <div className="flex flex-col gap-1.5">
                <label htmlFor={keyId} className="text-base font-medium text-ink">
                  {settings.hasAnthropicKey ? "New API key" : "API key"}
                </label>
                <div className="flex flex-wrap gap-2">
                  <input
                    ref={inputRef}
                    id={keyId}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-ant-…"
                    value={keyDraft}
                    readOnly={saving}
                    onChange={(e) => {
                      setKeyDraft(e.target.value);
                      if (keyError) setKeyError("");
                      if (saved) setSaved(false);
                    }}
                    aria-describedby={describedBy}
                    aria-invalid={keyError ? true : undefined}
                    className="min-h-(--ph-control-height-lg) min-w-(--ph-settings-label-min) flex-1 rounded-md border border-line-strong bg-bg px-3 py-1.5 font-mono text-base text-ink placeholder:text-ink-tertiary read-only:text-ink-secondary aria-invalid:border-danger"
                  />
                  <Button type="submit" aria-disabled={saving || undefined} className="min-h-(--ph-control-height-lg) aria-disabled:cursor-progress">
                    {saving ? "Saving…" : "Save key"}
                  </Button>
                </div>
                {keyError && (
                  <p id={keyErrorId} className="flex items-start gap-1.5 text-sm text-danger-ink">
                    <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                    <span className="min-w-0">{keyError}</span>
                  </p>
                )}
                {/* Visible confirmation; the window's status line already announces it. */}
                {saved && !keyError && (
                  <p id={keySavedId} className="flex items-center gap-1.5 text-sm text-success-ink">
                    <Icon name="check" className="size-(--ph-icon-size-sm) shrink-0" />
                    Saved to this computer’s keychain.
                  </p>
                )}
              </div>
              {settings.hasAnthropicKey &&
                (confirmRemove ? (
                  <div role="group" aria-labelledby={confirmId} className="flex flex-col gap-2.5 rounded-md border border-danger bg-danger-soft px-3.5 py-3">
                    <p id={confirmId} className="flex items-start gap-2 text-sm text-danger-ink">
                      <Icon name="warning" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
                      <span className="min-w-0">
                        Remove the saved key from this computer’s keychain? Phaethon can’t answer in your spaces until you add a key again or
                        switch to Claude Code.
                      </span>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        aria-disabled={removing || undefined}
                        onClick={() => void removeKey()}
                        className="aria-disabled:cursor-progress"
                      >
                        <Icon name="remove" />
                        {removing ? "Removing…" : "Remove key"}
                      </Button>
                      <Button ref={keepRef} type="button" variant="outline" size="sm" onClick={keepKey}>
                        Keep key
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button ref={removeRef} type="button" variant="outline" size="sm" className="self-start" onClick={askToRemove}>
                    <Icon name="remove" />
                    Remove saved key…
                  </Button>
                ))}
            </form>
          </SettingGroup>

          <SettingGroup title="Model">
            <SettingRow label="Model in use" description="Set per vault in .phaethon/settings.json. A picker is coming.">
              <span className="font-mono text-sm text-ink">{settings.model}</span>
            </SettingRow>
          </SettingGroup>
        </>
      )}
    </>
  );
}

/**
 * Settings that could not be read, in plain words: what happened, which file,
 * what to do, then `children` (Try again). The core's own message is folded
 * under Details for anyone fixing the file by hand. The wording only chooses
 * between a few known causes; anything else gets the general sentence, and
 * the raw text is never the headline.
 */
function LoadProblem({ raw, children }: { raw: string; children: ReactNode }) {
  const line = /line (\d+)/i.exec(raw)?.[1];
  const cause = /keychain/i.test(raw) ? "keychain" : /settings\.json|json|expected|invalid type/i.test(raw) ? "file" : "other";
  return (
    <div className="flex items-start gap-2.5 rounded-md bg-danger-soft px-4 py-3.5 text-sm text-danger-ink">
      <Icon name="error" className="mt-0.5 shrink-0" />
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <p role="alert" className="font-medium">
          Phaethon can’t read your settings, so it is using the defaults for now.
        </p>
        {cause === "file" && (
          <p>
            Your settings file has something in it Phaethon doesn’t understand{line ? `, on line ${line}` : ""}. The file is{" "}
            <span className="font-mono wrap-anywhere">.phaethon/settings.json</span> in your vault folder. Fix or delete it, then choose Try again.
          </p>
        )}
        {cause === "keychain" && (
          <p>It couldn’t open this computer’s keychain, where your API key is kept. Unlock the keychain or allow Phaethon to use it, then choose Try again.</p>
        )}
        {cause === "other" && <p>Choose Try again. If this keeps happening, Details below says what went wrong.</p>}
        {/* The way out first, the technical text after: same order as chat errors. */}
        <div className="mt-1">{children}</div>
        <Details className="text-danger-ink">
          <p className="font-mono wrap-anywhere">{raw}</p>
        </Details>
      </div>
    </div>
  );
}
