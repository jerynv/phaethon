import { RadioGroup } from "radix-ui";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import { clearApiKey, listModels, setBackend, setModel, type Backend, type ModelInfo, type Settings } from "@/lib/backend";

import {
  ANTHROPIC_PRIVACY_URL,
  CONSOLE_BILLING_URL,
  CONSOLE_KEYS_URL,
  DEFAULT_MODEL,
  KEY_STORE,
  canSaveUnchecked,
  checkAndSave,
  isSaved,
  outcomeText,
  readableModel,
  type KeyOutcome,
} from "./api-key";
import { SectionHeader, SettingGroup, SettingRow, radioArrowKeys } from "./controls";
import { useSettingsNav, useStatus } from "./status";

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  {
    value: "phaethon",
    label: "Phaethon, using your Anthropic account",
    hint: "Needs an Anthropic API key (below). Phaethon only sees the space you’re in, and asks before it changes any file.",
  },
  {
    value: "claude-cli",
    label: "Claude Code on this computer",
    hint: "Uses the Claude Code app you installed and signed into yourself, on your own Claude plan. It can read your files but can’t change them yet.",
  },
];

/** Links that leave Phaethon: underlined, and say they open in the browser. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-ink underline decoration-1 underline-offset-2 hover:decoration-2">
      {children}
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}

/**
 * Which assistant answers, the Anthropic API key, the model, and what is sent
 * to Anthropic. The key field is write-only: once saved it goes to the
 * system's password store and is never shown again.
 *
 * Keyboard: the assistant choice is a radio group (arrows move and choose).
 * The key is a form: Enter checks and saves. Remove saved key asks first,
 * inline: focus moves to "Keep key", and either answer puts focus somewhere
 * that still exists. The model is a native select.
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
  const [retrying, setRetrying] = useState(false);
  /** The backend last asked for, so one key press never sends two changes. */
  const backendAsked = useRef<Backend | null>(null);
  const backendTitle = useId();

  function chooseBackend(v: string) {
    const b = BACKENDS.find((x) => x.value === v);
    if (!b || backendAsked.current === b.value) return;
    backendAsked.current = b.value;
    void act(() => setBackend(b.value), `Now using ${b.label}.`, undefined, true).finally(() => {
      backendAsked.current = null;
    });
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

  return (
    <>
      <SectionHeader
        id={headingId}
        title="Assistant"
        description="Which assistant answers in your spaces, and what it needs. This applies to every space."
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
            Loading your assistant settings…
          </p>
        )
      ) : (
        <>
          <SettingGroup title="Which assistant answers" titleId={backendTitle} bare>
            <RadioGroup.Root
              aria-labelledby={backendTitle}
              value={settings.backend}
              onValueChange={chooseBackend}
              onKeyDownCapture={radioArrowKeys(chooseBackend)}
              className="flex flex-col gap-2"
            >
              {BACKENDS.map((b) => (
                <RadioGroup.Item
                  key={b.value}
                  value={b.value}
                  data-backend={b.value}
                  aria-describedby={`${backendTitle}-${b.value}`}
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
                    <span id={`${backendTitle}-${b.value}`} className="text-sm text-ink-secondary group-data-[state=checked]:text-accent-soft-ink">
                      {b.hint}
                    </span>
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
          </SettingGroup>

          <SettingGroup title="Anthropic API key" description="Only needed when Phaethon answers.">
            <KeyForm hasKey={settings.hasAnthropicKey} act={act} />
          </SettingGroup>

          <SettingGroup title="Which model answers">
            {settings.backend === "phaethon" ? (
              <ModelPicker current={settings.model} act={act} />
            ) : (
              <SettingRow label="Model" description="Claude Code chooses its own model. Change it in Claude Code.">
                <span className="text-base text-ink-secondary">Chosen by Claude Code</span>
              </SettingRow>
            )}
          </SettingGroup>

          <SentDisclosure backend={settings.backend} />
        </>
      )}
    </>
  );
}

/** The key field: Check and save, the result in words, and Remove saved key. */
function KeyForm({ hasKey, act }: { hasKey: boolean; act: Parameters<typeof AgentSection>[0]["act"] }) {
  const { say } = useStatus();
  const [keyDraft, setKeyDraft] = useState("");
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const keyId = useId();
  const keyHintId = useId();
  const outcomeId = useId();
  const confirmId = useId();

  async function save(skipCheck: boolean) {
    if (saving) return;
    setOutcome(null);
    setSaving(true);
    let result: KeyOutcome = { kind: "problem", problem: "unchecked" };
    // act() reloads the settings and announces; the outcome itself shows at the field.
    await act(async () => {
      result = await checkAndSave(keyDraft, skipCheck);
    }, "");
    setSaving(false);
    setOutcome(result);
    say(outcomeText(result));
    if (isSaved(result)) setKeyDraft("");
    else requestAnimationFrame(() => inputRef.current?.focus());
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void save(false);
  }

  async function removeKey() {
    if (removing) return;
    setRemoving(true);
    const ok = await act(clearApiKey, `API key removed from ${KEY_STORE}.`);
    setRemoving(false);
    if (ok) {
      setConfirmRemove(false);
      setOutcome(null);
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

  const bad = outcome?.kind === "problem";
  const describedBy = [keyHintId, outcome && outcomeId].filter(Boolean).join(" ");

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-3.5">
      <div id={keyHintId} className="flex items-start gap-2 text-sm text-ink-secondary">
        <Icon name={hasKey ? "lock" : "key"} className="mt-0.5 shrink-0 text-ink-tertiary" />
        {hasKey ? (
          <p className="min-w-0">A key is saved in {KEY_STORE}. Phaethon never shows it again; paste a new one to replace it.</p>
        ) : (
          <div className="flex min-w-0 flex-col gap-1.5">
            <p>
              The key comes from Anthropic, the company that makes Claude. It’s a separate pay-as-you-go account: a ChatGPT or Claude.ai
              subscription doesn’t include one. Light use usually costs a few dollars a month, and you can set a spending limit in the
              Anthropic console.
            </p>
            <p>
              Create a key at <ExternalLink href={CONSOLE_KEYS_URL}>console.anthropic.com</ExternalLink>, then paste it here. It starts with
              sk-ant-. It’s kept in {KEY_STORE}, never in your Phaethon folder, so it never syncs.
            </p>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-base font-medium text-ink">
          {hasKey ? "New API key" : "API key"}
        </label>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id={keyId}
            data-key-input=""
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyDraft}
            readOnly={saving}
            onChange={(e) => {
              setKeyDraft(e.target.value);
              if (outcome) setOutcome(null);
            }}
            aria-describedby={describedBy}
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
      </div>
      {hasKey &&
        (confirmRemove ? (
          <div role="group" aria-labelledby={confirmId} className="flex flex-col gap-3 rounded-md border border-danger bg-danger-soft px-3.5 py-3">
            <p id={confirmId} className="flex items-start gap-2 text-sm text-danger-ink">
              <Icon name="warning" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0">
                Remove the saved key from {KEY_STORE}? Phaethon can’t answer in your spaces until you add a key again or switch to Claude
                Code.
              </span>
            </p>
            {/* Default-size buttons, well apart: a slip lands in the gap, not on the other answer. */}
            <div className="flex flex-wrap gap-x-4 gap-y-3">
              <Button ref={keepRef} type="button" variant="outline" onClick={keepKey}>
                Keep key
              </Button>
              <Button
                type="button"
                variant="destructive"
                aria-disabled={removing || undefined}
                onClick={() => void removeKey()}
                className="aria-disabled:cursor-progress"
              >
                <Icon name="remove" />
                {removing ? "Removing…" : "Remove key"}
              </Button>
            </div>
          </div>
        ) : (
          <Button ref={removeRef} type="button" variant="outline" className="self-start" onClick={askToRemove}>
            <Icon name="remove" />
            Remove saved key…
          </Button>
        ))}
    </form>
  );
}

/** The result of a key check, at the field. Not a live region: whoever shows it announces it once. */
export function KeyOutcomeLine({ id, outcome }: { id: string; outcome: KeyOutcome }) {
  const tone = outcome.kind === "saved" ? "success" : outcome.kind === "no-credit" ? "warning" : "danger";
  return (
    <div
      id={id}
      data-key-outcome={outcome.kind === "problem" ? outcome.problem : outcome.kind}
      className={cn(
        "flex items-start gap-1.5 text-sm",
        tone === "success" && "text-success-ink",
        tone === "warning" && "text-warning-ink",
        tone === "danger" && "text-danger-ink",
      )}
    >
      <Icon name={tone === "success" ? "check" : tone === "warning" ? "warning" : "error"} className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
      <span className="min-w-0">
        {outcomeText(outcome)}
        {outcome.kind === "no-credit" && (
          <>
            {" "}
            <ExternalLink href={CONSOLE_BILLING_URL}>Open Billing</ExternalLink>
          </>
        )}
        {outcome.kind === "problem" && outcome.problem === "rejected" && (
          <>
            {" "}
            <ExternalLink href={CONSOLE_KEYS_URL}>Open API keys</ExternalLink>
          </>
        )}
      </span>
    </div>
  );
}

const DEFAULT_OPTION = "__default__";

/** Model choice: Default first (recommended), then each model by its readable name. Saves on change. */
function ModelPicker({ current, act }: { current: string; act: Parameters<typeof AgentSection>[0]["act"] }) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const selectId = useId();
  const descId = useId();

  useEffect(() => {
    let live = true;
    listModels().then(
      (m) => live && setModels(m),
      () => {
        if (!live) return;
        setListFailed(true);
        setModels([]);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const nameOf = (id: string) => models?.find((m) => m.id === id)?.name ?? readableModel(id);
  const others = (models ?? []).filter((m) => m.id !== DEFAULT_MODEL);
  // A saved model the list no longer has still shows, so the select never lies about what is in use.
  if (current !== DEFAULT_MODEL && !others.some((m) => m.id === current)) others.push({ id: current, name: nameOf(current) });
  const value = current === DEFAULT_MODEL ? DEFAULT_OPTION : current;

  function choose(v: string) {
    const id = v === DEFAULT_OPTION ? null : v;
    const name = id ? nameOf(id) : `the default, ${nameOf(DEFAULT_MODEL)}`;
    void act(() => setModel(id), `Phaethon now answers with ${name}.`);
  }

  return (
    <SettingRow
      stacked
      label="Model"
      htmlFor={selectId}
      description={
        <>
          Which Claude model writes Phaethon’s replies. Larger models handle harder questions and cost more per message; smaller ones are
          faster and cheaper.
          {listFailed && " Phaethon couldn’t fetch the full list just now, so only the default is shown."}
        </>
      }
      descriptionId={descId}
    >
      <select
        id={selectId}
        data-model-select=""
        value={value}
        onChange={(e) => choose(e.target.value)}
        aria-describedby={descId}
        aria-busy={models === null || undefined}
        className="min-h-(--ph-control-height-lg) w-full rounded-md border border-line-strong bg-raised px-2.5 text-base text-ink shadow-sm hover:bg-hover"
      >
        <option value={DEFAULT_OPTION}>Default (recommended): {nameOf(DEFAULT_MODEL)}</option>
        {others.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

/** What leaves this computer, when, and where the rules for it are. */
function SentDisclosure({ backend }: { backend: Backend }) {
  const { go } = useSettingsNav();
  return (
    <SettingGroup title="What is sent to Anthropic">
      <div data-disclosure="" className="flex flex-col gap-2.5 px-4 py-3.5 text-sm text-ink-secondary">
        {backend === "phaethon" ? (
          <>
            <p className="text-base text-ink">Nothing is sent until you send a message. Then, with every message, Phaethon sends Anthropic:</p>
            <ul className="flex list-disc flex-col gap-1 ps-5">
              <li>your message and the conversation so far in that space</li>
              <li>any files you attach</li>
              <li>the files Phaethon opens to answer you, in that space or in another space you let it read</li>
              <li>your MANUAL.md, which is read in every space</li>
            </ul>
          </>
        ) : (
          <p className="text-base text-ink">
            Claude Code sends your messages, and the files it reads to answer, to Anthropic under your own Claude account, with every message.
          </p>
        )}
        <p>
          How long Anthropic keeps it and what they may use it for is in{" "}
          <ExternalLink href={ANTHROPIC_PRIVACY_URL}>Anthropic’s privacy policy</ExternalLink>.
        </p>
        <p>
          Your conversations also stay on this computer as plain files.{" "}
          <Button type="button" variant="link" className="h-auto min-h-0 align-baseline text-sm underline decoration-1 hover:decoration-2" onClick={() => go("about", "[data-files-heading]")}>
            Where they are and how to delete them
          </Button>
        </p>
      </div>
    </SettingGroup>
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
            <span className="font-mono wrap-anywhere">.phaethon/settings.json</span> in your Phaethon folder. Fix or delete it, then choose Try
            again.
          </p>
        )}
        {cause === "keychain" && (
          <p>
            It couldn’t open {KEY_STORE}, where your API key is kept. Unlock it or allow Phaethon to use it, then choose Try again.
          </p>
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
