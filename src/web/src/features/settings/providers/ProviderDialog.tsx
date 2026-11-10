/**
 * Adding and managing one provider connection, in one dialog: pick a preset,
 * then its address (servers), its key (never shown back, only "saved") and
 * its model. Layout follows T3 Code's AddProviderInstanceDialog and
 * ProviderInstanceCard; behaviour follows Phaethon's old Settings › Assistant.
 */
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import {
  checkApiKey,
  clearApiKey,
  providerStatus,
  setAnthropicModel,
  setApiKey,
  setBackend,
  setProvider,
  setProviderModel,
  setProviderUrl,
  type ProviderId,
  type ProviderInfo,
  type ServerStatus,
  type Settings,
} from "./api";
import {
  canSaveUnchecked,
  checkAndSave,
  DEFAULT_ANTHROPIC_MODEL,
  isAdded,
  isSaved,
  isValidModelFor,
  outcomeText,
  PRESET_GROUPS,
  providerModel,
  providerNeed,
  type KeyOutcome,
} from "./logic";
import { ModelList, type ModelGroup } from "./ModelPicker";
import { ProviderLogo } from "./ProviderLogo";
import { useAssistant } from "./store";
import { ExternalLink, FieldMessage } from "./ui";

export type ProviderDialogTarget = { mode: "pick" } | { mode: "provider"; id: ProviderId; focus?: "key" | "url" | "model"; fromPick?: boolean };

export function ProviderDialog({
  target,
  onClose,
  onSaid,
}: {
  target: ProviderDialogTarget | null;
  onClose: () => void;
  /** Announces a finished action ("OpenAI is now the default."). */
  onSaid: (text: string) => void;
}) {
  const settings = useAssistant((s) => s.settings);
  const [view, setView] = useState<ProviderDialogTarget | null>(target);
  useEffect(() => setView(target), [target]);
  const open = target !== null;
  const provider = view?.mode === "provider" ? settings?.providers.find((p) => p.id === view.id) : undefined;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPopup className="max-w-xl" bottomStickOnMobile>
        {view?.mode === "pick" && settings ? (
          <PresetPicker settings={settings} onPick={(id) => setView({ mode: "provider", id, fromPick: true })} />
        ) : null}
        {view?.mode === "provider" && provider && settings ? (
          <ProviderPanel
            key={provider.id}
            provider={provider}
            settings={settings}
            focus={view.focus}
            onBack={view.fromPick ? () => setView({ mode: "pick" }) : undefined}
            onClose={onClose}
            onSaid={onSaid}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function PresetPicker({ settings, onPick }: { settings: Settings; onPick: (id: ProviderId) => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a provider</DialogTitle>
        <DialogDescription>Phaethon’s agent answers with a model from one of these.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
        {PRESET_GROUPS.map((g) => {
          const items = settings.providers.filter(g.test);
          if (!items.length) return null;
          const headingId = `preset-${g.label.replace(/\W+/g, "-").toLowerCase()}`;
          return (
            <div key={g.label} className="flex flex-col gap-1.5">
              <h3 id={headingId} className="px-1 text-sm font-medium text-muted-foreground">
                {g.label}
              </h3>
              <ul aria-labelledby={headingId} className="grid gap-1 sm:grid-cols-2">
                {items.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onPick(p.id)}
                      className="flex min-h-11 w-full items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left outline-none transition-colors hover:border-border hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ProviderLogo id={p.id} className="size-5" />
                      <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-medium">{p.name}</span>
                      {isAdded(p) ? (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <CheckIcon aria-hidden className="size-4" />
                          Added
                        </span>
                      ) : (
                        <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </DialogPanel>
    </>
  );
}

function ProviderPanel({
  provider,
  settings,
  focus,
  onBack,
  onClose,
  onSaid,
}: {
  provider: ProviderInfo;
  settings: Settings;
  focus?: "key" | "url" | "model";
  onBack?: () => void;
  onClose: () => void;
  onSaid: (text: string) => void;
}) {
  const load = useAssistant((s) => s.load);
  const isDefault = settings.provider === provider.id && settings.backend === "phaethon";
  const need = providerNeed(provider, settings);
  const [footerError, setFooterError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const needId = useId();
  const added = isAdded(provider);

  // Focus the field asked for (an error elsewhere linked here), else the first one that needs something.
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const want = focus ?? need?.field;
    if (!want) return;
    const t = setTimeout(() => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-field="${want}"]`);
      (el?.matches("input, button") ? el : el?.querySelector<HTMLElement>("input"))?.focus();
    }, 80);
    return () => clearTimeout(t);
    // Only when the dialog opens on this provider.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function makeDefault() {
    if (busy) return;
    setBusy(true);
    setFooterError("");
    try {
      await setProvider(provider.id);
      if (settings.backend !== "phaethon") await setBackend("phaethon");
      await load();
      onSaid(`Phaethon’s agent now answers with ${provider.name}.`);
    } catch (e) {
      setFooterError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setFooterError("");
    try {
      if (provider.hasKey) await clearApiKey(provider.id);
      if (provider.id !== "anthropic" && provider.model) await setProviderModel(provider.id, null);
      if (provider.editableBase && provider.baseUrl && provider.baseUrl !== provider.defaultBaseUrl) await setProviderUrl(provider.id, null);
      await load();
      onSaid(`${provider.name} removed.`);
      onClose();
    } catch (e) {
      setFooterError(errorText(e));
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  const subtitle = [isDefault ? "Default" : null, provider.local ? "On this computer" : provider.id === "custom" ? "Your own server" : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <DialogHeader className="pe-14">
        <div className="flex items-center gap-3">
          {onBack ? (
            <Button variant="ghost" size="icon-sm" aria-label="Back to providers" onClick={onBack} className="-ms-2">
              <ArrowLeftIcon />
            </Button>
          ) : null}
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-background">
            <ProviderLogo id={provider.id} className="size-6" />
          </span>
          <div className="flex min-w-0 flex-col">
            <DialogTitle className="text-lg">{provider.name}</DialogTitle>
            {subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
          </div>
        </div>
      </DialogHeader>
      <DialogPanel>
        <div ref={panelRef} className="flex flex-col gap-6">
          {provider.editableBase ? <AddressField provider={provider} onSaid={onSaid} /> : null}
          {provider.key !== "none" ? <KeyField provider={provider} onSaid={onSaid} /> : null}
          <ModelField provider={provider} settings={settings} onSaid={onSaid} />
        </div>
      </DialogPanel>
      <DialogFooter className="flex-row flex-wrap items-center gap-2 sm:justify-between">
        {added ? (
          <Button variant="ghost-destructive" onClick={() => setConfirmRemove(true)} disabled={busy} className="-ms-2">
            Remove
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {footerError ? (
            <FieldMessage tone="error" id={needId}>
              {footerError}
            </FieldMessage>
          ) : need && !isDefault ? (
            <p id={needId} className="text-sm text-muted-foreground">
              {need.text}
            </p>
          ) : null}
          {!isDefault ? (
            <Button variant="outline" onClick={() => void makeDefault()} disabled={busy || !!need} aria-describedby={need ? needId : undefined}>
              {busy ? <Spinner /> : null}
              Use as default
            </Button>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogFooter>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {provider.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {provider.hasKey ? "Its key is deleted from this computer’s keychain. " : ""}
              {isDefault ? "Phaethon’s agent can’t answer until you choose another default." : "Spaces using its models switch to the default."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep</AlertDialogClose>
            <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** A server's address, whether something answers there, and the usual address back. */
function AddressField({ provider, onSaid }: { provider: ProviderInfo; onSaid: (t: string) => void }) {
  const load = useAssistant((s) => s.load);
  const loadModels = useAssistant((s) => s.loadModels);
  const [draft, setDraft] = useState(provider.baseUrl);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const inputId = useId();
  const errorId = useId();
  const statusId = useId();
  const changed = provider.defaultBaseUrl && provider.baseUrl !== provider.defaultBaseUrl;

  useEffect(() => setDraft(provider.baseUrl), [provider.baseUrl]);

  async function check() {
    if (!provider.baseUrl) return;
    setChecking(true);
    try {
      setStatus(await providerStatus(provider.id));
    } catch (e) {
      setStatus({ running: false, models: [], message: errorText(e) });
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    void check();
    // Checked again whenever the saved address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.id, provider.baseUrl]);

  async function save(url: string | null, e?: FormEvent) {
    e?.preventDefault();
    if (saving) return;
    if (url !== null && !url.trim()) {
      setError("Enter the server’s address.");
      document.getElementById(inputId)?.focus();
      return;
    }
    setSaving(true);
    setError("");
    try {
      await setProviderUrl(provider.id, url?.trim() ?? null);
      await load();
      void loadModels(provider.id, true);
      onSaid(url ? "Address saved." : `${provider.name}’s usual address is back.`);
    } catch (err) {
      setError(errorText(err));
      document.getElementById(inputId)?.focus();
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft.trim() !== provider.baseUrl;
  return (
    <form noValidate onSubmit={(e) => void save(draft, e)} className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-[0.9375rem] font-medium">
        Server address
      </label>
      <div className="flex flex-wrap gap-2">
        <Input
          id={inputId}
          data-field="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.defaultBaseUrl || "https://llm.example.com/v1"}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError("");
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error && errorId, provider.baseUrl && statusId].filter(Boolean).join(" ") || undefined}
          className="min-w-0 flex-[1_1_16rem] font-mono"
        />
        <Button type="submit" variant={dirty ? "default" : "outline"} disabled={saving || (!dirty && !!provider.baseUrl)}>
          {saving ? <Spinner /> : null}
          Save
        </Button>
      </div>
      {error ? (
        <FieldMessage id={errorId} tone="error">
          {error}
        </FieldMessage>
      ) : null}
      {provider.baseUrl ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <FieldMessage id={statusId} tone={!status ? "muted" : status.running ? "success" : "warning"} className="flex-[1_1_14rem]">
            {status ? status.message : checking ? "Checking the server…" : ""}
          </FieldMessage>
          <Button type="button" variant="ghost" size="sm" onClick={() => void check()} disabled={checking}>
            {checking ? <Spinner /> : <RefreshCwIcon />}
            Check again
          </Button>
          {changed ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => void save(null)}>
              Use the usual address
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

/** The key: paste, Check and save, the result in words. A saved key is never shown, only that one is saved. */
function KeyField({ provider, onSaid }: { provider: ProviderInfo; onSaid: (t: string) => void }) {
  const load = useAssistant((s) => s.load);
  const loadModels = useAssistant((s) => s.loadModels);
  const [draft, setDraft] = useState("");
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const hintId = useId();
  const outcomeId = useId();
  const optional = provider.key === "optional";

  async function save(skipCheck: boolean, e?: FormEvent) {
    e?.preventDefault();
    if (saving) return;
    setSaving(true);
    setOutcome(null);
    const result = await checkAndSave(draft, provider.id, { check: checkApiKey, save: setApiKey }, skipCheck);
    setSaving(false);
    setOutcome(result);
    if (isSaved(result)) {
      setDraft("");
      await load();
      void loadModels(provider.id, true);
      onSaid(outcomeText(result, provider));
    } else {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }

  const bad = outcome?.kind === "problem";
  return (
    <form noValidate onSubmit={(e) => void save(false, e)} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <label htmlFor={inputId} className="text-[0.9375rem] font-medium">
          {provider.hasKey ? "Replace API key" : optional ? "API key (if your server needs one)" : "API key"}
        </label>
        {provider.hasKey ? (
          <Badge variant="success" size="lg" className="gap-1">
            <CheckIcon aria-hidden className="size-3.5" />
            Saved
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Input
          ref={inputRef}
          id={inputId}
          data-field="key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={provider.hasKey ? "Paste a new key" : provider.keyPrefix ? `${provider.keyPrefix}…` : "Paste the key"}
          value={draft}
          readOnly={saving}
          onChange={(e) => {
            setDraft(e.target.value);
            if (outcome) setOutcome(null);
          }}
          aria-invalid={bad || undefined}
          aria-describedby={[outcome && outcomeId, hintId].filter(Boolean).join(" ")}
          className={cn("min-w-0 flex-[1_1_16rem]", draft && "font-mono")}
        />
        <Button type="submit" variant={draft ? "default" : "outline"} disabled={saving}>
          {saving ? <Spinner /> : null}
          {saving ? "Checking…" : "Check and save"}
        </Button>
      </div>
      {outcome ? (
        <FieldMessage id={outcomeId} tone={outcome.kind === "saved" ? "success" : outcome.kind === "no-credit" ? "warning" : "error"}>
          {outcomeText(outcome, provider)}
        </FieldMessage>
      ) : null}
      {canSaveUnchecked(outcome) ? (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => void save(true)}>
          Save without checking
        </Button>
      ) : null}
      <p id={hintId} className="text-sm text-muted-foreground">
        Kept in this computer’s keychain.{" "}
        {provider.keysUrl ? <ExternalLink href={provider.keysUrl}>Get your key from {provider.name}</ExternalLink> : null}
      </p>
    </form>
  );
}

/** This provider's model: its list with search, the chosen one selected. */
function ModelField({ provider, settings, onSaid }: { provider: ProviderInfo; settings: Settings; onSaid: (t: string) => void }) {
  const list = useAssistant((s) => s.models[provider.id]);
  const loadModels = useAssistant((s) => s.loadModels);
  const load = useAssistant((s) => s.load);
  const [error, setError] = useState("");
  const labelId = useId();
  const errorId = useId();
  const current = providerModel(provider, settings);
  const canList = provider.id === "anthropic" || provider.ready;

  useEffect(() => {
    if (canList) void loadModels(provider.id);
  }, [canList, provider.id, loadModels]);

  const groups = useMemo<ModelGroup[]>(() => {
    const options = (list?.models ?? []).map((m) => ({ value: m.id, label: m.name, detail: provider.id !== "anthropic" && m.name !== m.id ? m.id : undefined }));
    if (current && !options.some((o) => o.value === current)) options.unshift({ value: current, label: current, detail: undefined });
    return [
      {
        label: provider.name,
        options,
        status: list?.status === "loading" ? "loading" : list?.status === "error" ? "error" : undefined,
        error: list?.status === "error" ? `${list.error ?? "The list couldn’t be loaded."} Type a model name instead.` : undefined,
        typed: (name) => (isValidModelFor(provider.id, name) ? { value: name, label: `Use “${name}”` } : null),
      },
    ];
  }, [list, current, provider.id, provider.name]);

  async function choose(id: string) {
    if (id === current) return;
    setError("");
    try {
      if (provider.id === "anthropic") await setAnthropicModel(id === DEFAULT_ANTHROPIC_MODEL ? null : id);
      else await setProviderModel(provider.id, id);
      await load();
      const name = list?.models.find((m) => m.id === id)?.name ?? id;
      onSaid(`${provider.name} uses ${name}.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!canList) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[0.9375rem] font-medium">Model</span>
        <p className="text-sm text-muted-foreground">{provider.editableBase && !provider.baseUrl ? "Save the address first." : "Save a key first."}</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span id={labelId} className="text-[0.9375rem] font-medium">
          Model
        </span>
        {list?.status === "error" || list?.status === "ready" ? (
          <Button variant="ghost" size="xs" onClick={() => void loadModels(provider.id, true)}>
            <RefreshCwIcon />
            Refresh
          </Button>
        ) : null}
      </div>
      <div data-field="model">
        <ModelList groups={groups} value={current} onChange={(o) => void choose(o.value)} label={`${provider.name} model`} labelId={labelId} describedBy={error ? errorId : undefined} />
      </div>
      {error ? (
        <FieldMessage id={errorId} tone="error">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}
