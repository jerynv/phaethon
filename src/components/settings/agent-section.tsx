import { Input } from "@/components/ui/input";
import { Card, NativeSelect } from "vic-ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import {
  agentClis,
  cancelCliSignIn,
  CLI_INFO,
  clearApiKey,
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
  type ProviderId,
  type ProviderInfo,
  type ServerStatus,
  type Settings,
} from "@/lib/backend";
import { changedText, loadCliModels, modelName, setSpaceModel, toRef, useModels } from "@/lib/space-model";
import { useSpaces } from "@/lib/spaces";

import {
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
import { CLAUDE_CODE_MISSING, checkClaudeCode } from "./claude-code";
import { ModelSearch } from "./model-search";
import { SectionHeader, SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";

const CLI_BACKENDS: CliBackend[] = ["claude-cli", "codex-cli", "gemini-cli"];
const cliMissingText = (b: CliBackend) =>
  b === "claude-cli" ? CLAUDE_CODE_MISSING : `${CLI_INFO[b].name} is not installed. Install it, then try again.`;
type OwnHomeBackend = Exclude<CliBackend, "claude-cli">;
const isOwnHome = (b: Backend): b is OwnHomeBackend => isCliBackend(b) && b !== "claude-cli";

function cliStatusText(s: AgentCliStatus | undefined): string {
  if (!s) return "Checking installation…";
  if (!s.installed) return "Not installed";
  if (s.loggedIn === true) return "Signed in";
  if (s.loggedIn === false) return "Sign-in required";
  return "Installed";
}

export type AgentFocusRequest = { target: "key" | "model"; n: number; closeSettingsOnClose: boolean };
type ProviderPopup = { kind: "catalog" } | { kind: "provider"; id: ProviderId } | { kind: "cli"; backend: CliBackend };

/** Links that leave Phaethon: underlined, and say they open in the browser. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent-ink underline decoration-1 underline-offset-2 hover:decoration-2">
      {children}
      <span className="sr-only"> (opens in your browser)</span>
    </a>
  );
}

/** Provider rows and focused setup dialogs follow T3 Code's ProviderSettingsPanel,
 * ProviderInstanceCard, and AddProviderInstanceDialog (MIT, https://github.com/pingdotgg/t3code).
 * Phaethon keeps one configuration per service; managing a row never selects it as the default.
 */
export function AgentSection({
  headingId, settings, loadError, retryLoad, act, focusRequest, onRequestedProviderClose,
}: {
  headingId: string;
  settings: Settings | null;
  loadError: string;
  retryLoad: () => Promise<boolean>;
  focusRequest?: AgentFocusRequest | null;
  onRequestedProviderClose?: (n: number) => void;
  act: (work: () => Promise<void>, done: string, onError?: (message: string) => void, reloadThread?: boolean) => Promise<boolean>;
}) {
  const { say } = useStatus();
  const [retrying, setRetrying] = useState(false);
  const [popup, setPopup] = useState<ProviderPopup | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [actionError, setActionError] = useState("");
  const [changingDefault, setChangingDefault] = useState(false);
  const [cliMissing, setCliMissing] = useState<CliBackend | null>(null);
  const [clis, setClis] = useState<AgentCliStatus[] | null>(null);
  const backendAsked = useRef<Backend | null>(null);
  const popupTitleRef = useRef<HTMLHeadingElement>(null);
  const popupContentRef = useRef<HTMLDivElement>(null);
  const handledFocusRequest = useRef<number | null>(null);
  const requestedPopup = useRef<AgentFocusRequest | null>(null);
  const pendingProviderFocus = useRef<{ providerId: ProviderId; selector: string } | null>(null);
  const previousPopup = useRef<ProviderPopup | null>(null);
  const closingToChat = useRef(false);
  const provider = settings ? chosenProvider(settings) : ANTHROPIC_INFO;
  const providers = settings?.providers?.length ? settings.providers : [{ ...ANTHROPIC_INFO, hasKey: settings?.hasAnthropicKey ?? false, model: settings?.model ?? null, ready: settings?.hasAnthropicKey ?? false }];
  const statusOf = (b: CliBackend) => clis?.find((c) => c.id === CLI_INFO[b].id);
  const refreshClis = () => agentClis().then((c) => setClis(c), () => {});

  useEffect(() => { void refreshClis(); }, [settings?.backend]);
  useEffect(() => { setActionError(""); }, [popup]);
  useLayoutEffect(() => {
    if (!focusRequest || !settings || handledFocusRequest.current === focusRequest.n) return;
    handledFocusRequest.current = focusRequest.n;
    requestedPopup.current = focusRequest;
    const target = chosenProvider(settings);
    pendingProviderFocus.current = {
      providerId: target.id,
      selector: focusRequest.target === "key" && target.key !== "none" ?
        "[data-key-input]" : "[data-model-select], [data-model-query]",
    };
    setPopup((current) => current?.kind === "provider" && current.id === target.id ?
      current : { kind: "provider", id: target.id });
  }, [focusRequest, settings]);

  function focusRequestedProviderField() {
    const pending = pendingProviderFocus.current;
    if (!pending || popup?.kind !== "provider" || popup.id !== pending.providerId) return false;
    const field = popupContentRef.current?.querySelector<HTMLElement>(pending.selector);
    if (!field) return false;
    pendingProviderFocus.current = null;
    field.focus();
    field.scrollIntoView({ block: "nearest" });
    return true;
  }

  useLayoutEffect(() => {
    const changed = previousPopup.current !== popup;
    previousPopup.current = popup;
    if (focusRequestedProviderField()) return;
    if (changed && popup && !pendingProviderFocus.current) popupTitleRef.current?.focus();
  }, [popup, settings, focusRequest]);
  useEffect(() => {
    if (settings && isCliBackend(settings.backend)) void loadCliModels(CLI_INFO[settings.backend].id, true);
  }, [settings?.backend]);

  function chooseBackend(backend: CliBackend) {
    if (backendAsked.current || changingDefault) return;
    backendAsked.current = backend;
    setChangingDefault(true);
    setActionError("");
    setCliMissing(null);
    void (async () => {
      const status = backend === "claude-cli"
        ? await checkClaudeCode()
        : (await agentClis().catch(() => null))?.find((c) => c.id === CLI_INFO[backend].id);
      if (status && !status.installed) {
        setCliMissing(backend);
        say(cliMissingText(backend));
        return;
      }
      await act(() => setBackend(backend), `Now using ${CLI_INFO[backend].name}.`, setActionError, true);
    })().finally(() => { backendAsked.current = null; setChangingDefault(false); });
  }

  function useProvider(p: ProviderInfo) {
    if (changingDefault) return;
    setChangingDefault(true);
    setActionError("");
    void act(async () => {
      await setProvider(p.id);
      if (settings?.backend !== "phaethon") await setBackend("phaethon");
    }, `Now using ${p.name}.`, setActionError, settings?.backend !== "phaethon").finally(() => setChangingDefault(false));
  }

  async function retry() {
    if (retrying) return;
    setRetrying(true);
    const ok = await retryLoad();
    setRetrying(false);
    say(ok ? "Settings loaded." : "Settings still could not be loaded.");
    if (ok) requestAnimationFrame(() => document.getElementById(headingId)?.focus());
  }

  const activeName = settings && isCliBackend(settings.backend) ? CLI_INFO[settings.backend].name : provider.name;
  const configuredProviders = providers.filter((p) =>
    p.hasKey || p.ready || (p.id !== "anthropic" && p.model !== null) ||
    (p.editableBase && p.baseUrl !== p.defaultBaseUrl) ||
    (settings?.backend === "phaethon" && provider.id === p.id),
  );
  const configuredClis = CLI_BACKENDS.filter((b) => statusOf(b)?.installed || settings?.backend === b);
  const editingProvider = popup?.kind === "provider" ? providers.find((p) => p.id === popup.id) : undefined;
  const editingCli = popup?.kind === "cli" ? popup.backend : undefined;
  const editingIsDefault = editingProvider ? settings?.backend === "phaethon" && provider.id === editingProvider.id : editingCli === settings?.backend;

  function missingCli(backend: CliBackend) {
    return (
      <p data-cli-missing={backend} role="status" className="text-sm text-warning-ink">
        {cliMissingText(backend)}{" "}
        <ExternalLink href={CLI_INFO[backend].installUrl}>Install {CLI_INFO[backend].name}</ExternalLink>
      </p>
    );
  }

  function closePopup() {
    const requested = requestedPopup.current;
    requestedPopup.current = null;
    pendingProviderFocus.current = null;
    closingToChat.current = requested?.closeSettingsOnClose ?? false;
    setPopup(null);
    setCliMissing(null);
    if (requested) onRequestedProviderClose?.(requested.n);
  }

  return (
    <>
      <SectionHeader
        id={headingId} title="Assistant" description="Manage providers and choose your default assistant."
        action={settings && (
          <Button variant="outline" size="sm" data-provider-add="" onClick={() => setPopup({ kind: "catalog" })}>
            <Icon name="plus" />Add provider
          </Button>
        )}
      />
      {!settings ? loadError ? (
        <LoadProblem raw={loadError}>
          <Button type="button" variant="outline" size="sm" aria-disabled={retrying || undefined} onClick={() => void retry()}>
            <Icon name="retry" />
            {retrying ? "Trying again…" : "Try again"}
          </Button>
        </LoadProblem>
      ) : (
        <p className="text-base text-ink-secondary" role="status">Loading assistant settings…</p>
      ) : (
        <>
          <SettingGroup title="Default assistant">
            <SettingRow
              label={activeName}
              description={isCliBackend(settings.backend) ? "Uses its own default model." :
                provider.model || provider.id === "anthropic" ?
                  modelName(toRef(provider.id, provider.model ?? settings.model)) : "Choose a default model."}
            >
              <Button
                variant="outline" size="sm" className="self-end" data-assistant-default-manage=""
                onClick={() => setPopup(isCliBackend(settings.backend) ?
                  { kind: "cli", backend: settings.backend } : { kind: "provider", id: provider.id })}
              >
                Manage
              </Button>
            </SettingRow>
          </SettingGroup>
          <SettingGroup title="Providers" bare>
            <Card plain className="overflow-hidden rounded-lg p-0!">
              <div className="divide-y divide-line">
                {configuredProviders.map((p) => {
                  const active = settings.backend === "phaethon" && provider.id === p.id;
                  return (
                    <div key={p.id} data-provider-row={p.id} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
                      <Icon name={p.local ? "tool" : "agent"} className="shrink-0 text-ink-secondary" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-ink">
                          {p.name}
                          {active && <span className="ms-2 text-xs font-normal text-ink-secondary">Default</span>}
                        </p>
                        <p className="text-xs text-ink-secondary" data-provider-readiness={p.ready ? "configured" : "needs-setup"}>
                          {p.ready ? "Configured" : "Needs setup"}
                        </p>
                      </div>
                      {!active && (
                        <Button variant="ghost" size="sm" data-provider-default={p.id} disabled={changingDefault} onClick={() => useProvider(p)}>
                          Use as default
                        </Button>
                      )}
                      <Button variant="outline" size="sm" data-provider-configure={p.id} onClick={() => setPopup({ kind: "provider", id: p.id })}>
                        Manage
                      </Button>
                    </div>
                  );
                })}
                {configuredClis.map((b) => (
                  <div key={b} data-provider-row={b} className="flex min-w-0 flex-wrap items-center gap-3 px-4 py-3">
                    <Icon name="tool" className="shrink-0 text-ink-secondary" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">
                        {CLI_INFO[b].name}
                        {settings.backend === b && <span className="ms-2 text-xs font-normal text-ink-secondary">Default</span>}
                      </p>
                      <p
                        className="text-xs text-ink-secondary"
                        data-cli-status={!statusOf(b) ? "checking" : !statusOf(b)?.installed ? "missing" :
                          statusOf(b)?.loggedIn === false ? "signed-out" : "installed"}
                      >
                        {cliStatusText(statusOf(b))}
                      </p>
                    </div>
                    {settings.backend !== b && (
                      <Button variant="ghost" size="sm" data-backend={b} disabled={changingDefault} onClick={() => chooseBackend(b)}>
                        Use as default
                      </Button>
                    )}
                    <Button
                      variant="outline" size="sm" data-provider-configure={b}
                      onClick={() => { setCliMissing(null); setPopup({ kind: "cli", backend: b }); }}
                    >
                      Manage
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          </SettingGroup>
          {cliMissing && !popup && missingCli(cliMissing)}
          {actionError && !popup && <p role="alert" className="text-sm text-danger-ink">{actionError}</p>}
        </>
      )}
      <Dialog open={popup !== null} onOpenChange={(open) => { if (!open && !signingIn) closePopup(); }}>
        <DialogContent
          ref={popupContentRef}
          className="flex flex-col overflow-hidden"
          showCloseButton={!signingIn} data-provider-popup={popup?.kind}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (focusRequestedProviderField()) return;
            if (!popupContentRef.current?.contains(document.activeElement)) popupTitleRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (closingToChat.current) e.preventDefault();
            closingToChat.current = false;
          }}
          onEscapeKeyDown={(e) => { if (signingIn) e.preventDefault(); }}
          onInteractOutside={(e) => { if (signingIn) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle ref={popupTitleRef} tabIndex={-1}>
              {popup?.kind === "catalog" ? "Add provider" : editingProvider?.name ?? (editingCli ? CLI_INFO[editingCli].name : "Provider")}
            </DialogTitle>
            <DialogDescription>
              {popup?.kind === "catalog" ? "Choose a provider to configure." :
                editingCli ? "Manage this assistant’s setup." : "Configure your connection and default model."}
            </DialogDescription>
          </DialogHeader>
          <ScrollArea
            data-provider-popup-body=""
            className="flex min-h-0 flex-auto flex-col [&>.ui-scroll-area-viewport]:min-h-0 [&>.ui-scroll-area-viewport]:h-auto [&>.ui-scroll-area-viewport]:flex-auto [&>.ui-scroll-area-viewport]:scroll-py-4"
          >
            <div className="space-y-4 p-1">
              {popup?.kind === "catalog" ? (
                <div className="flex flex-col gap-4" data-provider-catalog="">
                  {PROVIDER_GROUPS.filter((g) => providers.some(g.test)).map((g) => (
                    <div key={g.label}>
                      <p className="mb-2 text-xs font-medium text-ink-secondary">{g.label}</p>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {providers.filter(g.test).map((p) => (
                          <Button
                            key={p.id} variant="outline" className="[&>.ui-button-face]:justify-start" data-provider-catalog-select={p.id}
                            onClick={() => setPopup({ kind: "provider", id: p.id })}
                          >
                            {p.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div>
                    <p className="mb-2 text-xs font-medium text-ink-secondary">Coding assistants</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {CLI_BACKENDS.map((b) => (
                        <Button
                          key={b} variant="outline" className="[&>.ui-button-face]:justify-start" data-provider-catalog-select={b}
                          onClick={() => { setCliMissing(null); setPopup({ kind: "cli", backend: b }); }}
                        >
                          {CLI_INFO[b].name}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : editingProvider ? (
                <div className="flex flex-col gap-4" data-provider-configuration={editingProvider.id}>
                  {editingProvider.id === "anthropic" ? (
                    <SettingGroup title="API key">
                      <KeyForm hasKey={editingProvider.hasKey} act={act} provider={editingProvider} />
                    </SettingGroup>
                  ) : <ProviderSetup provider={editingProvider} act={act} />}
                  <SettingGroup title="Model">
                    {editingProvider.id === "anthropic" ?
                      <ModelPicker current={settings?.model ?? DEFAULT_MODEL} act={act} /> :
                      <ProviderModel provider={editingProvider} act={act} />}
                  </SettingGroup>
                </div>
              ) : editingCli ? (
                <div className="flex flex-col gap-4" data-provider-configuration={editingCli}>
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm text-ink-secondary">{cliStatusText(statusOf(editingCli))}</p>
                    <Button variant="ghost" size="sm" data-provider-refresh="" disabled={signingIn} onClick={() => void refreshClis()}>
                      <Icon name="retry" />Check again
                    </Button>
                  </div>
                  {statusOf(editingCli)?.installed === false || cliMissing === editingCli ? missingCli(editingCli) :
                    isOwnHome(editingCli) ? (
                      <CliSignInGroup key={editingCli} backend={editingCli} signedIn={statusOf(editingCli)?.loggedIn === true} onSignedIn={refreshClis} onWaitingChange={setSigningIn} />
                    ) : (
                      <p className="text-sm text-ink-secondary">
                        Sign in to Claude Code in a terminal with <code>claude</code>, then return here.
                      </p>
                    )}
                  <p className="text-sm text-ink-secondary" data-cli-model-default="">Models are chosen in each space.</p>
                </div>
              ) : null}
              {actionError && <p role="alert" className="text-sm text-danger-ink">{actionError}</p>}
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0 flex-row flex-wrap">
            {popup?.kind !== "catalog" && (
              <Button variant="ghost" disabled={signingIn} onClick={() => { setCliMissing(null); setPopup({ kind: "catalog" }); }}>
                All providers
              </Button>
            )}
            {popup?.kind !== "catalog" && !editingIsDefault && (
              <Button
                variant="outline" disabled={signingIn || changingDefault} data-backend={editingCli ?? "phaethon"} data-provider-default={editingProvider?.id}
                onClick={() => { if (editingProvider) useProvider(editingProvider); else if (editingCli) chooseBackend(editingCli); }}
              >
                Use as default
              </Button>
            )}
            <Button disabled={signingIn} onClick={closePopup}>{popup?.kind === "catalog" ? "Cancel" : "Done"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Signing in to Codex or Gemini CLI for this Phaethon folder's own setup, with the CLI's own sign-in in
 * the browser. Keyboard: the sign-in button keeps focus while it waits (it says so, and can't be pressed
 * twice); Stop signing in sits beside it and, as it goes, hands focus back to the sign-in button. The
 * outcome is said through the status line and stays shown.
 */
function CliSignInGroup({ backend, signedIn, onSignedIn, onWaitingChange }: { backend: OwnHomeBackend; signedIn: boolean; onSignedIn: () => void; onWaitingChange: (waiting: boolean) => void }) {
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
    onWaitingChange(true);
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
    onWaitingChange(false);
    setOutcome(out);
    say(out.message);
    if (out.status === "signedIn") onSignedIn();
  }

  return (
    <SettingGroup title="Account">
      <div data-cli-sign-in={id} className="flex flex-col gap-3 px-4 py-3.5">
        <p id={descId} className={cn("text-sm text-ink-secondary", signedIn && !waiting && "sr-only")}>
          {waiting ? "Finish signing in in your browser." : signedIn ?
            `Change your ${cli.name} account in your browser.` : `Sign in to ${cli.name} in your browser to connect it here.`}
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
            {waiting ? "Waiting for browser sign-in…" : signedIn ? "Change account" : `Sign in to ${cli.name}`}
          </Button>
          {waiting && (
            <Button ref={stopRef} type="button" variant="ghost" data-cli-sign-in-stop="" onClick={() => void cancelCliSignIn(id).catch(() => false)}>
              Cancel
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
          <Input
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
            className="min-w-(--ph-settings-label-min) flex-1 font-mono"
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
              Default: <span className="font-medium">{modelName(toRef(provider.id, current))}</span>.
            </>
          ) : (
            "Choose a default model, or enter its name."
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
          Each space can choose another model beside Send.
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
        <p className="min-w-0">{hasKey ? "A key is saved. Paste a new key to replace it." : provider.key === "optional" ? "Add a key only if your server requires one." : <>Paste your {provider.name} API key. {provider.keysUrl && <ExternalLink href={provider.keysUrl}>Get API key</ExternalLink>}</>}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-base font-medium text-ink">
          {hasKey ? "New API key" : "API key"}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
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
            className="min-w-(--ph-settings-label-min) flex-1 font-mono"
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
          Each space can choose another model beside Send.
          {listFailed && " Phaethon couldn’t fetch the full list just now, so only the default is shown."}
        </>
      }
      descriptionId={descId}
    >
      <NativeSelect
        id={selectId}
        data-model-select=""
        value={value}
        onChange={(e) => choose(e.target.value)}
        aria-describedby={descId}
        aria-busy={models === null || undefined}
        className="w-full"
      >
        <option value={DEFAULT_OPTION}>Default (recommended): {nameOf(DEFAULT_MODEL)}</option>
        {others.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </NativeSelect>
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
