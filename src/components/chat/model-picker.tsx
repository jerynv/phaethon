import { invoke } from "@tauri-apps/api/core";
import { Star } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { NativeSelect } from "vic-ui";

import { ModelSearch } from "@/components/settings/model-search";
import { ProviderLogo } from "@/components/provider-logo";
import { announce } from "@/components/shell/announcer";
import type { Command } from "@/components/shell/command-palette";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover } from "@/components/ui/menu";
import { IconTip } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import { agentInstances, cliOf, listModels, selectAgentInstance, setBackend, SETTINGS_CHANGED_EVENT, type AgentInstanceView, type CliBackend, type CliModelList, type ModelInfo, type ProviderId } from "@/lib/backend";
import { changedText, choosableProviders, cliModelName, loadCliModels, modelGroups, modelName, modelOf, refreshModels, rememberNames, setSpaceModel, splitCliRef, splitRef, toRef, useModels, type ModelsState } from "@/lib/space-model";
import type { Space } from "@/lib/spaces";

import { ReasoningColumn, effortLabel, type ReasoningTarget } from "./reasoning-column";
import { AccessPicker } from "./access-picker";
import { ModelCombobox, type PickerOption } from "./model-combobox";
import "./model-picker.css";

export const OPEN_MODEL_PICKER_EVENT = "phaethon:open-model-picker";
export const openModelPicker = (spaceId: string) => window.dispatchEvent(new CustomEvent<string>(OPEN_MODEL_PICKER_EVENT, { detail: spaceId }));
const DEFAULT = "__default__";
const shortName = (name: string) => name.replace(/^Claude\s+/, "");
const favoriteKey = "phaethon:model-favorites:v1";
const optionKey = (provider: string, model: string) => JSON.stringify([provider, model]);
function readFavorites(): Set<string> {
  try { const saved: unknown = JSON.parse(localStorage.getItem(favoriteKey) ?? "[]"); return new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : []); } catch { return new Set(); }
}

let pendingInstances: Promise<AgentInstanceView[]> | undefined;
function loadInstances() {
  return pendingInstances ??= agentInstances().finally(() => { pendingInstances = undefined; });
}

type ProviderEntry = { id: string; name: string; logo: ProviderId | CliBackend; cli?: "claude" | "codex" | "gemini"; api?: ProviderId; available: boolean; source?: "system" | "managed"; models: readonly ModelInfo[] };
type Catalog = { loading: boolean; models: readonly ModelInfo[]; note?: string; defaultModel?: string };

/** Actual T3 ProviderModelPicker/ModelPickerContent/ModelPickerSidebar composition (MIT):
 * a provider rail, pinned editable combobox, compact model rows and a separate footer.
 * Account browsing is read-only. Choosing a model commits the real assistant instance.
 */
export function ModelPicker({ spaceId, spaceName, running }: { spaceId: string; spaceName: string; running: boolean }) {
  const s = useModels();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [rail, setRail] = useState("");
  const [instances, setInstances] = useState<AgentInstanceView[]>([]);
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const catalogRef = useRef(catalogs); catalogRef.current = catalogs;
  const [favorites, setFavorites] = useState<Set<string>>(readFavorites);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [effortTarget, setEffortTarget] = useState<ReasoningTarget | null>(null);
  const [currentEffort, setCurrentEffort] = useState<string | null>(null);
  const [manual, setManual] = useState<ProviderEntry | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const providersRef = useRef<HTMLDivElement>(null);
  const browsed = useRef(false);
  const activeCli = cliOf(s.backend);
  const activeInstance = instances.find(item => item.selected && item.config.cli === activeCli?.id);
  const current = modelOf(s, spaceId);
  const ownCli = s.own[spaceId] ? splitCliRef(s.own[spaceId]) : null;
  const activeKey = activeCli ? activeInstance?.config.id ?? activeCli.id : `api:${splitRef(current.id).provider}`;
  const activeCatalog = activeCli ? catalogs[activeInstance?.config.id ?? activeCli.id] ?? s.cliModels[activeCli.id] : undefined;
  const resolvedActive = ownCli?.model ?? activeCatalog?.defaultModel;
  const activeInfo = activeCatalog?.models.find(item => item.id === resolvedActive || item.aliases?.includes(resolvedActive ?? ""));
  const activeName = activeInfo?.name ?? (activeCli ? ownCli ? cliModelName(activeCli.id, ownCli.model, s) : `${activeCli.name} default` : shortName(modelName(current.id, s.models)));
  const activeLogo = activeCli ? `${activeCli.id}-cli` as CliBackend : splitRef(current.id).provider;
  const siblingAccounts = activeCli ? instances.filter(item => item.config.cli === activeCli.id) : [];
  const accountNumber = siblingAccounts.findIndex(item => item.config.id === activeInstance?.config.id) + 1;
  const label = activeCli ? `Model in ${spaceName}: ${activeInstance?.config.name ?? activeCli.name} · ${ownCli ? activeName : "Default"}` : `Model in ${spaceName}: ${modelName(current.id, s.models)}${!current.own ? ", the default" : ""}`;

  const entries = useMemo<ProviderEntry[]>(() => {
    const api = modelGroups(s).filter(group => s.backend === "phaethon" || s.providers.some(provider => provider.id === group.provider && provider.ready)).map(group => ({ id: `api:${group.provider}`, name: group.name, logo: group.provider, api: group.provider, available: true, models: group.models }));
    const accounts: ProviderEntry[] = instances.map(item => ({ id: item.config.id, name: item.config.name, logo: `${item.config.cli}-cli`, cli: item.config.cli, available: item.installed && item.loggedIn !== false, source: item.source ?? (item.managedHome ? "managed" : "system"), models: s.cliModels[item.config.cli]?.models ?? [] }));
    if (activeCli && !accounts.some(item => item.id === activeKey)) accounts.unshift({ id: activeKey, name: activeCli.name, logo: `${activeCli.id}-cli`, cli: activeCli.id, available: true, models: s.cliModels[activeCli.id]?.models ?? [] });
    return [...api, ...accounts];
  }, [s, instances, activeKey, activeCli?.id]);
  const selected = entries.find(entry => entry.id === rail) ?? entries.find(entry => entry.id === activeKey) ?? entries[0];

  useEffect(() => {
    const show = (event: Event) => { if ((event as CustomEvent<string>).detail === spaceId) setOpen(true); };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, show);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, show);
  }, [spaceId]);
  useEffect(() => {
    if (!open) { setQuery(""); setEffortTarget(null); browsed.current = false; return; }
    setRail(activeKey); setError(""); setFavorites(readFavorites());
    let active = true;
    void loadInstances().then(items => { if (active) { setInstances(items); if (!browsed.current) setRail(items.find(item => item.selected && item.config.cli === activeCli?.id)?.config.id ?? activeKey); } }, () => {});
    return () => { active = false; };
  }, [open]);

  // Keep the closed composer identity current too; opening the picker is not
  // required to discover which account will handle the next request.
  useEffect(() => {
    let active = true;
    const refresh = () => { void loadInstances().then(items => { if (active) setInstances(items); }, () => {}); };
    refresh();
    window.addEventListener(SETTINGS_CHANGED_EVENT, refresh);
    return () => { active = false; window.removeEventListener(SETTINGS_CHANGED_EVENT, refresh); };
  }, []);

  const putCatalog = (id: string, value: Catalog) => { catalogRef.current = { ...catalogRef.current, [id]: value }; setCatalogs(catalogRef.current); };
  async function loadCatalog(entry: ProviderEntry, force = false) {
    if (!entry.available || (!force && catalogRef.current[entry.id])) return;
    if (entry.cli && entry.id === activeKey && !instances.some(item => item.config.id === entry.id)) {
      await loadCliModels(entry.cli, force); return;
    }
    if (entry.api === "anthropic") return;
    putCatalog(entry.id, { ...catalogRef.current[entry.id], loading: true, defaultModel: catalogRef.current[entry.id]?.defaultModel ?? (entry.cli && entry.id === activeKey ? s.cliModels[entry.cli]?.defaultModel : undefined), models: catalogRef.current[entry.id]?.models ?? (entry.id === activeKey ? entry.models : []) });
    try {
      let result: CliModelList;
      if (entry.cli) result = await invoke<CliModelList>("agent_instance_models", { id: entry.id });
      else {
        const models = await listModels(entry.api!);
        rememberNames(entry.api!, models);
        result = { models: models.map(model => ({ ...model, id: toRef(entry.api!, model.id) })) };
      }
      putCatalog(entry.id, { loading: false, models: result.models, note: result.note, defaultModel: result.defaultModel });
    } catch (reason) { putCatalog(entry.id, { loading: false, models: [], note: String(reason) }); }
  }
  const searching = !!query.trim();
  useEffect(() => {
    if (!open) return;
    if (searching || rail === "favorites") {
      for (const entry of entries) if (searching || [...favorites].some(key => key.startsWith(JSON.stringify([entry.id]).slice(0, -1) + ","))) void loadCatalog(entry);
    } else if (selected) void loadCatalog(selected);
  }, [open, rail, activeKey, searching, entries]);

  function toggleFavorite(key: string) {
    setFavorites(previous => {
      const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(favoriteKey, JSON.stringify([...next])); } catch { /* A preference must not block model selection. */ }
      return next;
    });
  }
  function browse(id: string) { setEffortTarget(null); browsed.current = true; setRail(id); setQuery(""); searchRef.current?.focus(); }
  function focusProvider() { (providersRef.current?.querySelector('[aria-pressed="true"]') ?? providersRef.current?.querySelector("button:not(:disabled)"))?.scrollIntoView({ block: "nearest" }); providersRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus(); }
  const options = entries.flatMap<PickerOption>(entry => {
    if (!entry.available) return [];
    const known = catalogs[entry.id]?.models ?? (entry.cli && entry.id !== activeKey ? [] : entry.models);
    const list = [...known];
    const own = entry.id === activeKey ? entry.cli ? ownCli?.model : current.own ? current.id : null : null;
    if (own && !list.some(model => model.id === own || model.aliases?.includes(own))) list.push({ id: own, name: entry.cli ? cliModelName(entry.cli, own, s) : modelName(own, s.models) });
    const rows = [{ id: DEFAULT, name: "Default" }, ...list];
    return rows.map(model => ({ value: optionKey(entry.id, model.id), model: model.id, name: model.name, provider: entry.id, providerName: `${entry.name} ${entry.cli ?? entry.api ?? ""}`.trim(), logo: <ProviderLogo provider={entry.logo} className="size-4" />, selected: entry.id === activeKey && (model.id === DEFAULT ? !current.own : (model.id === own || !!model.aliases?.includes(own ?? ""))), detail: model.id === DEFAULT ? entry.cli ? (catalogs[entry.id]?.models.find(item => item.id === catalogs[entry.id]?.defaultModel)?.name ?? entry.name) : modelName(s.defaultModel, s.models) : undefined }));
  });
  const shownOptions = searching ? options : rail === "favorites" ? options.filter(option => favorites.has(option.value)) : options.filter(option => option.provider === selected?.id);
  const pickerHeight = Math.min(386, Math.max(220, effortTarget ? 88 + (effortTarget.levels.length + 1) * 32 : 0, 54 + (entries.length + 1) * 38, 82 + Math.max(4, ...entries.map(entry => (catalogs[entry.id]?.models ?? entry.models).length + 1)) * 32));
  const selectedCatalog = selected ? catalogs[selected.id] ?? (selected.cli && selected.id === activeKey ? s.cliModels[selected.cli] : undefined) : undefined;
  const loading = !!selectedCatalog && ("status" in selectedCatalog ? selectedCatalog.status === "loading" : selectedCatalog.loading);

  function reasoningFor(entry: ProviderEntry, model: string, focus: boolean): ReasoningTarget | null {
    if (!entry.cli) return null;
    const catalog = catalogs[entry.id] ?? (entry.id === activeKey ? s.cliModels[entry.cli] : undefined);
    const resolved = model === DEFAULT ? catalog?.defaultModel : model;
    const info = catalog?.models.find(item => item.id === resolved || item.aliases?.includes(resolved ?? ""));
    if (!info?.reasoningEfforts?.length) return null;
    return { account: entry.id, cli: entry.cli, model: model === DEFAULT ? null : model, name: info.name, levels: info.reasoningEfforts, focus };
  }
  useEffect(() => {
    let active = true;
    setCurrentEffort(null);
    if (activeCli) void invoke<string | null>("space_reasoning_get", { space: spaceId, cli: activeCli.id, model: ownCli?.model ?? null }).then(value => { if (active) setCurrentEffort(value); }, () => {});
    return () => { active = false; };
  }, [spaceId, activeCli?.id, ownCli?.model]);
  useEffect(() => {
    if (!open || effortTarget || selected?.id !== activeKey) return;
    const target = selected && reasoningFor(selected, ownCli?.model ?? DEFAULT, false);
    if (target) setEffortTarget(target);
  }, [open, catalogs, s.cliModels, activeKey, selected?.id, effortTarget]);

  async function choose(entry: ProviderEntry, model: string): Promise<string> {
    if (busy) return "A model change is already being saved.";
    const previousInstance = activeInstance?.config.id;
    const switching = entry.cli ? entry.id !== activeKey || s.backend === "phaethon" : s.backend !== "phaethon";
    setBusy(true); setError("");
    try {
      if (entry.cli && switching) { await selectAgentInstance(entry.id); window.dispatchEvent(new CustomEvent(SETTINGS_CHANGED_EVENT, { detail: { what: "backend" } })); await refreshModels(); await loadCliModels(entry.cli, true); }
      else if (!entry.cli && switching) { await setBackend("phaethon"); await refreshModels(); }
      await setSpaceModel(spaceId, model === DEFAULT ? null : entry.cli ? `${entry.cli}:${model}` : model);
      const changed = entry.cli ? model === DEFAULT ? `${spaceName} now uses ${cliOf(`${entry.cli}-cli`)!.name}’s own default model.` : `${spaceName} now uses ${cliOf(`${entry.cli}-cli`)!.name} · ${cliModelName(entry.cli, model, s)}.` : changedText(spaceName, model === DEFAULT ? null : model, s);
      announce(changed + (running ? " The reply now running keeps its model." : ""));
      const target = reasoningFor(entry, model, true);
      if (target) { setRail(entry.id); setEffortTarget(target); } else setOpen(false);
      return "";
    } catch (reason) {
      let message = String(reason);
      if (switching) {
        try { if (previousInstance) await selectAgentInstance(previousInstance); else await setBackend(s.backend); await refreshModels(); }
        catch (restoreError) { message += ` Previous assistant could not be restored: ${String(restoreError)}`; }
      }
      setError(`The model couldn’t be changed. ${message}`); return message;
    } finally { setBusy(false); }
  }
  if (s.status === "loading" || (s.backend !== "phaethon" && !activeCli)) return null;
  return <>
    <Popover.Root open={open} onOpenChange={setOpen}>
      <IconTip label={label} spoken="Choose provider and model"><Popover.Trigger asChild>
        <Button ref={triggerRef} type="button" variant="ghost" size="sm" aria-label={label} data-model-picker={spaceId} data-model={s.backend === "phaethon" ? current.id : current.own ? current.id : ""} className="min-w-0 shrink px-2 text-sm font-normal text-ink-secondary">
          <span className="relative inline-flex"><ProviderLogo provider={activeLogo} className="size-4" />{siblingAccounts.length > 1 && accountNumber > 0 && <span className="ph-model-account-badge" aria-hidden="true">{accountNumber}</span>}</span><span className="truncate">{siblingAccounts.length > 1 && activeInstance ? `${activeInstance.config.name.replace(/^(Codex|Claude Code|Gemini CLI)\s*[·:—-]?\s*/i, "").trim() || activeInstance.config.name} · ${activeName}` : activeName}</span>{currentEffort && <span data-composer-effort="" className="shrink-0 text-ink-tertiary">{effortLabel(currentEffort)}</span>}<Icon name="chevron-down" className="size-3 text-ink-tertiary" />
        </Button>
      </Popover.Trigger></IconTip>
      <Popover.Portal><Popover.Content side="top" align="end" sideOffset={7} collisionPadding={8} className="ph-model-picker" data-has-effort={!!effortTarget} style={{ height: `min(${pickerHeight}px, calc(100dvh - 16px))` }} data-model-menu="" aria-label={`Model in ${spaceName}`}
        onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }} onCloseAutoFocus={event => { if (manual) event.preventDefault(); }}>
        <div className="ph-model-picker-content" data-model-picker-content="">
          <div ref={providersRef} role="toolbar" aria-label="Providers" aria-orientation="vertical" className="ph-model-providers" data-model-picker-sidebar=""
            onKeyDown={event => {
              if (event.key === "ArrowRight") { event.preventDefault(); searchRef.current?.focus(); return; }
              if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
              event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")]; const at = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]; if (next) { next.click(); next.focus(); }
            }}>
            <button type="button" className="ph-model-provider" data-model-picker-provider="favorites" tabIndex={rail === "favorites" ? 0 : -1} aria-label="Favorites" title="Favorites" aria-pressed={rail === "favorites"} onClick={() => browse("favorites")}><Star size={18} strokeWidth={1.5} /></button>
            <span className="ph-model-provider-rule" aria-hidden="true" />
            {entries.map(entry => <button key={entry.id} type="button" className="ph-model-provider" data-model-picker-provider={entry.id} aria-label={entry.name} title={entry.available ? entry.name + (entry.source ? ` · ${entry.source === "system" ? "System" : "Managed"}` : "") : `${entry.name} · Sign in or install in Settings`} aria-pressed={rail !== "favorites" && entry.id === selected?.id} tabIndex={rail !== "favorites" && entry.id === selected?.id ? 0 : -1} disabled={!entry.available || busy} onClick={() => browse(entry.id)}>
              <ProviderLogo provider={entry.logo} className="size-5" />
              {entry.cli && entries.filter(item => item.cli === entry.cli).length > 1 && <span className="ph-model-account-badge" aria-hidden="true">{entries.filter(item => item.cli === entry.cli).findIndex(item => item.id === entry.id) + 1}</span>}
            </button>)}
          </div>
          <ModelCombobox options={shownOptions} query={query} onQueryChange={setQuery} onChoose={option => { const entry = entries.find(item => item.id === option.provider); if (entry) void choose(entry, option.model); }} favorites={favorites} onFavorite={toggleFavorite} searchRef={searchRef} onFocusProviders={focusProvider} onRequestClose={() => setOpen(false)} onFocusEffort={option => { const entry = entries.find(item => item.id === option.provider); if (entry && reasoningFor(entry, option.model, true)) void choose(entry, option.model); }} busy={busy} loading={loading}>
            {selectedCatalog?.note && !selectedCatalog.models.length && <p className="ph-model-note" data-cli-models-note={loading ? "loading" : "ready"}>{selectedCatalog.note}</p>}
            {error && <p role="alert" className="ph-model-error">{error}</p>}
          </ModelCombobox>
          {effortTarget && <ReasoningColumn key={`${effortTarget.account}:${effortTarget.model ?? "default"}`} target={effortTarget} spaceId={spaceId} busy={busy} onBusyChange={setBusy} onSaved={setCurrentEffort} onRequestClose={() => setOpen(false)} onBack={() => searchRef.current?.focus()} />}
        </div>
        <div className="ph-model-footer"><AccessPicker spaceId={spaceId} /><div className="ph-model-footer-actions">
          <IconTip label="Refresh models" spoken="Refresh models"><Button type="button" variant="ghost" size="icon-xs" aria-label="Refresh models" data-model-option="__refresh__" disabled={loading || busy || !selected} onClick={() => selected && void loadCatalog(selected, true)}><Icon name="retry" className={loading ? "size-3.5 animate-spin" : "size-3.5"} /></Button></IconTip>
          <IconTip label="Custom model" spoken="Custom model"><Button type="button" variant="ghost" size="icon-xs" aria-label="Custom model" data-model-option="__other__" disabled={busy || !selected || (!selected.cli && !choosableProviders(s).length)} onClick={() => { setOpen(false); setManual(selected ?? null); }}><Icon name="plus" className="size-3.5" /></Button></IconTip>
        </div></div>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {manual?.cli && <CliModelDialog cli={cliOf(`${manual.cli}-cli`)!} spaceName={spaceName} current={manual.id === activeKey ? ownCli?.model ?? "" : ""} onClose={() => { setManual(null); requestAnimationFrame(() => triggerRef.current?.focus()); }} onChoose={model => choose(manual, model)} />}
    {manual?.api && <OtherModelDialog s={s} spaceName={spaceName} current={manual.id === activeKey ? current.id : toRef(manual.api, "")} onClose={() => { setManual(null); requestAnimationFrame(() => triggerRef.current?.focus()); }} onChoose={async ref => { const provider = splitRef(ref).provider; const entry = entries.find(item => item.api === provider); return !!entry && !(await choose(entry, ref)); }} />}
  </>;
}
/** A model's name for a CLI, typed: Save (or Enter) passes it on from the next message; Escape closes. */
function CliModelDialog({
  cli,
  spaceName,
  current,
  onClose,
  onChoose,
}: {
  cli: NonNullable<ReturnType<typeof cliOf>>;
  spaceName: string;
  current: string;
  onClose: () => void;
  onChoose: (model: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState("");
  const inputId = useId();
  const errorId = useId();
  const example = cli.id === "codex" ? "gpt-5.5" : cli.id === "claude" ? "claude-sonnet-5-5" : "gemini-2.5-pro";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-cli-model-dialog="" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{cli.name} model in {spaceName}</DialogTitle>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const m = draft.trim();
            if (!m) {
              setError("Enter a model name.");
              return;
            }
            void onChoose(m).then((problem) => (problem ? setError(problem) : onClose()));
          }}
        >
          <label htmlFor={inputId} className="text-base font-medium text-ink">
            Model name
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={inputId}
              data-cli-model-input=""
              placeholder={example}
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError("");
              }}
              aria-describedby={error ? errorId : undefined}
              aria-invalid={error ? true : undefined}
              className="min-w-0 flex-1 font-mono"
            />
            <Button type="submit" className="min-h-(--ph-control-height-lg)" data-cli-model-save="">
              Use this model
            </Button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Any model of any provider that can answer, for one space: the provider,
 * then its list to search (or a model's name to type). Choosing saves it for
 * the space and closes; Escape closes without a change.
 */
function OtherModelDialog({
  s,
  spaceName,
  current,
  onClose,
  onChoose,
}: {
  s: ModelsState;
  spaceName: string;
  current: string;
  onClose: () => void;
  onChoose: (ref: string) => Promise<boolean>;
}) {
  const providers = choosableProviders(s);
  const start = splitRef(current).provider;
  const [provider, setProvider] = useState<ProviderId>(providers.some((p) => p.id === start) ? start : providers[0].id);
  const selectId = useId();
  const info = providers.find((p) => p.id === provider) ?? providers[0];
  const inUse = splitRef(current).provider === info.id ? splitRef(current).model : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-other-model-dialog="">
        <DialogHeader>
          <DialogTitle>Model in {spaceName}</DialogTitle>

        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={selectId} className="flex items-center gap-2 text-base font-medium text-ink">
            <ProviderLogo provider={info.id} className="size-4" />
            Provider
          </label>
          <NativeSelect
            id={selectId}
            data-other-provider=""
            value={info.id}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="w-full"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.local ? " (on this computer)" : ""}
              </option>
            ))}
          </NativeSelect>
        </div>
        <ModelSearch
          key={info.id}
          provider={info}
          current={inUse}
          label="Model"
          onChoose={(id) => {
            void onChoose(toRef(info.id, id)).then((ok) => ok && onClose());
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The command palette's model commands for the shown space: Change model…
 * (opens this space's model menu, starting on the model in use) and, when the
 * space has its own model, Use the default model.
 */
export function useModelCommands(space: Space | undefined): Command[] {
  const s = useModels();
  return useMemo(() => modelCommands(s, space), [s, space]);
}

function modelCommands(s: ModelsState, space: Space | undefined): Command[] {
  if (!space || s.status === "loading") return [];
  const current = modelOf(s, space.id);
  const keywords = "model claude opus sonnet haiku gpt llama openai openrouter ollama provider switch choose";
  const list: Command[] = [
    {
      id: "change-model",
      group: "Actions",
      label: "Change model…",
      hint:
        s.backend === "phaethon"
          ? `in ${space.name}: ${modelName(current.id, s.models)}`
          : `in ${space.name}: ${current.own ? modelName(current.id) : `${cliOf(s.backend)?.name}’s own default`}`,
      keywords: `${keywords} codex gemini`,
      icon: "agent",
      run: () => {
        if (!document.querySelector(`[data-model-picker="${CSS.escape(space.id)}"]`))
          announce(`The model can be changed once the conversation in ${space.name} has loaded.`);
        else openModelPicker(space.id);
      },
    },
  ];
  if (s.backend === "phaethon" && current.own) {
    list.push({
      id: "default-model",
      group: "Actions",
      label: "Use the default model",
      hint: `in ${space.name}: ${modelName(s.defaultModel, s.models)}`,
      keywords,
      icon: "agent",
      run: () =>
        void setSpaceModel(space.id, null).then(
          () => announce(changedText(space.name, null)),
          (e: unknown) => announce(`The model couldn’t be changed. ${String(e)}`),
        ),
    });
  }
  return list;
}
