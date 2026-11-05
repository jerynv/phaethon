import { Input } from "@/components/ui/input";
import { NativeSelect } from "vic-ui";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { ProviderLogo } from "@/components/provider-logo";
import { Details } from "@/components/ui/details";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/icons";
import { cn } from "@/lib/utils";
import {
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
  type CliBackend,
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
import { AgentInstances, type AgentInstanceRequest } from "./agent-instances";
import { ModelSearch } from "./model-search";
import { SectionHeader } from "./controls";
import { useStatus } from "./status";

const CLI_BACKENDS: CliBackend[] = ["claude-cli", "codex-cli", "gemini-cli"];
export type AgentFocusRequest = { target: "key" | "model"; n: number; closeSettingsOnClose: boolean };
type ProviderPopup = { kind: "catalog" } | { kind: "provider"; id: ProviderId };

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
  headingId, settings, loadError, retryLoad, act, focusRequest, onRequestedProviderClose, onBusyChange,
}: {
  headingId: string;
  settings: Settings | null;
  loadError: string;
  retryLoad: () => Promise<boolean>;
  focusRequest?: AgentFocusRequest | null;
  onRequestedProviderClose?: (n: number) => void;
  onBusyChange?: (busy: boolean) => void;
  act: (work: () => Promise<void>, done: string, onError?: (message: string) => void, reloadThread?: boolean) => Promise<boolean>;
}) {
  const { say } = useStatus();
  const setupHintId = useId();
  const [retrying, setRetrying] = useState(false);
  const [popup, setPopup] = useState<ProviderPopup | null>(null);
  const [selectedApi, setSelectedApi] = useState<ProviderId | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const reportBusy = useCallback((busy: boolean) => { setConnectionBusy(busy); onBusyChange?.(busy); }, [onBusyChange]);
  const signingIn = false;
  const [instanceRequest, setInstanceRequest] = useState<AgentInstanceRequest | null>(null);
  const [actionError, setActionError] = useState("");
  const [changingDefault, setChangingDefault] = useState(false);
  const popupTitleRef = useRef<HTMLHeadingElement>(null);
  const popupContentRef = useRef<HTMLDivElement>(null);
  const handledFocusRequest = useRef<number | null>(null);
  const requestedPopup = useRef<AgentFocusRequest | null>(null);
  const pendingProviderFocus = useRef<{ providerId: ProviderId; selector: string } | null>(null);
  const previousPopup = useRef<ProviderPopup | null>(null);
  const closingToChat = useRef(false);
  const provider = settings ? chosenProvider(settings) : ANTHROPIC_INFO;
  const providers = settings?.providers?.length ? settings.providers : [{ ...ANTHROPIC_INFO, hasKey: settings?.hasAnthropicKey ?? false, model: settings?.model ?? null, ready: settings?.hasAnthropicKey ?? false }];
  useEffect(() => { setActionError(""); }, [popup]);
  useLayoutEffect(() => {
    if (!focusRequest || !settings || handledFocusRequest.current === focusRequest.n) return;
    handledFocusRequest.current = focusRequest.n;
    if (isCliBackend(settings.backend)) {
      pendingProviderFocus.current = null;
      setPopup(null);
      setSelectedApi(null);
      setInstanceRequest({ cli: CLI_INFO[settings.backend].id, n: focusRequest.n, closeSettingsOnClose: focusRequest.closeSettingsOnClose });
      return;
    }
    requestedPopup.current = focusRequest;
    const target = chosenProvider(settings);
    pendingProviderFocus.current = {
      providerId: target.id,
      selector: focusRequest.target === "key" && target.key !== "none" ?
        "[data-key-input]" : "[data-model-select], [data-model-query]",
    };
    setSelectedApi(target.id);
    setPopup((current) => current?.kind === "provider" && current.id === target.id ?
      current : { kind: "provider", id: target.id });
  }, [focusRequest, settings]);

  function focusRequestedProviderField() {
    const pending = pendingProviderFocus.current;
    if (!pending || selectedApi !== pending.providerId) return false;
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
  }, [popup, selectedApi, settings, focusRequest]);
  useEffect(() => {
    if (settings && isCliBackend(settings.backend)) void loadCliModels(CLI_INFO[settings.backend].id, true);
  }, [settings?.backend]);

  function useProvider(p: ProviderInfo) {
    if (changingDefault || !p.ready || !(p.model ?? (p.id === "anthropic" ? settings?.model ?? DEFAULT_MODEL : null))) return;
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

  const configuredProviders = providers.filter((p) =>
    p.hasKey || ((p.local || p.key === "none") && (p.model !== null || (p.editableBase && p.baseUrl !== p.defaultBaseUrl))),
  );
  const editingProvider = selectedApi ? providers.find((p) => p.id === selectedApi) : undefined;
  const editingIsDefault = editingProvider ? settings?.backend === "phaethon" && provider.id === editingProvider.id : false;
  const setupRequirement = !editingProvider ? "" : !editingProvider.ready ?
    editingProvider.key === "required" && !editingProvider.hasKey ? "Add an API key first." : "Save a server URL first." :
    !(editingProvider.model ?? (editingProvider.id === "anthropic" ? settings?.model ?? DEFAULT_MODEL : null)) ? "Choose a model first." : "";
  const defaultId = settings && isCliBackend(settings.backend) ? settings.backend : provider.id;
  const providerRows = [
    ...configuredProviders.map((p) => ({ id: p.id, provider: p, backend: null })),
  ].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));

  function closePopup() {
    if (popup?.kind === "catalog") { setPopup(selectedApi ? { kind: "provider", id: selectedApi } : null); return; }
    const requested = requestedPopup.current;
    requestedPopup.current = null;
    pendingProviderFocus.current = null;
    closingToChat.current = requested?.closeSettingsOnClose ?? false;
    setPopup(null);
    setSelectedApi(null);
    if (requested) onRequestedProviderClose?.(requested.n);
  }

  return (
    <>
      <SectionHeader
        id={headingId} title="Providers"
        action={settings && (
          <Button variant="ghost" size="icon-xs" data-provider-add="" disabled={connectionBusy} aria-label="Add connection" title="Add connection" onClick={() => setPopup({ kind: "catalog" })}>
            <Icon name="plus" />
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
          <AgentInstances onBusyChange={reportBusy} act={act} request={instanceRequest} backendVersion={settings.backend} onRequestedClose={onRequestedProviderClose}
            onInstanceSelected={() => { setSelectedApi(null); setPopup(null); pendingProviderFocus.current = null; }}
            serviceRows={providerRows.map(({ provider: p }) => <button type="button" key={p.id} data-provider-row={p.id} data-provider-configure={p.id}
              data-provider-default-row={p.id === defaultId || undefined} aria-label={`Manage ${p.name}`} aria-pressed={selectedApi === p.id} disabled={connectionBusy}
              onClick={() => { setSelectedApi(p.id); setPopup({ kind: "provider", id: p.id }); }} className="provider-instance-row">
              <ProviderLogo provider={p.id} className="size-5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-normal">{p.name}</span>
                {p.id === defaultId && <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-normal text-accent-ink">Default</span>}</span>
                <span data-provider-readiness={p.ready ? "configured" : "needs-setup"} className="truncate text-xs text-ink-secondary">{p.model ? modelName(toRef(p.id, p.model)) : p.ready ? "Configured" : "Needs setup"}</span>
              </span>
            </button>)}
            serviceDetail={editingProvider && <div ref={popupContentRef} data-provider-popup="provider" className="flex min-w-0 flex-col gap-4">
              <div className="flex items-center gap-2"><Button variant="ghost" size="icon-xs" className="provider-detail-back" aria-label="Back to connections" onClick={closePopup}><Icon name="chevron-left" /></Button>
                <ProviderLogo provider={editingProvider.id} className="size-5" /><h4 ref={popupTitleRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-sm font-normal text-ink outline-none">{editingProvider.name}</h4>
              </div>
              <div key={editingProvider.id} className="flex flex-col gap-5" data-provider-configuration={editingProvider.id}>
                {editingProvider.id === "anthropic" ? <KeyForm hasKey={editingProvider.hasKey} act={act} provider={editingProvider} /> : <ProviderSetup provider={editingProvider} act={act} />}
                <div className="border-t border-line pt-4">{editingProvider.id === "anthropic" ? <ModelPicker current={settings.model ?? DEFAULT_MODEL} act={act} /> : <ProviderModel provider={editingProvider} act={act} />}</div>
              </div>
              {actionError && <p role="alert" className="text-xs text-danger-ink">{actionError}</p>}
              <div data-slot="dialog-footer" className="flex flex-wrap items-center gap-2">
                {!editingIsDefault && <Button size="sm" disabled={changingDefault || !!setupRequirement} aria-describedby={setupRequirement ? setupHintId : undefined}
                  data-backend="phaethon" data-provider-default={editingProvider.id} onClick={() => useProvider(editingProvider)}>Use as default</Button>}
                {requestedPopup.current && <Button variant="ghost" size="sm" onClick={closePopup}>Done</Button>}
                {setupRequirement && !editingIsDefault && <p id={setupHintId} data-provider-requirement="" className="basis-full text-xs text-ink-secondary">{setupRequirement}</p>}
              </div>
            </div>} />
          {actionError && !popup && <p role="alert" className="text-sm text-danger-ink">{actionError}</p>}
        </>
      )}
      <Dialog open={popup?.kind === "catalog"} onOpenChange={(open) => { if (!open && !signingIn) closePopup(); }}>
        <DialogContent
          ref={popupContentRef}
          className="flex max-w-lg! flex-col overflow-hidden"
          showCloseButton={!signingIn} data-provider-popup={popup?.kind}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (focusRequestedProviderField()) return;
            if (!popupContentRef.current?.contains(document.activeElement)) popupTitleRef.current?.focus();
          }}
          onCloseAutoFocus={(e) => {
            if (closingToChat.current) e.preventDefault();
            if (selectedApi && popup?.kind === "provider") {
              e.preventDefault();
              requestAnimationFrame(() => { if (!focusRequestedProviderField()) popupTitleRef.current?.focus(); });
            }
            closingToChat.current = false;
          }}
          onEscapeKeyDown={(e) => { if (signingIn) e.preventDefault(); }}
          onInteractOutside={(e) => { if (signingIn) e.preventDefault(); }}
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center gap-3">
              {popup?.kind !== "catalog" && editingProvider && <ProviderLogo provider={editingProvider.id} className="size-9" />}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <DialogTitle ref={popupTitleRef} tabIndex={-1}>
                  {popup?.kind === "catalog" ? "Add connection" : editingProvider?.name ?? "Provider"}
                </DialogTitle>
                <DialogDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{popup?.kind === "catalog" ? "" : editingProvider?.local ? "Local connection" : editingProvider?.hasKey ? "API key saved" : "API connection"}</span>
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <ScrollArea
            data-provider-popup-body=""
            className="flex min-h-0 flex-auto flex-col [&>.ui-scroll-area-viewport]:min-h-0 [&>.ui-scroll-area-viewport]:h-auto [&>.ui-scroll-area-viewport]:flex-auto [&>.ui-scroll-area-viewport]:scroll-py-4"
          >
            <div className="space-y-4 p-1">
              {popup?.kind === "catalog" ? (
                <div className="flex flex-col gap-6" data-provider-catalog="">
                  {PROVIDER_GROUPS.filter((g) => providers.some(g.test)).map((g) => (
                    <div key={g.label}>
                      <p className="mb-2 text-xs font-normal text-ink-secondary">{g.label}</p>
                      <div className="flex flex-col gap-1">
                        {providers.filter(g.test).map((p) => (
                          <Button
                            key={p.id} variant="ghost" className="w-full text-start [&>.ui-button-face]:w-full [&>.ui-button-face]:min-h-8 [&>.ui-button-face]:justify-start [&>.ui-button-face]:gap-2 [&>.ui-button-face]:px-2 [&>.ui-button-face]:py-1.5" data-provider-catalog-select={p.id}
                            onClick={() => { setSelectedApi(p.id); setPopup({ kind: "provider", id: p.id }); }}
                          >
                            <ProviderLogo provider={p.id} className="size-4" />
                            <span className="min-w-0 flex-1 text-sm font-normal">{p.name}</span>
                            {providerRows.some((row) => row.id === p.id) && <Icon name="check" className="text-ink-tertiary" />}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div>
                    <p className="mb-2 text-xs font-normal text-ink-secondary">Coding assistants</p>
                    <div className="flex flex-col gap-1">
                      {CLI_BACKENDS.map((b) => (
                        <Button
                          key={b} variant="ghost" className="w-full text-start [&>.ui-button-face]:w-full [&>.ui-button-face]:min-h-8 [&>.ui-button-face]:justify-start [&>.ui-button-face]:gap-2 [&>.ui-button-face]:px-2 [&>.ui-button-face]:py-1.5" data-provider-catalog-select={b}
                          onClick={() => { setPopup(null); setSelectedApi(null); setInstanceRequest({ cli: CLI_INFO[b].id, n: Date.now(), create: true }); }}
                        >
                          <ProviderLogo provider={b} className="size-4" />
                          <span className="min-w-0 flex-1 text-sm font-normal">{CLI_INFO[b].name}</span>
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
              {actionError && <p role="alert" className="text-sm text-danger-ink">{actionError}</p>}
            </div>
          </ScrollArea>
          <DialogFooter className="shrink-0 flex-row flex-wrap">
            <Button variant="outline" onClick={closePopup}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
        <AddressForm provider={provider} act={act} />
      )}
      {provider.key !== "none" && (
        <KeyForm hasKey={provider.hasKey} act={act} provider={provider} />
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
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void save(draft.trim() || null);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={inputId} className="text-sm font-normal text-ink">
          Server URL
        </label>
        <p id={hintId} className="text-sm text-ink-secondary">
          {provider.local ? `Connect to your ${provider.name} server.` : "OpenAI-compatible endpoint."}
        </p>
        <div className="flex flex-wrap gap-2">
          <Input
            id={inputId}
            data-provider-url=""
            placeholder={provider.defaultBaseUrl || "https://llm.example.com/v1"}
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
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" size="sm" data-provider-url-save="">
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
      <div className="flex flex-col gap-3">
        {current && <p id={inUseId} data-provider-model={current} className="text-sm text-ink-secondary">
            <>
              Default: <span className="font-medium">{modelName(toRef(provider.id, current))}</span>.
            </>
        </p>}
        <ModelSearch
          provider={provider}
          current={current}
          label="Default model"
          onChoose={(id, name) => {
            if (id === current) return;
            void act(() => setProviderModel(provider.id, id), `The default model is now ${provider.name} · ${name}.`);
          }}
        />
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
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={keyId} className="text-sm font-normal text-ink">
          {hasKey ? "New API key" : "API key"}
        </label>
        <div className="flex flex-wrap gap-2">
          <Input
            ref={inputRef}
            id={keyId}
            data-key-input=""
            placeholder={provider.keyPrefix ? `${provider.keyPrefix}…` : `Paste your ${provider.name} API key`}
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
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" variant={hasKey && !keyDraft ? "outline" : "default"} aria-disabled={saving || undefined} size="sm" className="aria-disabled:cursor-progress">
            {saving ? "Checking…" : "Check and save"}
          </Button>
        </div>
        <p id={keyHintId} className="text-sm text-ink-secondary">
          {hasKey ? "A key is saved. Paste a new key to replace it." : provider.key === "optional" ? "Add a key only if your server requires one." :
            <>{provider.name} API key. {provider.keysUrl && <ExternalLink href={provider.keysUrl}>Get API key</ExternalLink>}</>}
        </p>
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
    <div data-setting-row="" className="flex flex-col gap-1.5">
      <label htmlFor={selectId} className="text-sm font-normal text-ink">Default model</label>
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
      <p id={descId} className="text-sm text-ink-secondary">
        Used unless a space has its own model.
        {listFailed && " Couldn’t load models; showing the default."}
      </p>
    </div>
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
    <div className="mt-4 flex flex-col gap-2 border-t border-line pt-4" data-own-models="">
      <p id={titleId} className="text-sm font-normal text-ink">
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
