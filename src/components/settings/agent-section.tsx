import { RadioGroup } from "radix-ui";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import {
  agentClis,
  cancelCliSignIn,
  CLI_INFO,
  clearApiKey,
  cliOf,
  isCliBackend,
  listModels,
  providerStatus,
  setBackend,
  setModel,
  setProvider,
  setProviderModel,
  setProviderUrl,
  signInCli,
  type AgentCliStatus,
  type Backend,
  type CliBackend,
  type CliSignIn,
  type ModelInfo,
  type ProviderInfo,
  type ServerStatus,
  type Settings,
} from "@/lib/backend";
import { changedText, loadCliModels, modelName, setSpaceModel, toRef, useModels } from "@/lib/space-model";
import { useSpaces } from "@/lib/spaces";
import { modCap } from "@/components/shell/shortcuts";

import {
  ANTHROPIC_PRIVACY_URL,
  CONSOLE_BILLING_URL,
  CONSOLE_KEYS_URL,
  DEFAULT_MODEL,
  KEY_STORE,
  canSaveUnchecked,
  checkAndSave,
  isSaved,
  outcomeTextFor,
  readableModel,
  type KeyOutcome,
} from "./api-key";
import { CLAUDE_CODE_INSTALL_URL, CLAUDE_CODE_MISSING, checkClaudeCode } from "./claude-code";
import { ModelSearch } from "./model-search";
import { SectionHeader, SettingGroup, SettingRow, radioArrowKeys } from "./controls";
import { useSettingsNav, useStatus } from "./status";

const BACKENDS: { value: Backend; label: string; hint: string }[] = [
  {
    value: "phaethon",
    label: "Phaethon’s own assistant",
    hint: "Answers with the model provider you choose below: Anthropic, OpenAI, OpenRouter, a model on this computer, and more. Phaethon only sees the space you’re in, and asks before it changes any file.",
  },
  {
    value: "claude-cli",
    label: "Claude Code on this computer",
    hint: "Uses the Claude Code app you installed and signed into yourself, on your own Claude plan. It can read your files but can’t change them yet.",
  },
  {
    value: "codex-cli",
    label: "Codex on this computer",
    hint: "Uses OpenAI’s Codex that you installed and signed into yourself, on your own ChatGPT plan or OpenAI account. It can read your files but can’t change them.",
  },
  {
    value: "gemini-cli",
    label: "Gemini CLI on this computer",
    hint: "Uses Google’s Gemini CLI that you installed and signed into yourself, with your own Google account or Gemini API key. It can read your files but can’t change them.",
  },
];

/** What to say when a CLI other than Claude Code is missing: what happened, then the way on. */
const cliMissingText = (b: CliBackend) =>
  b === "claude-cli"
    ? CLAUDE_CODE_MISSING
    : `${CLI_INFO[b].name} isn’t installed on this computer. To use it, install ${CLI_INFO[b].name} from ${CLI_INFO[b].company}, then choose it again and sign in to it here.`;

/** The CLIs Phaethon runs with a setup of their own for the Phaethon folder, signed in to here. */
type OwnHomeBackend = Exclude<CliBackend, "claude-cli">;
const isOwnHome = (b: Backend): b is OwnHomeBackend => isCliBackend(b) && b !== "claude-cli";
/** Each one's global instructions file, which its own setup here keeps out of every space. */
const OWN_FILE: Record<OwnHomeBackend, string> = { "codex-cli": "AGENTS.md", "gemini-cli": "GEMINI.md" };

/** OpenCode: looked for, not used yet. */
const OPENCODE_URL = "https://opencode.ai";

/** "Installed, signed in" and the like, for a CLI's choice. Nothing while unknown. */
function cliStatusText(s: AgentCliStatus | undefined): string {
  if (!s) return "";
  if (!s.installed) return "Not installed on this computer.";
  if (s.ownHome) {
    if (s.loggedIn === true) return "Installed and signed in for this Phaethon folder.";
    if (s.loggedIn === false) return "Installed, not signed in for this Phaethon folder yet.";
    return "Installed. Phaethon can’t tell whether you’re signed in for this Phaethon folder until you sign in here or send a message.";
  }
  if (s.loggedIn === true) return "Installed and signed in.";
  if (s.loggedIn === false) return `Installed, not signed in: run ${s.loginCommand} in a terminal.`;
  return s.id === "claude"
    ? "Installed. Phaethon doesn’t check whether you’re signed in."
    : `Installed. Phaethon can’t tell whether you’re signed in until you send a message; to sign in, run ${s.loginCommand} in a terminal.`;
}

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
  const provider = settings ? chosenProvider(settings) : ANTHROPIC_INFO;
  /** The backend last asked for, so one key press never sends two changes. */
  const backendAsked = useRef<Backend | null>(null);
  const backendTitle = useId();
  /** A CLI was chosen but isn't installed: say so under the choices, and stay where we are. */
  const [cliMissing, setCliMissing] = useState<CliBackend | null>(null);
  /** Each CLI's status (installed, signed in where the CLI can say); null until known or from an older core. */
  const [clis, setClis] = useState<AgentCliStatus[] | null>(null);
  useEffect(() => {
    let live = true;
    agentClis().then(
      (c) => live && setClis(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [settings?.backend]);
  // Each time Settings opens (or the assistant changes), the answering CLI's model list is asked again.
  useEffect(() => {
    if (settings && isCliBackend(settings.backend)) void loadCliModels(CLI_INFO[settings.backend].id, true);
  }, [settings?.backend]);
  // The note appears under the choices, perhaps below the fold: bring it into view.
  useEffect(() => {
    if (cliMissing) requestAnimationFrame(() => document.querySelector("[data-cli-missing]")?.scrollIntoView({ block: "nearest" }));
  }, [cliMissing]);
  const statusOf = (b: Backend) => (isCliBackend(b) ? clis?.find((c) => c.id === CLI_INFO[b].id) : undefined);
  const refreshClis = () =>
    agentClis().then(
      (c) => setClis(c),
      () => {},
    );
  const opencode = clis?.find((c) => c.id === "opencode");

  function chooseBackend(v: string) {
    const b = BACKENDS.find((x) => x.value === v);
    if (!b || backendAsked.current === b.value) return;
    backendAsked.current = b.value;
    setCliMissing(null);
    void (async () => {
      // A CLI: check it is on this computer before switching to it.
      if (b.value === "claude-cli") {
        const status = await checkClaudeCode();
        if (status && !status.installed) {
          setCliMissing("claude-cli");
          say(CLAUDE_CODE_MISSING);
          return;
        }
      } else if (isCliBackend(b.value)) {
        const status = (await agentClis().catch(() => null))?.find((c) => c.id === CLI_INFO[b.value as CliBackend].id);
        if (status && !status.installed) {
          setCliMissing(b.value);
          say(cliMissingText(b.value));
          return;
        }
      }
      await act(() => setBackend(b.value), `Now using ${b.label}.`, undefined, true);
    })().finally(() => {
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
        description="Which assistant answers in your spaces, and what it needs. This applies to every space, though a space can choose its own model."
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
                  // Named by its title alone; the hint is the description, so it is said once.
                  aria-labelledby={`${backendTitle}-${b.value}-name`}
                  aria-describedby={[`${backendTitle}-${b.value}`, statusOf(b.value) && `${backendTitle}-${b.value}-status`].filter(Boolean).join(" ")}
                  className={cn(
                    "group flex w-full min-w-0 items-start gap-3 rounded-lg border border-line-strong bg-raised px-4 py-3 text-left shadow-sm transition-colors duration-(--ph-duration-fast) hover:bg-hover",
                    "data-[state=checked]:border-accent-fill data-[state=checked]:bg-accent-soft",
                  )}
                >
                  <span className="mt-0.5 grid size-(--ph-icon-size) shrink-0 place-items-center rounded-full border-2 border-ink-tertiary group-data-[state=checked]:border-accent-fill">
                    <RadioGroup.Indicator className="size-[50%] rounded-full bg-accent-fill" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span id={`${backendTitle}-${b.value}-name`} className="text-base font-medium text-ink">
                      {b.label}
                    </span>
                    <span id={`${backendTitle}-${b.value}`} className="text-sm text-ink-secondary group-data-[state=checked]:text-accent-soft-ink">
                      {b.hint}
                    </span>
                    {statusOf(b.value) && (
                      <span
                        id={`${backendTitle}-${b.value}-status`}
                        data-cli-status={statusOf(b.value)!.installed ? (statusOf(b.value)!.loggedIn === false ? "signed-out" : "installed") : "missing"}
                        className="mt-0.5 flex items-start gap-1.5 text-sm font-medium text-ink group-data-[state=checked]:text-accent-soft-ink"
                      >
                        <Icon
                          name={!statusOf(b.value)!.installed || statusOf(b.value)!.loggedIn === false ? "warning" : "check"}
                          className="mt-0.5 size-(--ph-icon-size-sm) shrink-0"
                        />
                        <span className="min-w-0 wrap-anywhere">{cliStatusText(statusOf(b.value))}</span>
                      </span>
                    )}
                  </span>
                </RadioGroup.Item>
              ))}
            </RadioGroup.Root>
            {cliMissing && (
              // Said once through the status line when it appears; shown here until another choice is made.
              <div data-cli-missing={cliMissing} className="flex items-start gap-2 rounded-md bg-warning-soft px-3.5 py-3 text-sm text-warning-ink">
                <Icon name="warning" className="mt-0.5 shrink-0" />
                <p className="min-w-0">
                  {cliMissingText(cliMissing)}{" "}
                  <ExternalLink href={cliMissing === "claude-cli" ? CLAUDE_CODE_INSTALL_URL : CLI_INFO[cliMissing].installUrl}>
                    How to install {CLI_INFO[cliMissing].name}
                  </ExternalLink>
                </p>
              </div>
            )}
            <p data-cli-can="" className="text-sm text-ink-secondary">
              Claude Code, Codex and Gemini CLI read a space’s files and the course folders it can see, but can’t change anything, ask to
              read another space, or carry on a stopped reply. They see each course whole: letting a space see only some parts of a course
              (files but not grades, say) works only with Phaethon’s own assistant.
            </p>
            {opencode && (
              <p data-opencode={opencode.installed ? "installed" : "missing"} className="flex items-start gap-2 text-sm text-ink-secondary">
                <Icon name="info" className="mt-0.5 shrink-0" />
                <span className="min-w-0">
                  {opencode.installed ? (
                    "OpenCode is on this computer, but Phaethon can’t answer through it yet."
                  ) : (
                    <>
                      OpenCode isn’t installed, and Phaethon can’t answer through it yet.{" "}
                      <ExternalLink href={OPENCODE_URL}>How to install OpenCode</ExternalLink>
                    </>
                  )}
                </span>
              </p>
            )}
          </SettingGroup>

          {isOwnHome(settings.backend) && statusOf(settings.backend)?.installed !== false && (
            <CliSignInGroup key={settings.backend} backend={settings.backend} onSignedIn={refreshClis} />
          )}

          {settings.backend === "phaethon" && <ProviderChoice settings={settings} act={act} />}

          {provider.id === "anthropic" || settings.backend !== "phaethon" ? (
            <SettingGroup title="Anthropic API key" description="Only needed when Phaethon answers.">
              <KeyForm hasKey={settings.hasAnthropicKey} act={act} />
            </SettingGroup>
          ) : (
            <ProviderSetup key={provider.id} provider={provider} act={act} />
          )}

          <SettingGroup title="Which model answers">
            {isCliBackend(settings.backend) ? (
              <SettingRow
                label="Model"
                description={`${CLI_INFO[settings.backend].name} uses its own default model. A space can name another one: use the model button beside Send, or Change model in ${modCap()} K.`}
              >
                <span className="text-base text-ink-secondary" data-cli-model-default="">
                  Chosen by {CLI_INFO[settings.backend].name}
                </span>
              </SettingRow>
            ) : provider.id === "anthropic" ? (
              <ModelPicker current={settings.model} act={act} />
            ) : (
              <ProviderModel key={provider.id} provider={provider} act={act} />
            )}
          </SettingGroup>

          <SentDisclosure backend={settings.backend} provider={provider} />
        </>
      )}
    </>
  );
}

/**
 * Signing in to Codex or Gemini CLI for this Phaethon folder's own setup, with the CLI's own sign-in in
 * the browser. Keyboard: the sign-in button keeps focus while it waits (it says so, and can't be pressed
 * twice); Stop signing in sits beside it and, as it goes, hands focus back to the sign-in button. The
 * outcome is said through the status line and stays shown.
 */
function CliSignInGroup({ backend, onSignedIn }: { backend: OwnHomeBackend; onSignedIn: () => void }) {
  const cli = CLI_INFO[backend];
  const id = cli.id as "codex" | "gemini";
  const { say } = useStatus();
  const descId = useId();
  const [waiting, setWaiting] = useState(false);
  const [outcome, setOutcome] = useState<CliSignIn | null>(null);
  const live = useRef(true);
  const startRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  // Set on every mount: React's StrictMode mounts, unmounts and mounts again in development.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function start() {
    if (waiting) return;
    setWaiting(true);
    setOutcome(null);
    say(`Opening ${cli.name}’s sign-in in your browser. Come back here when you’ve signed in.`);
    const out: CliSignIn = await signInCli(id).catch((e: unknown) => ({
      status: "notSignedIn" as const,
      message: `${cli.name} couldn’t start signing in: ${String(e)}`,
    }));
    if (!live.current) return;
    // Stop signing in goes away with the wait: focus on it moves to the sign-in button.
    if (document.activeElement === stopRef.current) startRef.current?.focus();
    setWaiting(false);
    setOutcome(out);
    say(out.message);
    if (out.status === "signedIn") onSignedIn();
  }

  return (
    <SettingGroup title={`Signing in to ${cli.name}`}>
      <div data-cli-sign-in={id} className="flex flex-col gap-3 px-4 py-3.5">
        <p id={descId} className="text-sm text-ink-secondary">
          Phaethon gives {cli.name} a setup of its own for this Phaethon folder, apart from the one in your home folder, so the{" "}
          {OWN_FILE[backend]}, settings and hooks you made for {cli.name} yourself never reach your spaces. So you sign in to {cli.name} once
          more here, with {cli.name}’s own sign-in in your browser. Phaethon never sees your password or what {cli.name} saves.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={startRef}
            type="button"
            variant="outline"
            data-cli-sign-in-start=""
            aria-describedby={descId}
            aria-disabled={waiting || undefined}
            onClick={() => void start()}
            className="aria-disabled:cursor-progress"
          >
            {waiting ? "Waiting for you to sign in in your browser…" : `Sign in to ${cli.name} for this Phaethon folder`}
          </Button>
          {waiting && (
            <Button ref={stopRef} type="button" variant="ghost" data-cli-sign-in-stop="" onClick={() => void cancelCliSignIn(id).catch(() => false)}>
              Stop signing in
            </Button>
          )}
        </div>
        {outcome && outcome.status !== "busy" && (
          <p
            data-cli-sign-in-outcome={outcome.status}
            className={cn("flex items-start gap-2 text-sm", outcome.status === "signedIn" ? "text-ink" : "text-ink-secondary")}
          >
            <Icon name={outcome.status === "signedIn" ? "check" : outcome.status === "cancelled" ? "info" : "warning"} className="mt-0.5 shrink-0" />
            <span className="min-w-0 wrap-anywhere">{outcome.message}</span>
          </p>
        )}
      </div>
    </SettingGroup>
  );
}

/** Anthropic as an older core describes it (no provider list). */
const ANTHROPIC_INFO: ProviderInfo = {
  id: "anthropic",
  name: "Anthropic",
  key: "required",
  local: false,
  editableBase: false,
  hasKey: false,
  baseUrl: "https://api.anthropic.com",
  defaultBaseUrl: "https://api.anthropic.com",
  model: null,
  keysUrl: CONSOLE_KEYS_URL,
  keyPrefix: "sk-ant-",
  ready: false,
};

/** The provider Phaethon's own agent uses, as Settings describes it. */
function chosenProvider(settings: Settings): ProviderInfo {
  const id = settings.provider ?? "anthropic";
  return settings.providers?.find((p) => p.id === id) ?? { ...ANTHROPIC_INFO, hasKey: settings.hasAnthropicKey };
}

/** The services first, then the ones on this computer, then one's own server. */
const PROVIDER_GROUPS: { label: string; test: (p: ProviderInfo) => boolean }[] = [
  { label: "Services", test: (p) => !p.local && p.id !== "custom" },
  { label: "On this computer", test: (p) => p.local },
  { label: "Other", test: (p) => p.id === "custom" },
];

/** Which provider runs the model: a native select, saved on change. */
function ProviderChoice({ settings, act }: { settings: Settings; act: Parameters<typeof AgentSection>[0]["act"] }) {
  const selectId = useId();
  const descId = useId();
  const list = settings.providers?.length ? settings.providers : [ANTHROPIC_INFO];
  const current = settings.provider ?? "anthropic";
  return (
    <SettingGroup title="Model provider">
      <SettingRow
        label="Provider"
        htmlFor={selectId}
        description="Who runs the model that writes Phaethon’s replies. Each service needs its own account and API key; a model on this computer needs neither, and nothing you send leaves the computer."
        descriptionId={descId}
      >
        <select
          id={selectId}
          data-provider-select=""
          value={current}
          aria-describedby={descId}
          onChange={(e) => {
            const p = list.find((x) => x.id === e.target.value);
            if (p) void act(() => setProvider(p.id), `Phaethon now answers with ${p.name}.`, undefined, false);
          }}
          className="min-h-(--ph-control-height-lg) w-full rounded-md border border-line-strong bg-raised px-2.5 text-base text-ink shadow-sm hover:bg-hover"
        >
          {PROVIDER_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {list.filter(g.test).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.local ? " (on this computer)" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </SettingRow>
    </SettingGroup>
  );
}

/** Whether an address is this computer's own (mirrors providers.rs `is_loopback`). */
const isLoopback = (url: string) => {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "[::1]" || /^127\./.test(h);
  } catch {
    return false;
  }
};

/** `https://openrouter.ai/settings/keys` → `openrouter.ai`. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** A provider other than Anthropic: its address (servers on this computer and one's own), whether it runs, and its key. */
function ProviderSetup({ provider, act }: { provider: ProviderInfo; act: Parameters<typeof AgentSection>[0]["act"] }) {
  return (
    <>
      {provider.editableBase && (
        <SettingGroup title={provider.local ? `Where ${provider.name} runs` : "Your server’s address"}>
          <AddressForm provider={provider} act={act} />
        </SettingGroup>
      )}
      {provider.key !== "none" && (
        <SettingGroup
          title={provider.id === "custom" ? "API key" : `${provider.name} API key`}
          description={provider.id === "custom" ? "Only if your server asks for one." : undefined}
        >
          <KeyForm hasKey={provider.hasKey} act={act} provider={provider} />
        </SettingGroup>
      )}
    </>
  );
}

/**
 * The address of a server on this computer or one's own, and whether
 * something answers there, checked when shown and after each change, and
 * again on Check again. Saved with Save (or Enter); the usual address comes back with its own button.
 */
function AddressForm({ provider, act }: { provider: ProviderInfo; act: Parameters<typeof AgentSection>[0]["act"] }) {
  const { say } = useStatus();
  const [draft, setDraft] = useState(provider.baseUrl);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const statusId = useId();
  const changed = !!provider.defaultBaseUrl && provider.baseUrl !== provider.defaultBaseUrl;

  useEffect(() => setDraft(provider.baseUrl), [provider.baseUrl]);

  async function check(announce: boolean) {
    if (!provider.baseUrl) return;
    setChecking(true);
    let s: ServerStatus;
    try {
      s = await providerStatus(provider.id);
    } catch (e) {
      s = { running: false, models: [], message: String(e) };
    }
    setChecking(false);
    setStatus(s);
    if (announce) say(s.message);
  }

  useEffect(() => {
    void check(false);
    // Checked again whenever the saved address changes.
  }, [provider.id, provider.baseUrl]);

  async function save(url: string | null) {
    setError("");
    await act(() => setProviderUrl(provider.id, url), url ? "Address saved." : `${provider.name}’s usual address is back.`, setError);
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-3 px-4 py-3.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft.trim() || null);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-base font-medium text-ink">
          Address
        </label>
        <p id={hintId} className="text-sm text-ink-secondary">
          {provider.local
            ? `Where ${provider.name} answers. Usually ${provider.defaultBaseUrl}; change it only if you set ${provider.name} up differently.`
            : "Your server’s address for OpenAI-style requests, often ending in /v1, for example https://llm.example.com/v1."}
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            id={inputId}
            data-provider-url=""
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (error) setError("");
            }}
            aria-describedby={[hintId, error && errorId].filter(Boolean).join(" ")}
            aria-invalid={error ? true : undefined}
            className="min-h-(--ph-control-height-lg) min-w-(--ph-settings-label-min) flex-1 rounded-md border border-line-strong bg-bg px-3 py-1.5 font-mono text-base text-ink aria-invalid:border-danger"
          />
          <Button type="submit" className="min-h-(--ph-control-height-lg)" data-provider-url-save="">
            Save
          </Button>
        </div>
        {error && (
          <p id={errorId} className="flex items-start gap-1.5 text-sm text-danger-ink">
            <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
            <span className="min-w-0">{error}</span>
          </p>
        )}
        {changed && (
          <Button type="button" variant="outline" className="self-start" onClick={() => void save(null)}>
            Use the usual address
          </Button>
        )}
      </div>
      {provider.baseUrl && (
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2" data-provider-status={status ? (status.running ? "running" : "stopped") : "checking"}>
          <p id={statusId} className={cn("flex min-w-0 flex-[1_1_16em] items-start gap-1.5 text-sm", status?.running ? "text-success-ink" : status ? "text-warning-ink" : "text-ink-secondary")}>
            <Icon name={!status ? "spinner" : status.running ? "check" : "warning"} className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
            <span className="min-w-0 wrap-anywhere">{status ? status.message : `Checking whether ${provider.local ? provider.name : "your server"} is running…`}</span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-provider-check=""
            aria-describedby={statusId}
            aria-disabled={checking || undefined}
            className="aria-disabled:cursor-progress"
            onClick={() => !checking && void check(true)}
          >
            <Icon name="retry" />
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      )}
    </form>
  );
}

/** Another provider's default model: what is in use, then its list to search, or a name to type. */
function ProviderModel({ provider, act }: { provider: ProviderInfo; act: Parameters<typeof AgentSection>[0]["act"] }) {
  const inUseId = useId();
  const current = provider.model;
  return (
    <>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <p id={inUseId} data-provider-model={current ?? ""} className="text-base text-ink">
          {current ? (
            <>
              Phaethon answers with <span className="font-medium">{modelName(toRef(provider.id, current))}</span>.
            </>
          ) : (
            `No model is chosen for ${provider.id === "custom" ? "your server" : provider.name} yet. Choose one below, or type its name.`
          )}
        </p>
        <ModelSearch
          provider={provider}
          current={current}
          label="Default model"
          onChoose={(id, name) => {
            if (id === current) return;
            void act(() => setProviderModel(provider.id, id), `The default model is now ${provider.name} · ${name}.`);
          }}
        />
        <p className="text-sm text-ink-secondary">
          A space can choose its own model, from any provider you’ve set up: use the model button beside Send, or Change model in {modCap()}{" "}
          K.
        </p>
      </div>
      <OwnModels />
    </>
  );
}

/** The key field: Check and save, the result in words, and Remove saved key. */
function KeyForm({
  hasKey,
  act,
  provider = ANTHROPIC_INFO,
}: {
  hasKey: boolean;
  act: Parameters<typeof AgentSection>[0]["act"];
  provider?: ProviderInfo;
}) {
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
      result = await checkAndSave(keyDraft, skipCheck, undefined, provider.id);
    }, "");
    setSaving(false);
    setOutcome(result);
    say(outcomeTextFor(result, provider));
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
    const ok = await act(() => clearApiKey(provider.id), `API key removed from ${KEY_STORE}.`);
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
        ) : provider.id === "custom" ? (
          <p className="min-w-0">
            If your server asks for a key, paste it here. It’s sent only to {hostOf(provider.baseUrl) || "your server’s address"}, and kept in{" "}
            {KEY_STORE}, never in your Phaethon folder. If the address changes, save the key again.
          </p>
        ) : provider.id !== "anthropic" ? (
          <p className="min-w-0">
            The key comes from {provider.name}: a pay-as-you-go account with them, separate from any chat subscription. Create a key at{" "}
            <ExternalLink href={provider.keysUrl}>{hostOf(provider.keysUrl)}</ExternalLink>, then paste it here. It’s sent only to{" "}
            {provider.name}, and kept in {KEY_STORE}, never in your Phaethon folder, so it never syncs.
          </p>
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
        {outcome && <KeyOutcomeLine id={outcomeId} outcome={outcome} provider={provider} />}
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
                {provider.id === "anthropic"
                  ? `Remove the saved key from ${KEY_STORE}? Phaethon can’t answer in your spaces until you add a key again or switch to Claude Code.`
                  : provider.key === "optional"
                    ? `Remove the saved key from ${KEY_STORE}? Phaethon will ask your server without one.`
                    : `Remove the saved key from ${KEY_STORE}? Phaethon can’t answer with ${provider.name} until you add a key again.`}
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
export function KeyOutcomeLine({ id, outcome, provider = ANTHROPIC_INFO }: { id: string; outcome: KeyOutcome; provider?: ProviderInfo }) {
  const anthropic = provider.id === "anthropic";
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
        {outcomeTextFor(outcome, provider)}
        {anthropic && outcome.kind === "no-credit" && (
          <>
            {" "}
            <ExternalLink href={CONSOLE_BILLING_URL}>Open Billing</ExternalLink>
          </>
        )}
        {outcome.kind === "problem" && outcome.problem === "rejected" && (anthropic || provider.keysUrl) && (
          <>
            {" "}
            <ExternalLink href={anthropic ? CONSOLE_KEYS_URL : provider.keysUrl}>Open API keys</ExternalLink>
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
    const name = id ? nameOf(id) : `the recommended one, ${nameOf(DEFAULT_MODEL)}`;
    void act(() => setModel(id), `The default model is now ${name}.`);
  }

  return (
    <>
    <SettingRow
      stacked
      label="Default model"
      htmlFor={selectId}
      description={
        <>
          Which Claude model writes Phaethon’s replies. Larger models handle harder questions and cost more per message; smaller ones are
          faster and cheaper. A space can choose its own: use the model button beside Send, or Change model in {modCap()} K.
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
    <OwnModels />
    </>
  );
}

/**
 * The spaces that chose their own model, each with a way back to the default.
 * Nothing when every space uses the default.
 */
function OwnModels() {
  const s = useModels();
  const { spaces } = useSpaces();
  const { say, fail } = useStatus();
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const own = spaces.filter((sp) => s.own[sp.id]);
  if (!own.length) return null;

  async function reset(id: string, name: string, at: number) {
    try {
      await setSpaceModel(id, null);
      say(changedText(name, null, s));
      // The row goes; focus the next one's button, or the default model's select when none is left.
      requestAnimationFrame(() => {
        const buttons = listRef.current?.querySelectorAll<HTMLElement>("[data-own-model-reset]");
        const next = buttons?.[Math.min(at, buttons.length - 1)];
        (next ?? document.querySelector<HTMLElement>("[data-model-select]"))?.focus();
      });
    } catch (e) {
      fail(`The model couldn’t be changed. ${String(e)}`);
    }
  }

  return (
    <div className="flex flex-col gap-2 px-4 py-3.5" data-own-models="">
      <p id={titleId} className="text-base font-medium text-ink">
        Spaces with their own model
      </p>
      <ul ref={listRef} aria-labelledby={titleId} className="flex flex-col gap-2">
        {own.map((sp, i) => (
          <li key={sp.id} data-own-model={sp.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 text-base text-ink">
              {sp.name}: <span className="text-ink-secondary">{modelName(s.own[sp.id], s.models)}</span>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-own-model-reset={sp.id}
              aria-label={`Use the default model in ${sp.name}`}
              onClick={() => void reset(sp.id, sp.name, i)}
            >
              Use the default
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What leaves this computer, when, and where the rules for it are. */
function SentDisclosure({ backend, provider }: { backend: Backend; provider: ProviderInfo }) {
  const { go } = useSettingsNav();
  // A CLI always sends to its own company, whichever provider Phaethon's own assistant would use.
  const cli = cliOf(backend);
  const p = backend === "phaethon" ? provider : ANTHROPIC_INFO;
  const anthropic = cli ? cli.id === "claude" : p.id === "anthropic";
  const here = !cli && p.local && isLoopback(p.baseUrl);
  const to = p.id === "custom" ? `your server (${hostOf(p.baseUrl) || "no address yet"})` : p.name;
  return (
    <SettingGroup title={cli ? `What is sent to ${cli.company}` : here ? `What ${p.name} gets` : `What is sent to ${p.id === "custom" ? "your server" : p.name}`}>
      <div data-disclosure="" className="flex flex-col gap-2.5 px-4 py-3.5 text-sm text-ink-secondary">
        {backend === "phaethon" ? (
          <>
            <p className="text-base text-ink">
              {here
                ? `${p.name} runs on this computer, so none of this leaves it. With every message, Phaethon gives ${p.name}:`
                : `Nothing is sent until you send a message. Then, with every message, Phaethon sends ${to}:`}
            </p>
            <ul className="flex list-disc flex-col gap-1 ps-5">
              <li>your message and the conversation so far in that space</li>
              <li>any files you attach</li>
              <li>the files Phaethon opens to answer you, in that space or in another space you let it read</li>
              <li>the names of your other spaces, and the folders and files you’ve let this space read in them</li>
              <li>
                your MANUAL.md, a note in your Phaethon folder where you tell the assistant how you like it to work. It’s read in every space.
              </li>
            </ul>
            <p>
              Anything Phaethon reads from another space is saved in this space’s conversation, in this space’s folder, and syncs with it.
            </p>
          </>
        ) : (
          <>
            <p className="text-base text-ink">
              {cli?.name} sends your messages, and the files it reads to answer, to {cli?.company} under {cli?.account}, with every message.
            </p>
            {isOwnHome(backend) && cli ? (
              <>
                <p data-cli-history="">
                  {cli.name} also keeps its own copy of each conversation, in its setup for this Phaethon folder (in Phaethon’s own app data,
                  not your home folder). Deleting a conversation in Phaethon doesn’t delete that copy.
                </p>
                <p data-cli-own-setup="">
                  Your own {OWN_FILE[backend]} and {cli.name} settings and hooks in the {cli.folder} folder in your home folder aren’t sent and
                  don’t run here: {cli.name} uses a setup of its own for this Phaethon folder.
                </p>
              </>
            ) : (
              <p data-cli-history="">
                {cli?.name} also keeps its own copy of each conversation, usually in the hidden {cli?.folder} folder in your home folder.
                Deleting a conversation in Phaethon doesn’t delete that copy.
              </p>
            )}
          </>
        )}
        {cli && cli.id !== "claude" ? (
          <p>
            How long {cli.company} keeps it and what they may use it for is in {cli.company}’s own privacy policy.
          </p>
        ) : anthropic ? (
          <p>
            How long Anthropic keeps it and what they may use it for is in{" "}
            <ExternalLink href={ANTHROPIC_PRIVACY_URL}>Anthropic’s privacy policy</ExternalLink>.
          </p>
        ) : p.id === "openrouter" ? (
          <p>OpenRouter passes it on to the company that runs the model you chose. How long each keeps it, and what they may use it for, is in their own privacy policies.</p>
        ) : p.local || p.id === "custom" ? null : (
          <p>How long {p.name} keeps it and what they may use it for is in {p.name}’s own privacy policy.</p>
        )}
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
