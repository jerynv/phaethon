import { EllipsisIcon, PlusIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FieldError, cleanMessage } from "@/components/errors";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonCard } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Card, ConfirmDialog, Group, Loader, Row, Status, useLoad } from "../ui";
import {
  checkApiKey,
  clearApiKey,
  getSettings,
  type ProviderId,
  type ProviderInfo,
  providerStatus,
  type ServerStatus,
  type Settings,
  setAnthropicModel,
  setApiKey,
  setProviderModel,
  setProviderUrl,
} from "./api";
import { ModelChooser } from "./ModelChooser";
import { addedProviders, canSaveUnchecked, checkAndSave, isAdded, type KeyOutcome, outcomeText, PRESET_GROUPS, providerModel, providerNeed } from "./logic";

/**
 * Settings › Providers: the services and local servers Phaethon's own agent
 * can answer with. Each one gets a card with its key (checked, then saved;
 * a saved key is never shown again), its address where that's editable, a
 * local server's status, and its model. The model for a conversation is
 * picked in the composer; this is where providers become pickable.
 */

type Server = ServerStatus | "checking" | { error: string } | null;

function statusOf(p: ProviderInfo, s: Settings, server: Server): { tone: "ready" | "warning" | "busy" | "error"; text: string } {
  if (p.local && server === "checking") return { tone: "busy", text: "Checking…" };
  if (p.local && server && server !== "checking" && ("error" in server || !server.running)) return { tone: "error", text: "Not running" };
  const need = providerNeed(p, s);
  if (need?.field === "key") return { tone: "warning", text: "Needs a key" };
  if (need?.field === "url") return { tone: "warning", text: "Needs an address" };
  if (need?.field === "model") return { tone: "warning", text: "Choose a model" };
  return { tone: "ready", text: "Ready" };
}

const host = (url: string) => {
  try {
    const u = new URL(url);
    return (u.host + u.pathname).replace(/\/$/, "");
  } catch {
    return url;
  }
};

function KeyRow({ p, autoFocus, onChanged }: { p: ProviderInfo; autoFocus?: boolean; onChanged: () => Promise<void> }) {
  const [replacing, setReplacing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"check" | "save" | "remove" | null>(null);
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const [confirm, setConfirm] = useState(false);
  const editing = !p.hasKey || replacing;
  const id = `key-${p.id}`;

  const submit = async (skipCheck = false) => {
    setBusy(skipCheck ? "save" : "check");
    setOutcome(null);
    const o = await checkAndSave(value, p.id, { check: checkApiKey, save: setApiKey }, skipCheck);
    setBusy(null);
    if (o.kind === "saved" || o.kind === "no-credit") {
      setValue("");
      setReplacing(false);
      setOutcome(o.kind === "no-credit" ? o : null);
      await onChanged();
      return;
    }
    setOutcome(o);
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await clearApiKey(p.id);
      setOutcome(null);
      await onChanged();
    } catch (e) {
      toast.error("Couldn’t remove the key", cleanMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!editing) {
    return (
      <Row
        label="API key"
        description={<Status tone="ready">Saved</Status>}
        below={outcome?.kind === "no-credit" ? <p className="text-warning-foreground text-xs">{outcomeText(outcome, p)}</p> : undefined}
      >
        <Button size="xs" variant="outline" onClick={() => setReplacing(true)}>
          Replace
        </Button>
        <Button size="xs" variant="ghost-destructive" onClick={() => setConfirm(true)} disabled={busy === "remove"}>
          {busy === "remove" ? <Spinner /> : null}
          Remove
        </Button>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove your ${p.name} key?`} confirm="Remove key" destructive onConfirm={() => void remove()}>
          <p>Phaethon deletes it from this computer’s keychain. Conversations that use {p.name} stop answering until you add a key again.</p>
        </ConfirmDialog>
      </Row>
    );
  }

  const problem = outcome?.kind === "problem" ? outcome : null;
  return (
    <Row
      label="API key"
      htmlFor={id}
      description={p.keysUrl ? <>Create one at <span className="text-foreground/80">{host(p.keysUrl)}</span></> : p.key === "optional" ? "Only if your server asks for one." : undefined}
      below={
        <div className="flex flex-col gap-1.5">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              id={id}
              type="password"
              size="sm"
              autoFocus={autoFocus || replacing}
              autoComplete="off"
              spellCheck={false}
              value={value}
              aria-invalid={problem ? true : undefined}
              placeholder={p.keyPrefix ? `${p.keyPrefix}…` : "Paste your key"}
              onChange={(e) => {
                setValue(e.target.value);
                if (problem) setOutcome(null);
              }}
              className="font-mono"
            />
            <Button type="submit" size="sm" disabled={busy !== null} className="min-w-[7.5rem]">
              {busy === "check" ? <Spinner /> : null}
              {busy === "check" ? "Checking…" : "Check and save"}
            </Button>
            {replacing ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setReplacing(false);
                  setValue("");
                  setOutcome(null);
                }}
              >
                Cancel
              </Button>
            ) : null}
          </form>
          {problem ? (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <FieldError>{outcomeText(problem, p)}</FieldError>
              {canSaveUnchecked(problem) ? (
                <button type="button" className="font-medium text-foreground text-xs hover:underline disabled:opacity-60" disabled={busy !== null} onClick={() => void submit(true)}>
                  {busy === "save" ? "Saving…" : "Save without checking"}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      }
    />
  );
}

function UrlRow({ p, onChanged }: { p: ProviderInfo; onChanged: () => Promise<void> }) {
  const [draft, setDraft] = useState(p.baseUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(p.baseUrl), [p.baseUrl]);
  const id = `url-${p.id}`;
  const dirty = draft.trim() !== p.baseUrl;
  const save = async (url: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await setProviderUrl(p.id, url);
      await onChanged();
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Server address"
      htmlFor={id}
      below={
        <div className="flex flex-col gap-1.5">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) void save(draft.trim() || null);
            }}
          >
            <Input
              id={id}
              size="sm"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={error ? true : undefined}
              placeholder={p.defaultBaseUrl || "https://example.com/v1"}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              className="font-mono"
            />
            {dirty ? (
              <Button type="submit" size="sm" disabled={busy} className="min-w-16">
                {busy ? <Spinner /> : null}
                {busy ? "Saving…" : "Save"}
              </Button>
            ) : p.defaultBaseUrl && p.baseUrl !== p.defaultBaseUrl ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
                Reset
              </Button>
            ) : null}
          </form>
          <FieldError>{error}</FieldError>
        </div>
      }
    />
  );
}

function ServerRow({ p, server, onCheck }: { p: ProviderInfo; server: Server; onCheck: () => void }) {
  const checking = server === "checking";
  const message = !server || checking ? null : "error" in server ? server.error : server.message;
  const running = !!server && !checking && !("error" in server) && server.running;
  return (
    <Row
      label="Server"
      description={
        checking ? (
          `Looking for ${p.name}…`
        ) : message ? (
          <span className={cn("[overflow-wrap:anywhere]", !running && "text-foreground/80")}>{message}</span>
        ) : (
          "Not checked yet"
        )
      }
    >
      <Button size="xs" variant="outline" onClick={onCheck} disabled={checking} className="min-w-24">
        {checking ? <Spinner /> : <RotateCwIcon />}
        {checking ? "Checking…" : "Check again"}
      </Button>
    </Row>
  );
}

function ModelRow({ p, settings, onChanged }: { p: ProviderInfo; settings: Settings; onChanged: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const need = providerNeed(p, settings);
  const blocked = need?.field === "key" || need?.field === "url";
  const current = providerModel(p, settings);
  const choose = async (model: string) => {
    setBusy(true);
    setError(null);
    try {
      if (p.id === "anthropic") await setAnthropicModel(model);
      else await setProviderModel(p.id, model);
      await onChanged();
    } catch (e) {
      setError(`Couldn’t save the model: ${cleanMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row
      label="Model"
      description={blocked ? (need?.field === "key" ? "Add a key to see the models." : "Add the address to see the models.") : "Used when a chat picks this provider without naming a model."}
      below={error ? <FieldError>{error}</FieldError> : undefined}
    >
      {busy ? <Spinner size="sm" tone="muted" /> : null}
      <ModelChooser provider={p} current={current} disabled={blocked || busy} onChoose={(m) => void choose(m)} />
    </Row>
  );
}

function ProviderCard({
  p,
  settings,
  isNew,
  onChanged,
  onCancel,
}: {
  p: ProviderInfo;
  settings: Settings;
  isNew: boolean;
  onChanged: () => Promise<void>;
  onCancel?: () => void;
}) {
  const [server, setServer] = useState<Server>(null);
  const [confirm, setConfirm] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const check = async () => {
    setServer("checking");
    try {
      setServer(await providerStatus(p.id));
    } catch (e) {
      setServer({ error: cleanMessage(e) });
    }
  };
  useEffect(() => {
    if (p.local) void check();
  }, [p.local, p.baseUrl]);
  useEffect(() => {
    if (isNew) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [isNew]);

  const st = statusOf(p, settings, server);
  const added = isAdded(p);
  const removable = added && p.id !== settings.provider;
  const remove = async () => {
    try {
      if (p.hasKey) await clearApiKey(p.id);
      if (p.id !== "anthropic" && p.model) await setProviderModel(p.id, null);
      if (p.editableBase && p.baseUrl !== p.defaultBaseUrl) await setProviderUrl(p.id, null);
      await onChanged();
      toast.success(`${p.name} removed`);
    } catch (e) {
      toast.error(`Couldn’t remove ${p.name}`, cleanMessage(e));
    }
  };

  return (
    <div ref={ref}>
      <Card className={cn(isNew && "ring-1 ring-primary/30")}>
        <div className="flex min-h-11 items-center gap-2.5 px-3.5 py-2.5">
          <ProviderIcon id={p.id} />
          <Truncate className="min-w-0 flex-1 font-medium text-sm">{p.name}</Truncate>
          <Status tone={st.tone === "busy" ? "busy" : st.tone}>{st.text}</Status>
          {removable || onCancel ? (
            <Menu>
              <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label={`${p.name} actions`} />}>
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {onCancel && !added ? <MenuItem onClick={onCancel}>Cancel adding</MenuItem> : null}
                {removable ? (
                  <MenuItem variant="destructive" onClick={() => setConfirm(true)}>
                    Remove {p.name}
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {p.editableBase ? <UrlRow p={p} onChanged={onChanged} /> : null}
        {p.local ? <ServerRow p={p} server={server} onCheck={() => void check()} /> : null}
        {p.key !== "none" ? <KeyRow p={p} autoFocus={isNew && !p.editableBase} onChanged={onChanged} /> : null}
        <ModelRow p={p} settings={settings} onChanged={onChanged} />
      </Card>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove ${p.name}?`} confirm="Remove" destructive onConfirm={() => void remove()}>
        <p>{p.hasKey ? "Its key is deleted from this computer’s keychain, and its" : "Its"} model and address go back to the defaults. Chats that use it stop answering until you add it again.</p>
      </ConfirmDialog>
    </div>
  );
}

function AddProvider({ settings, shown, onAdd }: { settings: Settings; shown: Set<ProviderId>; onAdd: (id: ProviderId) => void }) {
  const left = settings.providers.filter((p) => !shown.has(p.id));
  if (!left.length) return null;
  const groups = PRESET_GROUPS.map((g) => ({ label: g.label, items: left.filter(g.test) })).filter((g) => g.items.length);
  return (
    <Menu>
      <MenuTrigger render={<Button size="xs" variant="outline" />}>
        <PlusIcon />
        Add provider
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        {groups.map((g, i) => (
          <div key={g.label}>
            {i > 0 ? <MenuSeparator /> : null}
            <MenuGroup>
              <MenuGroupLabel>{g.label}</MenuGroupLabel>
              {g.items.map((p) => (
                <MenuItem key={p.id} onClick={() => onAdd(p.id)}>
                  <ProviderIcon id={p.id} />
                  {p.name}
                </MenuItem>
              ))}
            </MenuGroup>
          </div>
        ))}
      </MenuPopup>
    </Menu>
  );
}

export function ProvidersSection() {
  const state = useLoad(getSettings);
  const [pending, setPending] = useState<ProviderId[]>([]);
  const reload = async () => {
    try {
      state.setData(await getSettings());
    } catch (e) {
      toast.error("Couldn’t refresh providers", cleanMessage(e));
    }
  };
  return (
    <Loader state={state} errorTitle="Couldn’t read your providers" skeleton={<SkeletonCard rows={4} />}>
      {(settings) => {
        const added = addedProviders(settings);
        const shownIds = new Set<ProviderId>(added.map((p) => p.id));
        const extra = pending.filter((id) => !shownIds.has(id)).map((id) => settings.providers.find((p) => p.id === id)).filter((p): p is ProviderInfo => !!p);
        for (const p of extra) shownIds.add(p.id);
        const list = [...added, ...extra];
        return (
          <Group
            label="Phaethon’s own agent answers with these"
            action={<AddProvider settings={settings} shown={shownIds} onAdd={(id) => setPending((xs) => [...xs, id])} />}
          >
            {list.length === 0 ? (
              <Card>
                <Empty className="py-10">
                  <EmptyHeader>
                    <EmptyTitle className="text-sm">No providers yet</EmptyTitle>
                    <EmptyDescription className="text-xs">Add one to chat with Phaethon’s own agent.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </Card>
            ) : (
              <div className="flex flex-col gap-3">
                {list.map((p) => (
                  <ProviderCard
                    key={p.id}
                    p={p}
                    settings={settings}
                    isNew={pending.includes(p.id) && !isAdded(p)}
                    onChanged={reload}
                    onCancel={pending.includes(p.id) ? () => setPending((xs) => xs.filter((x) => x !== p.id)) : undefined}
                  />
                ))}
              </div>
            )}
          </Group>
        );
      }}
    </Loader>
  );
}
