import { NativeSelect, Progress } from "vic-ui";
import { useEffect, useId, useRef, useState } from "react";

import { ProviderLogo } from "@/components/provider-logo";
import { Button } from "@/components/ui/button";
import { Details } from "@/components/ui/details";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/icons";
import { agentInstanceUsage, removeAgentInstance, signOutAgentInstance, agentInstances, cancelAgentInstanceSignIn, CLI_INFO, saveAgentInstance, selectAgentInstance, signInAgentInstance, type AgentInstanceUsage, type Backend, type AgentCli, type AgentInstanceConfig, type AgentInstanceView, type CliBackend, type CliSignIn } from "@/lib/backend";

import type { AgentSection } from "./agent-section";
import { SettingGroup, SettingRow } from "./controls";
import { useStatus } from "./status";

const backend = (cli: AgentCli): CliBackend => `${cli}-cli`;
const status = (view: AgentInstanceView) => !view.installed ? "Not installed" : view.loggedIn === true ? view.account ?? "Signed in" : view.loggedIn === false ? "Sign in required" : "Installed";
export type AgentInstanceRequest = { cli: AgentCli; n: number; closeSettingsOnClose?: boolean };

/** Ports T3 Code's ProviderInstanceCard and ProviderSettingsForm into the Vic settings rows. */
export function AgentInstances({ act, request, backendVersion, onRequestedClose }: { act: Parameters<typeof AgentSection>[0]["act"]; request: AgentInstanceRequest | null; backendVersion: Backend; onRequestedClose?: (n: number) => void }) {
  const { say } = useStatus();
  const [instances, setInstances] = useState<AgentInstanceView[]>([]);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<AgentInstanceConfig | null>(null);
  const [args, setArgs] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [outcome, setOutcome] = useState<CliSignIn | null>(null);
  const [usage, setUsage] = useState<AgentInstanceUsage | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const listGeneration = useRef(0);
  const usageGeneration = useRef(0);
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
      setInstances(items); setError(""); return items;
    } catch (e) { if (generation === listGeneration.current) setError(String(e)); return null; }
  };
  useEffect(() => () => { ++listGeneration.current; ++usageGeneration.current; }, []);
  useEffect(() => { void refresh(); }, [backendVersion]);
  const edit = (config: AgentInstanceConfig) => { ++usageGeneration.current; setUsage(null); setUsageBusy(false); setDraft({ ...config, args: [...config.args] }); setArgs(config.args.join("\n")); setError(""); setOutcome(null); setRemoving(false); };
  const create = (cli: AgentCli) => edit({ id: `${cli}-${crypto.randomUUID()}`, cli, name: "", binary: "", args: [] });
  useEffect(() => {
    if (!request) return;
    let active = true;
    void refresh().then((items) => {
      if (!active || !items) return;
      requestedPopup.current = request;
      const existing = items.find((item) => item.selected && item.config.cli === request.cli) ?? items.find((item) => item.config.id === request.cli);
      if (existing) edit(existing.config); else create(request.cli);
    });
    return () => { active = false; };
  }, [request]);
  const current = instances.find((item) => item.config.id === draft?.id);
  const newInstance = !!draft && !current;
  async function loadUsage(id: string) {
    const generation = ++usageGeneration.current;
    setUsageBusy(true);
    try { const next = await agentInstanceUsage(id); if (generation === usageGeneration.current) setUsage(next); }
    catch (e) { if (generation === usageGeneration.current) setUsage({ available: false, windows: [], reason: String(e) }); }
    finally { if (generation === usageGeneration.current) setUsageBusy(false); }
  }
  useEffect(() => { setUsage(null); if (draft && current) void loadUsage(draft.id); return () => { ++usageGeneration.current; }; }, [draft?.id, !!current]);
  async function signOut() {
    if (!current || busy) return;
    setBusy(true);
    try { await signOutAgentInstance(current.config.id); await refresh(); setUsage(null); say(`${current.config.name} signed out.`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!current || busy) return;
    setBusy(true);
    try { await removeAgentInstance(current.config.id); await refresh(); setDraft(null); say(`${current.config.name} removed.`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const nextConfig = draft && { ...draft, name: draft.name.trim(), binary: draft.binary.trim(), args: args.split(/\r?\n/).filter((argument) => argument.length > 0) };
  const dirty = !!nextConfig && (newInstance || JSON.stringify(nextConfig) !== JSON.stringify(current?.config));
  const ownLaunch = newInstance || current?.managedHome !== false;
  const close = () => {
    if (waiting || busy) return;
    ++usageGeneration.current;
    const requested = requestedPopup.current;
    requestedPopup.current = null;
    closingToChat.current = requested?.closeSettingsOnClose ?? false;
    setDraft(null); setOutcome(null); setError("");
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
    try { const result = await signInAgentInstance(current.config.id); setOutcome(result); say(result.message); await refresh(); if (result.status === "signedIn") await loadUsage(current.config.id); }
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
  return (
    <>
      <SettingGroup title="Coding assistants" bare>
        <div className="overflow-hidden rounded-lg border border-line bg-raised" data-agent-instances="">
          {instances.map((instance) => {
            const key = instance.config.id === instance.config.cli ? backend(instance.config.cli) : instance.config.id;
            return <Button key={instance.config.id} variant="ghost" data-provider-row={key} data-provider-configure={key} data-agent-instance={instance.config.id} aria-label={`Manage ${instance.config.name}`} onClick={() => edit(instance.config)} className="w-full rounded-none border-b border-line text-start last:border-b-0 [&>.ui-button-face]:min-h-14 [&>.ui-button-face]:justify-start [&>.ui-button-face]:gap-3 [&>.ui-button-face]:px-3.5 [&>.ui-button-face]:py-2.5">
              <ProviderLogo provider={backend(instance.config.cli)} className="size-7 shrink-0" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><span className="truncate text-base font-medium text-ink">{instance.config.name}</span><span data-cli-status={!instance.installed ? "missing" : instance.loggedIn === false ? "signed-out" : "installed"} className="truncate text-xs font-normal text-ink-secondary">{status(instance)}{instance.plan ? ` · ${instance.plan}` : ""}</span></span>
              {instance.selected && <span className="rounded-md bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-ink">Default</span>}<Icon name="chevron-right" className="shrink-0 text-ink-tertiary" />
            </Button>;
          })}
          <Button variant="ghost" size="sm" data-agent-instance-add="" onClick={() => create("claude")} className="m-2"><Icon name="plus" />Add connection</Button>
        </div>
        {error && !draft && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
      </SettingGroup>
      <Dialog open={!!draft} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent data-provider-popup="cli" data-agent-instance-popup="" onCloseAutoFocus={(e) => { if (closingToChat.current) e.preventDefault(); closingToChat.current = false; }} className="flex flex-col overflow-hidden" showCloseButton={!waiting} onEscapeKeyDown={(e) => { if (waiting || busy) e.preventDefault(); }} onInteractOutside={(e) => { if (waiting || busy) e.preventDefault(); }}>
          <DialogHeader><div className="flex items-center gap-3">{draft && <ProviderLogo provider={backend(draft.cli)} className="size-8 shrink-0" />}<div className="min-w-0"><DialogTitle>{newInstance ? "Add connection" : draft?.name}</DialogTitle><DialogDescription className="sr-only">Account and launch options for this assistant connection.</DialogDescription></div></div></DialogHeader>
          {draft && <div data-provider-configuration={backend(draft.cli)} className="flex min-h-0 flex-col gap-5 overflow-y-auto [scrollbar-gutter:stable] px-0.5 py-1">
            {newInstance && <div className="flex flex-col gap-1.5"><label htmlFor={cliId} className="text-sm font-medium text-ink">Assistant</label><NativeSelect id={cliId} data-instance-cli="" value={draft.cli} onChange={(e) => { const cli = e.target.value as AgentCli; setDraft((d) => d && { ...d, cli, id: `${cli}-${crypto.randomUUID()}` }); }}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option></NativeSelect></div>}
            <div className="flex flex-col gap-1.5"><label htmlFor={nameId} className="text-sm font-medium text-ink">Connection name</label><Input id={nameId} data-instance-name="" value={draft.name} placeholder={`${CLI_INFO[backend(draft.cli)].name} · Personal`} maxLength={80} onChange={(e) => setDraft((d) => d && { ...d, name: e.target.value })} /></div>
            {current && <SettingGroup title="Account">
              <SettingRow label={!current.installed ? "Not installed" : current.account ?? (current.loggedIn ? "Connected account" : "Not signed in")} description={current.plan ?? undefined}>
                <div data-cli-sign-in={draft.cli} className="flex flex-wrap gap-2">
                  {current.installed ? <><Button ref={startRef} variant={current.loggedIn ? "outline" : "default"} size="sm" data-cli-sign-in-start="" disabled={waiting || busy || dirty} onClick={() => void signIn()}>{waiting ? "Waiting for sign-in…" : current.loggedIn ? "Change account" : `Sign in to ${CLI_INFO[backend(draft.cli)].name}`}</Button>{waiting && <Button ref={stopRef} variant="ghost" size="sm" data-cli-sign-in-stop="" onClick={() => void cancelAgentInstanceSignIn(draft.id)}>Cancel</Button>}</> : <a data-cli-missing={backend(draft.cli)} href={CLI_INFO[backend(draft.cli)].installUrl} target="_blank" rel="noreferrer" className="text-sm text-accent-ink">Install {CLI_INFO[backend(draft.cli)].name}<Icon name="link" className="ms-1 inline size-(--ph-icon-size-sm)" /></a>}
                  <Button variant="ghost" size="icon-sm" data-provider-refresh="" aria-label="Refresh connection status" title="Refresh status" disabled={waiting || busy} onClick={() => void refresh()}><Icon name="retry" /></Button>
                </div>
              </SettingRow>
            </SettingGroup>}
            {current?.loggedIn && draft.cli !== "gemini" && <Button variant="ghost" size="sm" className="self-start" data-instance-signout="" disabled={busy || waiting} onClick={() => void signOut()}>Sign out</Button>}
            {current && <div data-instance-usage="" className="flex flex-col gap-2"><div className="flex items-center justify-between gap-2"><h4 className="text-xs font-medium text-ink-secondary">Usage</h4><Button variant="ghost" size="icon-xs" aria-label="Refresh usage" title="Refresh usage" disabled={usageBusy} onClick={() => void loadUsage(current.config.id)}><Icon name="retry" className={usageBusy ? "animate-spin" : undefined} /></Button></div>{usageBusy && !usage ? <p className="text-xs text-ink-secondary">Loading usage…</p> : usage?.available ? usage.windows.map((window) => <div key={window.label} className="flex flex-col gap-1"><Progress label={window.label} value={window.usedPercent} max={100} valueText={`${Math.round(window.usedPercent)}% used`} size="sm" />{window.resetsAt != null && <span className="text-xs text-ink-tertiary">Resets {new Date(typeof window.resetsAt === "number" ? window.resetsAt * 1000 : window.resetsAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}</div>) : <p className="text-xs text-ink-secondary">{usage?.reason ?? "Usage isn’t available for this connection."}</p>}</div>}
            {waiting && <p role="status" className="text-sm text-ink-secondary">Finish signing in in your browser.</p>}
            {outcome && <p role="status" data-cli-sign-in-outcome={outcome.status} className="text-sm text-ink-secondary">{outcome.message}</p>}
            {ownLaunch ? <Details summary="Launch options" open={newInstance} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5"><label htmlFor={binaryId} className="text-sm font-medium text-ink">Executable <span className="font-normal text-ink-tertiary">Optional</span></label><Input id={binaryId} data-instance-binary="" value={draft.binary} placeholder={`/opt/homebrew/bin/${draft.cli}`} onChange={(e) => setDraft((d) => d && { ...d, binary: e.target.value })} /></div>
              <div className="flex flex-col gap-1.5"><label htmlFor={argsId} className="text-sm font-medium text-ink">Launch arguments</label><Textarea id={argsId} data-instance-args="" value={args} onChange={(e) => setArgs(e.target.value)} placeholder={"--model\nmodel-name"} rows={3} className="font-mono text-sm" /><p className="text-xs text-ink-secondary">One argument per line. Protocol arguments are managed by Phaethon.</p></div>
            </Details> : <Button variant="ghost" size="sm" onClick={() => create(draft.cli)} className="self-start"><Icon name="plus" />Add a separate account or custom launch</Button>}
            {current && current.config.id !== current.config.cli && <div className="border-t border-line pt-3">{removing ? <div className="flex flex-col gap-2"><p className="text-sm text-ink">Remove this connection? Its account files stay on this Mac.</p><div className="flex gap-2"><Button variant="destructive" size="sm" data-instance-remove-confirm="" disabled={busy || waiting} onClick={() => void remove()}>Remove connection</Button><Button variant="ghost" size="sm" onClick={() => setRemoving(false)}>Cancel</Button></div></div> : <Button variant="ghost" size="sm" data-instance-remove="" className="text-danger-ink" disabled={busy || waiting} onClick={() => setRemoving(true)}>Remove connection</Button>}</div>}
            {error && <p role="alert" className="text-sm text-danger-ink">{error}</p>}
          </div>}
          <DialogFooter className="shrink-0 flex-row flex-wrap">
            {dirty && <Button data-instance-save="" disabled={busy || waiting} onClick={() => void save()}>{busy ? "Saving…" : newInstance ? "Create connection" : "Save changes"}</Button>}
            {current && !current.selected && <Button variant={dirty ? "outline" : "default"} data-backend={backend(current.config.cli)} data-instance-select="" disabled={busy || waiting || dirty || !current.installed} onClick={() => void choose()}>Use as default</Button>}
            <Button variant="ghost" disabled={busy || waiting} onClick={close}>{newInstance ? "Cancel" : "Done"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
