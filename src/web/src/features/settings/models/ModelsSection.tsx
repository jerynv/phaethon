import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useNav } from "@/app/store";
import { FieldError, cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonCard } from "@/components/skeletons";
import { toast } from "@/components/toast";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs";
import { invalidate } from "@/lib/query";
import { cn } from "@/lib/utils";
import { ConfirmDialog, CopyButton, Loader, Row, RowDetail, SettingsGroup, Status, SwitchRow, useLoad } from "../ui";
import { AddAccount, InstanceRow } from "../agents/accounts";
import { CLI_IDS, CLI_INFO, type CliId, type CliStatus, type InstanceView, cancelInstanceSignIn, cliStatuses, listInstances, signInInstance } from "../agents/api";
import { canInstall, useCliInstall } from "../agents/install";
import { currentInstance } from "../agents/logic";
import {
  SETTINGS_CHANGED_EVENT,
  type ProviderId,
  type ProviderInfo,
  type Settings,
  type SettingsChangedDetail,
  clearApiKey,
  getSettings,
  providerStatus,
  setAutoFallback,
  setProviderModel,
  setProviderUrl,
} from "../providers/api";
import { isAdded, providerModel, providerNeed, readableModel } from "../providers/logic";
import { KeyRow, ModelRow, type Server, ServerRow, UrlRow } from "../providers/rows";
import { MODELS_COPY as C } from "./copy";

/**
 * Settings › AI & Models: every service Phaethon can answer with, on one
 * page, always visible. No "add" menu to discover: fixed sections (Claude,
 * ChatGPT and Gemini; more services; on this computer; your own server),
 * a row per service with its state, and a row that isn't set up yet says so
 * with a tagline and a "Set up" cue. Rows open in place to connect.
 *
 * Claude, ChatGPT and Gemini connect two ways: a plan the person already pays
 * for (through the maker's own app and sign-in; Phaethon never sees the
 * password) or an API key. Automatic fallback sits last.
 */

type BrandMode = "subscription" | "api";
type BrandId = "claude" | "openai" | "google";
type BrandDef = { id: BrandId; name: string; providerId: ProviderId; cliId: CliId; defaultMode: BrandMode };

const BRANDS: readonly BrandDef[] = [
  { id: "claude", name: "Claude", providerId: "anthropic", cliId: "claude", defaultMode: "subscription" },
  { id: "openai", name: "ChatGPT", providerId: "openai", cliId: "codex", defaultMode: "subscription" },
  { id: "google", name: "Google Gemini", providerId: "google", cliId: "gemini", defaultMode: "api" },
];
const BRAND_PROVIDERS = new Set<ProviderId>(BRANDS.map((b) => b.providerId));

type ModelsData = { settings: Settings; clis: CliStatus[]; instances: InstanceView[] };
type Tone = "ready" | "warning" | "neutral" | "error" | "busy";

function notifySettingsChanged(what: SettingsChangedDetail["what"] = "backend") {
  window.dispatchEvent(new CustomEvent<SettingsChangedDetail>(SETTINGS_CHANGED_EVENT, { detail: { what } }));
}

function resolveBrandId(name: string): BrandId | null {
  if (["claude", "anthropic", "claude-cli"].includes(name)) return "claude";
  if (["openai", "codex", "codex-cli", "chatgpt"].includes(name)) return "openai";
  if (["google", "gemini", "gemini-cli"].includes(name)) return "google";
  return null;
}

/** Whether a brand's plan is signed in, and whether its API key route is ready. */
function brandState(brand: BrandDef, data: ModelsData) {
  const { settings, clis, instances } = data;
  const provider = settings.providers.find((p) => p.id === brand.providerId);
  const cliStatus = clis.find((c) => c.id === brand.cliId);
  const mine = instances.filter((i) => i.config.cli === brand.cliId);
  const cur = currentInstance(instances, brand.cliId);
  const cliInstalled = cliStatus?.installed ?? mine.some((i) => i.installed);
  const subReady = cliInstalled && (cur?.loggedIn === true || mine.some((i) => i.installed && i.loggedIn === true) || cliStatus?.loggedIn === true);
  const apiReady = !!provider && (provider.ready || (isAdded(provider) && !providerNeed(provider, settings)));
  return { provider, cliStatus, mine, cur, cliInstalled, subReady, apiReady };
}

/** One service's line: glyph, name (and a tagline until it's set up), what it's using, its state, and a chevron. */
function ServiceHeader({
  icon,
  name,
  tagline,
  secondary,
  status,
  setUp,
  open,
  panelId,
  onToggle,
  extra,
}: {
  icon: string;
  name: string;
  tagline?: ReactNode;
  secondary?: string | null;
  status: { tone: Tone; text: string } | null;
  setUp: boolean;
  open: boolean;
  panelId: string;
  onToggle: () => void;
  extra?: ReactNode;
}) {
  // The tagline sells a service that isn't set up yet; once it is, the row says what it's using instead.
  const showTagline = !!tagline && !open && !setUp;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={onToggle}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 px-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        showTagline ? "min-h-12 py-2" : "h-10",
      )}
    >
      <ProviderIcon id={icon} className="size-4 shrink-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{name}</span>
        {showTagline ? <span className="truncate text-muted-foreground text-xs">{tagline}</span> : null}
      </span>
      {extra}
      {secondary && !open ? <span className="hidden max-w-48 truncate text-muted-foreground text-xs sm:block">{secondary}</span> : null}
      {setUp || open ? (
        status ? (
          <Status tone={status.tone} className="max-w-56 shrink-0">
            <Truncate className="min-w-0">{status.text}</Truncate>
          </Status>
        ) : null
      ) : (
        <span aria-hidden className="shrink-0 rounded-full border px-2 py-0.5 font-medium text-foreground text-xs">
          {C.status.setUp}
        </span>
      )}
      {!setUp && !open ? <span className="sr-only">, {C.status.notSetUp}</span> : null}
      <Icon icon={icons.chevronDown} className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200", !open && "-rotate-90")} />
    </button>
  );
}

/** The opening and closing of a row's panel; instant when the person prefers less motion. */
function Panel({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          id={id}
          initial={reduce ? false : { height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="overflow-hidden"
        >
          <RowDetail>{children}</RowDetail>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Remove a key-based service: its key, model and address go back to the defaults. */
function useRemove(p: ProviderInfo | undefined, onChanged: () => Promise<void>) {
  const [confirm, setConfirm] = useState(false);
  const remove = async () => {
    if (!p) return;
    try {
      if (p.hasKey) await clearApiKey(p.id);
      if (p.id !== "anthropic" && p.model) await setProviderModel(p.id, null);
      if (p.editableBase && p.baseUrl !== p.defaultBaseUrl) await setProviderUrl(p.id, null);
      await onChanged();
      toast.success(C.remove.done(p.name));
    } catch (e) {
      toast.error(C.remove.failed(p.name), cleanMessage(e));
    }
  };
  const button = (
    <div className="flex justify-end px-3 py-1.5">
      <Button size="xs" variant="ghost-destructive" onClick={() => setConfirm(true)}>
        <Icon icon={icons.delete} />
        {p ? C.remove.button(p.name) : null}
      </Button>
    </div>
  );
  const dialog = p ? (
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={C.remove.title(p.name)} confirm={C.remove.confirm} destructive onConfirm={() => void remove()}>
      <p>{p.hasKey ? C.remove.bodyWithKey : C.remove.bodyNoKey}</p>
    </ConfirmDialog>
  ) : null;
  return { button, dialog };
}

/** A plan's setup while its maker's app isn't installed: install it and sign in, in one step; or the Terminal command. */
function PlanSetup({ brand, onChanged, onUseKey, onRecheck, rechecking }: { brand: BrandDef; onChanged: () => Promise<void>; onUseKey: () => void; onRecheck: () => void; rechecking: boolean }) {
  const info = CLI_INFO[brand.cliId];
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const installer = useCliInstall(async (cli) => {
    await onChanged();
    // Installed: go straight on to the maker's sign-in, so it's one step for the person.
    setSigning(true);
    try {
      const r = await signInInstance(cli);
      if (r.status === "signedIn") {
        toast.success(r.message);
        await onChanged();
      } else if (r.status !== "cancelled") setError(r.message);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setSigning(false);
    }
  });
  const installable = canInstall(brand.cliId);
  const installing = installer.installing === brand.cliId;
  const failure = error ?? (installer.error?.cli === brand.cliId ? installer.error.text : null);

  return (
    <>
      <Row
        label={C.setup.title(info.name)}
        description={installable ? C.setup.body(info.name, info.company) : C.setup.manualOnly(info.name)}
        below={
          failure ? (
            <div className="flex flex-col gap-2 pt-0.5">
              <FieldError>{failure}</FieldError>
              <div className="flex flex-wrap items-center gap-2">
                {installable ? (
                  <Button size="xs" variant="outline" onClick={() => void installer.install(brand.cliId)}>
                    {C.setup.retry}
                  </Button>
                ) : null}
                <Button size="xs" variant="ghost" onClick={onUseKey}>
                  {C.setup.useKeyInstead}
                </Button>
              </div>
            </div>
          ) : undefined
        }
      >
        {installing || signing ? (
          <>
            <span role="status" className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
              <Spinner size="sm" />
              {installing ? C.setup.installing(info.name) : C.setup.signingIn}
            </span>
            <Button size="xs" variant="ghost" onClick={() => (installing ? installer.cancel(brand.cliId) : void cancelInstanceSignIn(brand.cliId))}>
              {C.setup.cancel}
            </Button>
          </>
        ) : installable ? (
          <Button size="xs" disabled={!!installer.installing} onClick={() => void installer.install(brand.cliId)}>
            {C.setup.button}
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={onRecheck} disabled={rechecking}>
            {rechecking ? <Spinner /> : null}
            {rechecking ? C.setup.checking : C.setup.checkAgain}
          </Button>
        )}
      </Row>
      {installable ? (
        <button
          type="button"
          aria-expanded={manual}
          onClick={() => setManual((v) => !v)}
          className="flex h-9 w-full items-center gap-1.5 px-3 text-left text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <Icon icon={icons.chevronDown} className={cn("size-3.5 shrink-0 transition-transform duration-150", !manual && "-rotate-90")} />
          {C.setup.manualToggle}
        </button>
      ) : null}
      {manual || !installable ? (
        <Row label={C.setup.manualLabel} description={<code className="block overflow-x-auto whitespace-nowrap font-mono">{info.install}</code>}>
          <CopyButton text={info.install} label={C.setup.copy} />
          {installable ? (
            <Button size="xs" variant="outline" onClick={onRecheck} disabled={rechecking}>
              {rechecking ? <Spinner /> : null}
              {rechecking ? C.setup.checking : C.setup.checkAgain}
            </Button>
          ) : null}
        </Row>
      ) : null}
    </>
  );
}

function BrandRow({
  brand,
  data,
  open,
  mode,
  onToggle,
  onSelectMode,
  onProviderChanged,
  onAgentChanged,
  onRecheck,
  rechecking,
  rowRef,
}: {
  brand: BrandDef;
  data: ModelsData;
  open: boolean;
  mode: BrandMode;
  onToggle: () => void;
  onSelectMode: (m: BrandMode) => void;
  onProviderChanged: () => Promise<void>;
  onAgentChanged: () => Promise<void>;
  onRecheck: () => void;
  rechecking: boolean;
  rowRef: (el: HTMLDivElement | null) => void;
}) {
  const { settings } = data;
  const { provider, mine, cur, cliInstalled, subReady, apiReady } = brandState(brand, data);
  const copy = C.brands[brand.id];
  const model = provider ? providerModel(provider, settings) : null;
  const removable = !!provider && isAdded(provider) && provider.id !== settings.provider;
  const removal = useRemove(provider, onProviderChanged);
  const panelId = `service-panel-${brand.id}`;

  const status: { tone: Tone; text: string } | null =
    subReady && apiReady
      ? { tone: "ready", text: C.status.readyBoth }
      : subReady
        ? { tone: "ready", text: cur?.plan && cur.plan.length <= 12 ? C.status.readyPlan(cur.plan) : C.status.readySubscription }
        : apiReady
          ? { tone: "ready", text: C.status.readyApiKey }
          : provider?.hasKey
            ? { tone: "warning", text: C.status.chooseModel }
            : { tone: "neutral", text: C.status.notSetUp };
  const setUp = subReady || apiReady || !!provider?.hasKey;
  const secondary = subReady && cur?.account ? cur.account : apiReady && model ? readableModel(model) : null;

  return (
    <div ref={rowRef} data-brand={brand.id} data-agent={brand.cliId} data-provider={brand.providerId}>
      <ServiceHeader
        icon={brand.id}
        name={brand.name}
        tagline={C.taglines[brand.id]}
        secondary={secondary}
        status={status}
        setUp={setUp}
        open={open}
        panelId={panelId}
        onToggle={onToggle}
      />
      <Panel id={panelId} open={open}>
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <Tabs value={mode} onValueChange={(v) => onSelectMode(v as BrandMode)} className="gap-0">
            <TabsList size="sm" aria-label={brand.name} className="w-fit">
              <TabsTab value="subscription">
                {copy.subscriptionTab}
                {subReady ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" /> : null}
              </TabsTab>
              <TabsTab value="api">
                {C.brands.apiTab}
                {apiReady ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" /> : null}
              </TabsTab>
            </TabsList>
          </Tabs>
          <p className="text-muted-foreground text-xs leading-relaxed">{mode === "subscription" ? copy.subscriptionBody : copy.apiBody}</p>
        </div>
        {mode === "subscription" ? (
          !cliInstalled ? (
            <PlanSetup brand={brand} onChanged={onAgentChanged} onUseKey={() => onSelectMode("api")} onRecheck={onRecheck} rechecking={rechecking} />
          ) : (
            <>
              {mine.map((i) => (
                <InstanceRow key={i.config.id} i={i} current={cur?.config.id === i.config.id} many={mine.length > 1} onChanged={onAgentChanged} />
              ))}
              <AddAccount cli={brand.cliId} onChanged={onAgentChanged} />
              <Row label={C.refresh.label}>
                <Button size="xs" variant="outline" onClick={onRecheck} disabled={rechecking}>
                  {rechecking ? <Spinner /> : <Icon icon={icons.retry} />}
                  {rechecking ? C.refresh.busy : C.refresh.button}
                </Button>
              </Row>
            </>
          )
        ) : provider ? (
          <>
            <KeyRow p={provider} onChanged={onProviderChanged} />
            <ModelRow p={provider} settings={settings} onChanged={onProviderChanged} />
            {removable ? removal.button : null}
          </>
        ) : null}
      </Panel>
      {removal.dialog}
    </div>
  );
}


/** Any other service, local server or custom address: its key, address, server and model open under it. */
function ServiceRow({ p, settings, open, onToggle, onChanged, rowRef }: { p: ProviderInfo; settings: Settings; open: boolean; onToggle: () => void; onChanged: () => Promise<void>; rowRef: (el: HTMLDivElement | null) => void }) {
  const [server, setServer] = useState<Server>(null);
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

  const added = isAdded(p);
  const running = !!server && server !== "checking" && !("error" in server) && server.running;
  const need = providerNeed(p, settings);
  const model = providerModel(p, settings);
  const removable = added && p.id !== settings.provider;
  const removal = useRemove(p, onChanged);
  const panelId = `service-panel-${p.id}`;

  const status: { tone: Tone; text: string } = !added
    ? { tone: "neutral", text: C.status.notSetUp }
    : p.local && server === "checking"
      ? { tone: "busy", text: C.status.checking }
      : p.local && server && !running
        ? { tone: "error", text: C.status.notRunning }
        : need
          ? { tone: "warning", text: need.field === "model" ? C.status.chooseModel : need.field === "key" ? C.status.needsKey : C.status.needsAddress }
          : { tone: "ready", text: C.status.ready };

  const tagline = p.local && running && !added ? <span className="text-success-foreground">{C.status.foundLocal}</span> : C.taglines[p.id];

  return (
    <div ref={rowRef} data-provider={p.id}>
      <ServiceHeader
        icon={p.id}
        name={p.name}
        tagline={tagline}
        secondary={added && model ? readableModel(model) : null}
        status={status}
        setUp={added}
        open={open}
        panelId={panelId}
        onToggle={onToggle}
        extra={p.id === settings.provider && added ? <span className="shrink-0 text-subtle-foreground text-xs">{C.status.default}</span> : null}
      />
      <Panel id={panelId} open={open}>
        {p.editableBase ? <UrlRow p={p} onChanged={onChanged} /> : null}
        {p.key !== "none" ? <KeyRow p={p} autoFocus={!added && !p.editableBase} onChanged={onChanged} /> : null}
        {p.local ? <ServerRow p={p} server={server} onCheck={() => void check()} /> : null}
        <ModelRow p={p} settings={settings} onChanged={onChanged} />
        {removable ? removal.button : null}
      </Panel>
      {removal.dialog}
    </div>
  );
}

function QuickStart({ onSubscription, onApiKey, onLocal }: { onSubscription: () => void; onApiKey: () => void; onLocal: () => void }) {
  const cards = [
    { id: "subscription", icon: icons.signIn, ...C.quickStart.subscription, onClick: onSubscription },
    { id: "api", icon: icons.key, ...C.quickStart.apiKey, onClick: onApiKey },
    { id: "local", icon: icons.system, ...C.quickStart.local, onClick: onLocal },
  ];
  return (
    <section data-testid="models-quickstart" className="flex flex-col gap-1.5">
      <div className="flex min-h-6 items-end px-1">
        <h2 className="min-w-0 truncate text-subtle-foreground text-xs">{C.quickStart.heading}</h2>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {cards.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={c.onClick}
            className="group flex flex-col items-start gap-2 rounded-card border bg-card p-3.5 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-7 items-center justify-center rounded-lg border bg-well text-muted-foreground transition-colors group-hover:text-foreground">
              <Icon icon={c.icon} className="size-4" />
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-medium text-foreground text-sm leading-snug">{c.title}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">{c.body}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function ModelsSection() {
  const state = useLoad<ModelsData>(
    async () => {
      const [settings, clis, instances] = await Promise.all([getSettings(), cliStatuses(), listInstances()]);
      return { settings, clis, instances };
    },
    [],
    "settings:models",
  );
  const settingsTarget = useNav((s) => s.settingsTarget);
  const clearSettingsTarget = useNav((s) => s.clearSettingsTarget);

  /** One row open at a time: a brand id or a provider id. */
  const [open, setOpen] = useState<string | null>(null);
  const [brandModes, setBrandModes] = useState<Partial<Record<BrandId, BrandMode>>>({});
  const [rechecking, setRechecking] = useState(false);
  const [fallbackBusy, setFallbackBusy] = useState(false);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});

  const reload = async (announce = false) => {
    try {
      const [settings, clis, instances] = await Promise.all([getSettings(), cliStatuses(), listInstances()]);
      state.setData({ settings, clis, instances });
      if (announce) notifySettingsChanged("backend");
    } catch (e) {
      toast.error(C.errors.refresh, cleanMessage(e));
    }
  };
  const recheck = async () => {
    setRechecking(true);
    // Usage limits and model lists belong to the account; a recheck reads both again (the model picker reloads on the settings event).
    invalidate("agents:usage");
    await reload(true);
    setRechecking(false);
  };
  const openRow = (id: string, mode?: BrandMode) => {
    setOpen(id);
    if (mode) setBrandModes((m) => ({ ...m, [id]: mode }));
    requestAnimationFrame(() => rows.current[id]?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };

  useEffect(() => {
    if (!settingsTarget || !state.data) return;
    const data = state.data;
    if (settingsTarget.brand) {
      const brandId = resolveBrandId(settingsTarget.brand);
      if (brandId) openRow(brandId, settingsTarget.mode);
      else if (data.settings.providers.some((p) => p.id === settingsTarget.brand)) openRow(settingsTarget.brand);
    } else if (settingsTarget.mode === "subscription") {
      const first = BRANDS.find((b) => !brandState(b, data).subReady) ?? BRANDS[0]!;
      openRow(first.id, "subscription");
    }
    clearSettingsTarget();
  }, [settingsTarget, state.data, clearSettingsTarget]);

  const toggleFallback = async (data: ModelsData, checked: boolean) => {
    state.setData({ ...data, settings: { ...data.settings, autoFallback: checked } });
    setFallbackBusy(true);
    try {
      await setAutoFallback(checked);
    } catch (e) {
      state.setData(data);
      toast.error(C.fallback.failed, cleanMessage(e));
    } finally {
      setFallbackBusy(false);
    }
  };

  return (
    <Loader state={state} errorTitle={C.errors.load} skeleton={<SkeletonCard rows={6} className="rounded-card" />}>
      {(data) => {
        const { settings, clis } = data;
        const brandReady = BRANDS.some((b) => {
          const s = brandState(b, data);
          return s.subReady || s.apiReady;
        });
        const otherReady = settings.providers.some((p) => !BRAND_PROVIDERS.has(p.id) && isAdded(p) && !providerNeed(p, settings));
        const nothingReady = !settings.providerReady && !brandReady && !otherReady;

        const others = settings.providers.filter((p) => !BRAND_PROVIDERS.has(p.id));
        const cloud = others.filter((p) => !p.local && p.id !== "custom");
        const local = others.filter((p) => p.local);
        const custom = others.filter((p) => p.id === "custom");
        const unsupported = clis.filter((c) => (!c.supported || !(CLI_IDS as readonly string[]).includes(c.id)) && c.installed);
        const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
        const ref = (id: string) => (el: HTMLDivElement | null) => {
          rows.current[id] = el;
        };
        const serviceRows = (list: ProviderInfo[]) =>
          list.map((p) => <ServiceRow key={p.id} p={p} settings={settings} open={open === p.id} onToggle={() => toggle(p.id)} onChanged={() => reload(false)} rowRef={ref(p.id)} />);

        return (
          <>
            {nothingReady ? <QuickStart onSubscription={() => openRow("claude", "subscription")} onApiKey={() => openRow("google", "api")} onLocal={() => openRow("ollama")} /> : null}

            <SettingsGroup label={C.sections.popular.label} note={C.sections.popular.note || undefined} data-testid="models-brands">
              {BRANDS.map((brand) => {
                const s = brandState(brand, data);
                const mode = brandModes[brand.id] ?? (s.apiReady && !s.subReady ? "api" : s.subReady && !s.apiReady ? "subscription" : brand.defaultMode);
                return (
                  <BrandRow
                    key={brand.id}
                    brand={brand}
                    data={data}
                    open={open === brand.id}
                    mode={mode}
                    onToggle={() => toggle(brand.id)}
                    onSelectMode={(m) => setBrandModes((prev) => ({ ...prev, [brand.id]: m }))}
                    onProviderChanged={() => reload(false)}
                    onAgentChanged={() => reload(true)}
                    onRecheck={() => void recheck()}
                    rechecking={rechecking}
                    rowRef={ref(brand.id)}
                  />
                );
              })}
            </SettingsGroup>

            {cloud.length ? (
              <SettingsGroup label={C.sections.cloud.label} note={C.sections.cloud.note || undefined} data-testid="models-cloud">
                {serviceRows(cloud)}
              </SettingsGroup>
            ) : null}

            {local.length || unsupported.length ? (
              <SettingsGroup label={C.sections.local.label} note={C.sections.local.note || undefined} data-testid="models-local">
                {serviceRows(local)}
                {unsupported.map((c) => (
                  <div key={c.id} className="flex h-10 items-center gap-3 px-3 text-muted-foreground">
                    <ProviderIcon id={c.id} className="size-4 shrink-0 opacity-60" />
                    <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                    <span className="shrink-0 text-subtle-foreground text-xs">{C.status.notSupported}</span>
                  </div>
                ))}
              </SettingsGroup>
            ) : null}

            {custom.length ? (
              <SettingsGroup label={C.sections.custom.label} note={C.sections.custom.note || undefined} data-testid="models-custom">
                {serviceRows(custom)}
              </SettingsGroup>
            ) : null}

            <SettingsGroup label={C.sections.reliability.label} note={C.sections.reliability.note || undefined}>
              <SwitchRow
                label={C.fallback.label}
                description={C.fallback.description}
                checked={settings.autoFallback ?? true}
                pending={fallbackBusy}
                onCheckedChange={(checked) => void toggleFallback(data, checked)}
              />
            </SettingsGroup>
          </>
        );
      }}
    </Loader>
  );
}
