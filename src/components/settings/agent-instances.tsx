import { Select } from "vic-ui";
import { LogOut } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { ProviderLogo } from "@/components/provider-logo";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IconTip } from "@/components/ui/tooltip";
import "./provider-settings.css";
import { Icon } from "@/icons";
import { removeAgentInstance, signOutAgentInstance, agentInstances, cancelAgentInstanceSignIn, CLI_INFO, saveAgentInstance, selectAgentInstance, signInAgentInstance, type Backend, type AgentCli, type AgentInstanceConfig, type AgentInstanceView, type CliBackend, type CliSignIn } from "@/lib/backend";

import type { AgentSection } from "./agent-section";
import { SettingGroup } from "./controls";
import { useStatus } from "./status";

const backend = (cli: AgentCli): CliBackend => `${cli}-cli`;
const status = (view: AgentInstanceView) => !view.installed ? "Not installed" : view.loggedIn === true ? view.account ?? "Signed in" : view.loggedIn === false ? "Sign in required" : "Installed";
export type AgentInstanceRequest = { cli: AgentCli; n: number; closeSettingsOnClose?: boolean; create?: boolean };

/** Ports T3 Code's ProviderInstanceCard and ProviderSettingsForm into the Vic settings rows. */
export function AgentInstances({ act, request, backendVersion, onRequestedClose, onBusyChange }: { act: Parameters<typeof AgentSection>[0]["act"]; request: AgentInstanceRequest | null; backendVersion: Backend; onRequestedClose?: (n: number) => void; onBusyChange?: (busy: boolean) => void }) {
  const { say } = useStatus();
  const [instances, setInstances] = useState<AgentInstanceView[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<AgentInstanceConfig | null>(null);
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  useLayoutEffect(() => {
    onBusyChange?.(waiting || busy);
    return () => onBusyChange?.(false);
  }, [waiting, busy, onBusyChange]);
  const [outcome, setOutcome] = useState<CliSignIn | null>(null);
  const [removing, setRemoving] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const initialized = useRef(false);
  const previousConfig = useRef<AgentInstanceConfig | null>(null);
  const listGeneration = useRef(0);
  const requestedPopup = useRef<AgentInstanceRequest | null>(null);
  const closingToChat = useRef(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const cliId = useId();
  const binaryId = useId();
  const argsId = useId();
  const refresh = async () => {
    const generation = ++listGeneration.current;
    try {
      const items = await agentInstances();
      if (generation !== listGeneration.current) return null;
      setInstances(items); setError("");
      if (!initialized.current && items.length && !request) {
        initialized.current = true;
        const selected = items.find((item) => item.selected) ?? items[0];
        setDraft({ ...selected.config, args: [...selected.config.args] });
        setArgs(selected.config.args.join("\n"));
      }
      return items;
    } catch (e) { if (generation === listGeneration.current) setError(String(e)); return null; }
  };
  useEffect(() => () => { ++listGeneration.current; }, []);
  useEffect(() => { void refresh(); }, [backendVersion]);
  const edit = (config: AgentInstanceConfig, reveal = true) => { setDraft({ ...config, args: [...config.args] }); setArgs(config.args.join("\n")); setError(""); setOutcome(null); setRemoving(false); setDetailOpen(reveal); };
  const create = (cli: AgentCli) => {
    previousConfig.current = draft && instances.some((item) => item.config.id === draft.id) ? draft : null;
    edit({ id: `${cli}-${crypto.randomUUID()}`, cli, name: "", binary: "", args: [] });
  };
  useEffect(() => {
    if (!request) return;
    let active = true;
    void refresh().then((items) => {
      if (!active || !items) return;
      requestedPopup.current = request;
      const existing = items.find((item) => item.selected && item.config.cli === request.cli) ?? items.find((item) => item.config.id === request.cli);
      if (request.create || !existing) create(request.cli); else edit(existing.config);
    });
    return () => { active = false; };
  }, [request]);
  const current = instances.find((item) => item.config.id === draft?.id);
  const newInstance = !!draft && !current;
  const readOnly = current?.readOnly === true;
  async function signOut() {
    if (!current || busy) return;
    setBusy(true);
    try { await signOutAgentInstance(current.config.id); await refresh(); say(`${current.config.name} signed out.`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!current || busy) return;
    setBusy(true);
    try { await removeAgentInstance(current.config.id); const items = await refresh(); if (items?.length) edit(items[0].config, false); else setDraft(null); say(`${current.config.name} removed.`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const nextConfig = draft && { ...draft, name: draft.name.trim(), binary: draft.binary.trim(), args: args.split(/\r?\n/).filter((argument) => argument.length > 0) };
  const dirty = !readOnly && !!nextConfig && (newInstance || JSON.stringify(nextConfig) !== JSON.stringify(current?.config));
  const ownLaunch = !readOnly && (newInstance || current?.managedHome !== false);
  const close = () => {
    if (waiting || busy) return;
    const requested = requestedPopup.current;
    requestedPopup.current = null;
    closingToChat.current = requested?.closeSettingsOnClose ?? false;
    if (newInstance) { if (previousConfig.current) edit(previousConfig.current, false); else setDraft(null); }
    setDetailOpen(false); setOutcome(null); setError("");
    if (requested) onRequestedClose?.(requested.n);
  };
  async function save() {
    if (!nextConfig || busy) return;
    if (!nextConfig.name) { setError("Enter a connection name."); document.getElementById(nameId)?.focus(); return; }
    setBusy(true);
    try { const saved = await saveAgentInstance(nextConfig); await refresh(); edit(saved); say(`${saved.name} saved.`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function signIn() {
    if (!current || waiting) return;
    setWaiting(true); setOutcome(null); setError(""); say(`Opening ${current.config.name} sign-in in your browser.`);
    try { const result = await signInAgentInstance(current.config.id); setOutcome(result); say(result.message); await refresh(); }
    catch (e) { setError(String(e)); }
    finally { const restore = document.activeElement === stopRef.current; setWaiting(false); if (restore) requestAnimationFrame(() => startRef.current?.focus()); }
  }
  async function choose() {
    if (!current || busy) return;
    setBusy(true); setError("");
    const selected = await act(() => selectAgentInstance(current.config.id), `Now using ${current.config.name}.`, setError, true);
    if (selected) await refresh();
    setBusy(false);
  }
  const fields = draft && <div aria-busy={waiting || busy || undefined} data-provider-configuration={backend(draft.cli)} className="flex min-h-0 flex-col gap-4">
    {newInstance && <div data-instance-cli=""><Select label="Assistant" id={cliId} size="sm" value={draft.cli} onValueChange={(value) => { const cli = value as AgentCli; setDraft((previous) => previous && { ...previous, cli, id: `${cli}-${crypto.randomUUID()}` }); }} items={(["claude", "codex", "gemini"] as const).map((cli) => ({ value: cli, label: CLI_INFO[backend(cli)].name, start: <ProviderLogo provider={backend(cli)} className="size-4" /> }))} /></div>}
    {!readOnly && <div className="flex flex-col gap-1.5"><label htmlFor={nameId} className="text-xs text-ink-secondary">Connection name</label><Input id={nameId} data-instance-name="" value={draft.name} placeholder={`${CLI_INFO[backend(draft.cli)].name} · Personal`} maxLength={80} onChange={(event) => setDraft((previous) => previous && { ...previous, name: event.target.value })} /></div>}
    {current && <div className="flex flex-col gap-3" data-cli-sign-in={draft.cli}>
      <div className="flex min-w-0 items-start gap-2 text-xs text-ink-secondary"><span className={`mt-1 size-1.5 shrink-0 rounded-full ${current.loggedIn ? "bg-success-ink" : "bg-ink-tertiary"}`} /><span className="min-w-0 wrap-anywhere">{status(current)}{current.plan ? ` · ${current.plan}` : ""}<span className="block pt-0.5 text-ink-tertiary">{current.source === "system" ? "System CLI" : "Phaethon-managed"}</span></span></div>
      <div className="flex flex-wrap items-center gap-1.5">
        {readOnly ? null : current.installed ? <><Button ref={startRef} variant={current.loggedIn ? "outline" : "default"} size="sm" data-cli-sign-in-start="" disabled={waiting || busy || dirty} onClick={() => void signIn()}>{waiting ? "Waiting for sign-in…" : current.loggedIn ? "Change account" : `Sign in to ${CLI_INFO[backend(draft.cli)].name}`}</Button>{waiting && <Button ref={stopRef} variant="ghost" size="sm" data-cli-sign-in-stop="" onClick={() => void cancelAgentInstanceSignIn(draft.id)}>Cancel</Button>}</> : <a data-cli-missing={backend(draft.cli)} href={CLI_INFO[backend(draft.cli)].installUrl} target="_blank" rel="noreferrer" className="text-sm text-accent-ink">Install {CLI_INFO[backend(draft.cli)].name}<Icon name="link" className="ms-1 inline size-(--ph-icon-size-sm)" /></a>}
        {!readOnly && current.loggedIn && draft.cli !== "gemini" && <IconTip label="Sign out" spoken="Sign out"><Button variant="ghost" size="icon-xs" data-instance-signout="" aria-label="Sign out" disabled={busy || waiting} onClick={() => void signOut()}><LogOut className="size-3.5 stroke-[1.5]" /></Button></IconTip>}
        <IconTip label="Refresh status" spoken="Refresh connection status"><Button variant="ghost" size="icon-xs" data-provider-refresh="" aria-label="Refresh connection status" disabled={waiting || busy} onClick={() => void refresh()}><Icon name="retry" /></Button></IconTip>
      </div>
    </div>}
    {waiting && <p role="status" className="text-xs text-ink-secondary">Finish signing in in your browser.</p>}
    {outcome && <p role="status" data-cli-sign-in-outcome={outcome.status} className={outcome.status === "signedIn" ? "sr-only" : "text-xs text-ink-secondary"}>{outcome.message}</p>}
    {ownLaunch ? <Details summary="Launch options" className="[&>div]:space-y-3">
      <div className="flex flex-col gap-1.5"><label htmlFor={binaryId} className="text-xs text-ink-secondary">Executable</label><Input id={binaryId} data-instance-binary="" value={draft.binary} placeholder={`/opt/homebrew/bin/${draft.cli}`} onChange={(event) => setDraft((previous) => previous && { ...previous, binary: event.target.value })} /></div>
      <div className="flex flex-col gap-1.5"><label htmlFor={argsId} className="text-xs text-ink-secondary">Launch arguments</label><Textarea id={argsId} data-instance-args="" value={args} onChange={(event) => setArgs(event.target.value)} placeholder={"--model\nmodel-name"} rows={3} className="font-mono text-xs" /><p className="text-xs text-ink-tertiary">One argument per line.</p></div>
    </Details> : null}
    {current && !readOnly && current.config.id !== current.config.cli && <div>{removing ? <div className="flex flex-col gap-2"><p className="text-xs text-ink-secondary">Remove this connection? Its account files stay on this Mac.</p><div className="flex gap-2"><Button variant="destructive" size="xs" data-instance-remove-confirm="" disabled={busy || waiting} onClick={() => void remove()}>Remove</Button><Button variant="ghost" size="xs" onClick={() => setRemoving(false)}>Cancel</Button></div></div> : <Button variant="ghost" size="xs" data-instance-remove="" className="text-danger-ink" disabled={busy || waiting} onClick={() => setRemoving(true)}><Icon name="trash" />Remove connection</Button>}</div>}
    {error && <p role="alert" className="text-xs text-danger-ink">{error}</p>}
  </div>;
  const actions = <>
    {dirty && <Button size="sm" data-instance-save="" disabled={busy || waiting} onClick={() => void save()}>{busy ? "Saving…" : newInstance ? "Create connection" : "Save changes"}</Button>}
    {current && !current.selected && <Button size="sm" variant={dirty ? "outline" : "default"} data-backend={backend(current.config.cli)} data-instance-select="" disabled={busy || waiting || dirty || !current.installed} onClick={() => void choose()}>Use as default</Button>}
    {(newInstance || requestedPopup.current?.closeSettingsOnClose) && <Button variant="ghost" size="sm" disabled={busy || waiting} onClick={close}>{newInstance ? "Cancel" : "Done"}</Button>}
  </>;
  return <>
    <SettingGroup title="Coding assistants">
      <div className="provider-master-detail" data-agent-instances="" data-detail-open={detailOpen && !newInstance}>
        <div className="provider-instance-list">
          {instances.map((instance) => {
            const key = instance.config.id === instance.config.cli ? backend(instance.config.cli) : instance.config.id;
            const selected = current?.config.id === instance.config.id;
            return <button type="button" key={instance.config.id} data-provider-row={key} data-provider-configure={key} data-agent-instance={instance.config.id} aria-label={`Manage ${instance.config.name}`} aria-pressed={selected} disabled={waiting || busy} onClick={() => edit(instance.config)} className="provider-instance-row">
              <ProviderLogo provider={backend(instance.config.cli)} className="size-5 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="flex min-w-0 items-center gap-2"><span className="truncate text-sm font-normal text-ink">{instance.config.name}</span>{instance.selected && <span className="shrink-0 rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-normal text-accent-ink">Default</span>}</span><span data-cli-status={!instance.installed ? "missing" : instance.loggedIn === false ? "signed-out" : "installed"} className="truncate text-xs text-ink-secondary">{status(instance)}</span></span>
            </button>;
          })}
          {!instances.length && <p role="status" className="p-3 text-xs text-ink-secondary">Loading connections…</p>}
        </div>
        <div className="provider-instance-detail" data-provider-detail="">
          {current && draft ? <div data-agent-instance-popup="" data-provider-popup="cli" className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-2"><Button variant="ghost" size="icon-xs" className="provider-detail-back" aria-label="Back to connections" disabled={busy || waiting} onClick={() => setDetailOpen(false)}><Icon name="chevron-left" /></Button><ProviderLogo provider={backend(draft.cli)} className="size-5" /><h4 className="min-w-0 truncate text-sm font-normal text-ink">{draft.name}</h4></div>
            {fields}
            <div data-slot="dialog-footer" className="flex flex-wrap items-center gap-2 pt-1">{actions}</div>
          </div> : <p className="text-xs text-ink-secondary">Select a connection.</p>}
        </div>
      </div>
      {error && !draft && <p role="alert" className="p-3 text-xs text-danger-ink">{error}</p>}
    </SettingGroup>
    <Dialog open={newInstance} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent data-provider-popup="cli" data-agent-instance-popup="" className="flex max-w-md! flex-col overflow-hidden" showCloseButton={!waiting} onCloseAutoFocus={(event) => { if (closingToChat.current) event.preventDefault(); closingToChat.current = false; }} onEscapeKeyDown={(event) => { if (waiting || busy) event.preventDefault(); }} onInteractOutside={(event) => { if (waiting || busy) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>New {draft ? CLI_INFO[backend(draft.cli)].name : "assistant"} connection</DialogTitle><DialogDescription className="sr-only">Choose an assistant and name this account.</DialogDescription></DialogHeader>
        <div className="min-h-0 overflow-y-auto [scrollbar-gutter:stable]">{fields}</div>
        <DialogFooter className="shrink-0 flex-row flex-wrap">{actions}</DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
