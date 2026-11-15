import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { EmptyState, FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonCard } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ConfirmDialog, Field, Intro, Loader, Row, SettingsCard, Status, useLoad, Well } from "../ui";
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
      <Field label="API key" hint={outcome?.kind === "no-credit" ? <span className="text-warning-foreground">{outcomeText(outcome, p)}</span> : undefined}>
        <Well>
          <Icon icon={icons.key} className="size-4 text-muted-foreground" />
          <span aria-hidden className="text-muted-foreground tracking-tight">••••••••</span>
          <Status tone="ready" className="ml-1">
            Saved
          </Status>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={() => setReplacing(true)}>
            Replace
          </Button>
          <Button size="xs" variant="ghost-destructive" onClick={() => setConfirm(true)} pending={busy === "remove"}>
            Remove
          </Button>
        </Well>
        <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove your ${p.name} key?`} confirm="Remove key" destructive onConfirm={() => void remove()}>
          <p>Phaethon deletes it from this computer’s keychain. Conversations that use {p.name} stop answering until you add a key again.</p>
        </ConfirmDialog>
      </Field>
    );
  }

  const problem = outcome?.kind === "problem" ? outcome : null;
  return (
    <Field
      label="API key"
      htmlFor={id}
      aside={
        p.keysUrl ? (
          <a href={p.keysUrl} target="_blank" rel="noreferrer noopener" className="text-primary text-sm hover:underline">
            Get a key at {host(p.keysUrl)}
          </a>
        ) : p.key === "optional" ? (
          <span className="text-subtle-foreground text-xs">Only if your server asks for one</span>
        ) : undefined
      }
    >
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          id={id}
          type="password"
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
        <Button type="submit" size="sm" disabled={busy !== null && busy !== "check"} pending={busy === "check"}>
          Check and save
        </Button>
      </form>
      {busy === "check" ? (
        <p role="status" className="text-muted-foreground text-xs">
          Asking {p.name} whether the key works…
        </p>
      ) : null}
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
    </Field>
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
    <Field label="Server address" htmlFor={id}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) void save(draft.trim() || null);
        }}
      >
        <Input
          id={id}
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
          <Button type="submit" size="sm" pending={busy}>
            Save
          </Button>
        ) : p.defaultBaseUrl && p.baseUrl !== p.defaultBaseUrl ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(null)}>
            Reset
          </Button>
        ) : null}
      </form>
      <FieldError>{error}</FieldError>
    </Field>
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
        {checking ? <Spinner /> : <Icon icon={icons.retry} />}
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
      label="Default model"
      description={blocked ? (need?.field === "key" ? "Add a key to see the models." : "Add the address to see the models.") : "For chats that don’t name a model."}
      below={error ? <FieldError>{error}</FieldError> : undefined}
    >
      {busy ? <Spinner size="sm" tone="muted" /> : null}
      <ModelChooser provider={p} current={blocked ? null : current} disabled={blocked || busy} onChoose={(m) => void choose(m)} />
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
    <motion.div ref={ref} layout="position" initial={isNew ? { opacity: 0, y: 6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 460, damping: 38 }}>
      <SettingsCard
        className={cn(isNew && "border-primary/40")}
        icon={<ProviderIcon id={p.id} />}
        title={p.name}
        description={
          <span className="flex min-w-0 items-center gap-2">
            <Status tone={st.tone}>{st.text}</Status>
            {p.id === settings.provider ? <span className="text-subtle-foreground">· Default</span> : null}
          </span>
        }
        action={
          removable || onCancel ? (
            <Menu>
              <MenuTrigger render={<Button size="icon-sm" variant="ghost-muted" aria-label={`${p.name} actions`} />}>
                <Icon icon={icons.more} />
              </MenuTrigger>
              <MenuPopup align="end">
                {onCancel && !added ? <MenuItem onClick={onCancel}>Cancel adding</MenuItem> : null}
                {removable ? (
                  <MenuItem variant="destructive" onClick={() => setConfirm(true)}>
                    <Icon icon={icons.delete} />
                    Remove {p.name}
                  </MenuItem>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null
        }
      >
        {p.editableBase ? <UrlRow p={p} onChanged={onChanged} /> : null}
        {p.key !== "none" ? <KeyRow p={p} autoFocus={isNew && !p.editableBase} onChanged={onChanged} /> : null}
        <div className="flex flex-col">
          {p.local ? <ServerRow p={p} server={server} onCheck={() => void check()} /> : null}
          <ModelRow p={p} settings={settings} onChanged={onChanged} />
        </div>
      </SettingsCard>
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove ${p.name}?`} confirm="Remove" destructive onConfirm={() => void remove()}>
        <p>{p.hasKey ? "Its key is deleted from this computer’s keychain, and its" : "Its"} model and address go back to the defaults. Chats that use it stop answering until you add it again.</p>
      </ConfirmDialog>
    </motion.div>
  );
}

function AddProvider({ settings, shown, onAdd }: { settings: Settings; shown: Set<ProviderId>; onAdd: (id: ProviderId) => void }) {
  const left = settings.providers.filter((p) => !shown.has(p.id));
  if (!left.length) return null;
  const groups = PRESET_GROUPS.map((g) => ({ label: g.label, items: left.filter(g.test) })).filter((g) => g.items.length);
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" />}>
        <Icon icon={icons.add} />
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
          <>
            <Intro action={<AddProvider settings={settings} shown={shownIds} onAdd={(id) => setPending((xs) => [...xs, id])} />}>
              Phaethon’s own agent answers with these.
            </Intro>
            {list.length === 0 ? (
              <EmptyState palette="dawn" seed="providers" title="No providers yet" description="Add one to chat with Phaethon’s own agent." className="max-w-none" />
            ) : (
              list.map((p) => (
                <ProviderCard
                  key={p.id}
                  p={p}
                  settings={settings}
                  isNew={pending.includes(p.id) && !isAdded(p)}
                  onChanged={reload}
                  onCancel={pending.includes(p.id) ? () => setPending((xs) => xs.filter((x) => x !== p.id)) : undefined}
                />
              ))
            )}
          </>
        );
      }}
    </Loader>
  );
}
