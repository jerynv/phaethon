import { CheckIcon, KeyRoundIcon, SquareTerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { HUES } from "@/app/NewSpaceDialog";
import { useNav } from "@/app/store";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cancelInstanceSignIn, CLI_IDS, type CliStatus, cliStatuses, listInstances, signInInstance } from "@/features/settings/agents/api";
import { currentInstance } from "@/features/settings/agents/logic";
import { type Backend, checkApiKey, getSettings, type ProviderId, type ProviderInfo, setApiKey, setBackend, setProvider, type Settings } from "@/features/settings/providers/api";
import { canSaveUnchecked, checkAndSave, isSaved, type KeyOutcome, outcomeText } from "@/features/settings/providers/logic";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";

/** Progress through first-run setup, kept so a reload or a stray Esc loses nothing. Never holds a key. */
type Draft = { step: number; method: "key" | "agent" | null; provider: ProviderId; name: string; edu: boolean };
const DRAFT = "phaethon.onboarding";
const START: Draft = { step: 0, method: null, provider: "anthropic", name: "", edu: true };

function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) ?? "null") as Partial<Draft> | null;
    return d ? { ...START, ...d, step: Math.min(Math.max(Number(d.step) || 0, 0), 2) } : START;
  } catch {
    return START;
  }
}

/** First run: what Phaethon is, how it answers, and a first space. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [draft, setDraft] = useState<Draft>(readDraft);
  const patch = (p: Partial<Draft>) =>
    setDraft((d) => {
      const n = { ...d, ...p };
      try {
        localStorage.setItem(DRAFT, JSON.stringify(n));
      } catch {
        // Progress lasts for this session only.
      }
      return n;
    });
  const finish = () => {
    try {
      localStorage.removeItem(DRAFT);
    } catch {
      // ignore
    }
    onDone();
  };

  // Esc never leaves setup or clears anything; it only steps out of a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector("[data-slot=select-popup],[role=listbox]")) return;
      (document.activeElement as HTMLElement | null)?.blur?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="flex h-full flex-col bg-background">
      <div className="app-drag h-(--titlebar-height) shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-sm flex-col px-4 pt-[8vh] pb-10">
          <Dots step={draft.step} />
          {draft.step === 0 ? <Welcome onNext={() => patch({ step: 1 })} /> : null}
          {draft.step === 1 ? <Answers draft={draft} patch={patch} onBack={() => patch({ step: 0 })} onNext={() => patch({ step: 2 })} /> : null}
          {draft.step === 2 ? <FirstSpace draft={draft} patch={patch} onBack={() => patch({ step: 1 })} onDone={finish} /> : null}
        </div>
      </div>
    </main>
  );
}

function Dots({ step }: { step: number }) {
  return (
    <div className="mb-8 flex items-center gap-1.5" aria-label={`Step ${step + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn("h-1.5 rounded-full transition-all duration-300", i === step ? "w-5 bg-primary" : i < step ? "w-1.5 bg-primary/50" : "w-1.5 bg-input")} />
      ))}
    </div>
  );
}

function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="mt-8 flex items-center gap-2">
      {onBack ? (
        <Button variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <span className="flex-1" />
      {children}
    </div>
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <section>
      <h1 className="font-semibold text-2xl tracking-[-0.02em]">Welcome to Phaethon</h1>
      <p className="mt-2 text-base text-muted-foreground">An assistant that keeps each part of your life in its own space, with its own files, conversations and memory.</p>
      <Footer>
        <Button size="sm" autoFocus onClick={onNext}>
          Get started
        </Button>
      </Footer>
    </section>
  );
}

// ---- How it answers ----

const KEY_PROVIDERS: ProviderId[] = ["anthropic", "openai", "openrouter", "groq", "together", "mistral", "deepseek", "xai"];

function Answers({ draft, patch, onBack, onNext }: { draft: Draft; patch: (p: Partial<Draft>) => void; onBack: () => void; onNext: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);

  const load = () => {
    setSettingsError(null);
    getSettings().then(
      (s) => {
        setSettings(s);
        if (s.backend !== "phaethon") setReady(s.backend);
        else if (s.providerReady) setReady(s.provider);
      },
      (e) => setSettingsError(cleanMessage(e)),
    );
  };
  useEffect(load, []);

  const readyName = ready ? (ready.endsWith("-cli") ? { "claude-cli": "Claude Code", "codex-cli": "Codex", "gemini-cli": "Gemini CLI" }[ready] : settings?.providers.find((p) => p.id === ready)?.name) : null;

  return (
    <section>
      <h1 className="font-semibold text-xl tracking-[-0.015em]">How should Phaethon answer?</h1>
      <p className="mt-1.5 text-muted-foreground text-sm">Use a key from a model provider, or a coding agent you already have. You can change this in Settings.</p>
      {readyName ? (
        <p className="mt-4 flex items-center gap-1.5 text-sm text-success-foreground">
          <CheckIcon className="size-3.5" strokeWidth={2.5} />
          <Truncate>Answers with {readyName}</Truncate>
        </p>
      ) : null}
      <div className="mt-5 flex flex-col gap-2">
        <Choice icon={<KeyRoundIcon strokeWidth={1.75} />} title="An API key" text="Anthropic, OpenAI, OpenRouter and others" on={draft.method === "key"} onClick={() => patch({ method: draft.method === "key" ? null : "key" })}>
          {settingsError ? (
            <RowError message="Couldn’t read your settings." onRetry={load} />
          ) : settings ? (
            <KeyForm settings={settings} provider={draft.provider} onProvider={(provider) => patch({ provider })} onSaved={setReady} />
          ) : (
            <SkeletonRows count={2} />
          )}
        </Choice>
        <Choice icon={<SquareTerminalIcon strokeWidth={1.75} />} title="A coding agent" text="Claude Code, Codex or Gemini CLI" on={draft.method === "agent"} onClick={() => patch({ method: draft.method === "agent" ? null : "agent" })}>
          <AgentList chosen={ready} onUse={setReady} />
        </Choice>
      </div>
      <Footer onBack={onBack}>
        <Button size="sm" variant={ready ? "default" : "ghost"} onClick={onNext}>
          {ready ? "Continue" : "Skip for now"}
        </Button>
      </Footer>
    </section>
  );
}

function Choice({ icon, title, text, on, onClick, children }: { icon: ReactNode; title: string; text: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className={cn("rounded-xl border bg-card transition-colors", on && "border-primary/40")}>
      <button type="button" aria-expanded={on} onClick={onClick} className="flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">{title}</span>
          <span className="block truncate text-muted-foreground text-xs">{text}</span>
        </span>
        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", on ? "border-primary bg-primary" : "border-input")}>
          {on ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
        </span>
      </button>
      {on ? <div className="border-t px-3.5 pt-3 pb-3.5">{children}</div> : null}
    </div>
  );
}

function KeyForm({ settings, provider, onProvider, onSaved }: { settings: Settings; provider: ProviderId; onProvider: (p: ProviderId) => void; onSaved: (p: string) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);
  const providers = KEY_PROVIDERS.map((id) => settings.providers.find((p) => p.id === id)).filter((p): p is ProviderInfo => !!p);
  const info = providers.find((p) => p.id === provider) ?? providers[0];
  if (!info) return <p className="text-muted-foreground text-xs">No providers are available.</p>;
  const hadKey = info.hasKey && !outcome;

  const run = async (skipCheck = false) => {
    setBusy(true);
    const o = await checkAndSave(key, info.id, { check: checkApiKey, save: setApiKey }, skipCheck);
    if (isSaved(o)) {
      setKey("");
      try {
        await setBackend("phaethon");
        await setProvider(info.id);
      } catch {
        // The key is saved; the provider can still be picked in Settings.
      }
      onSaved(info.id);
    }
    setOutcome(o);
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>Provider</Label>
        <Select value={info.id} onValueChange={(v) => (onProvider(v as ProviderId), setOutcome(null))}>
          <SelectTrigger>
            <SelectValue>
              {() => (
                <span className="flex min-w-0 items-center gap-2">
                  <ProviderIcon id={info.id} />
                  <span className="truncate">{info.name}</span>
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <ProviderIcon id={p.id} />
                  {p.name}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="ob-key">Key</Label>
          {info.keysUrl ? (
            <a href={info.keysUrl} target="_blank" rel="noreferrer noopener" className="text-primary text-xs hover:underline">
              Get a key
            </a>
          ) : null}
        </div>
        <div className="flex gap-1.5">
          <Input
            id="ob-key"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={hadKey ? "Saved. Paste a new one to replace it" : info.keyPrefix ? `${info.keyPrefix}…` : "Paste your key"}
            aria-invalid={outcome?.kind === "problem" ? true : undefined}
            onChange={(e) => (setKey(e.target.value), setOutcome(null))}
            onKeyDown={(e) => e.key === "Enter" && !busy && void run()}
          />
          <Button size="sm" variant="outline" className="h-8.5 min-w-26 sm:h-7.5" disabled={busy} onClick={() => void run()}>
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Checking…" : "Check and save"}
          </Button>
        </div>
        {outcome?.kind === "problem" ? (
          <FieldError>
            {outcomeText(outcome, info)}
            {canSaveUnchecked(outcome) ? (
              <>
                {" "}
                <button type="button" className="font-medium underline underline-offset-2" onClick={() => void run(true)}>
                  Save without checking
                </button>
              </>
            ) : null}
          </FieldError>
        ) : outcome ? (
          <p className={cn("flex items-start gap-1.5 text-xs", outcome.kind === "no-credit" ? "text-warning-foreground" : "text-success-foreground")}>
            <CheckIcon className="mt-0.5 size-3 shrink-0" strokeWidth={2.5} />
            {outcomeText(outcome, info)}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function AgentList({ chosen, onUse }: { chosen: string | null; onUse: (backend: string) => void }) {
  const [clis, setClis] = useState<CliStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<{ cli: string; instance: string } | null>(null);
  const [rowError, setRowError] = useState<{ cli: string; text: string } | null>(null);
  const showSkeleton = useDelayed(!clis && !error);

  const load = () => {
    setError(null);
    cliStatuses().then(
      (c) => setClis(c.filter((x) => (CLI_IDS as readonly string[]).includes(x.id) && x.supported)),
      (e) => setError(cleanMessage(e)),
    );
  };
  useEffect(load, []);

  const use = async (c: CliStatus) => {
    const backend = `${c.id}-cli` as Backend;
    setBusy(c.id);
    setRowError(null);
    try {
      await setBackend(backend);
      onUse(backend);
    } catch (e) {
      setRowError({ cli: c.id, text: cleanMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const signIn = async (c: CliStatus) => {
    setRowError(null);
    try {
      const inst = currentInstance(await listInstances(), c.id);
      if (!inst) throw new Error(`Phaethon couldn’t find ${c.name}.`);
      setSigningIn({ cli: c.id, instance: inst.config.id });
      const r = await signInInstance(inst.config.id);
      setSigningIn(null);
      if (r.status === "signedIn") {
        setClis((list) => list?.map((x) => (x.id === c.id ? { ...x, loggedIn: true } : x)) ?? null);
        await use({ ...c, loggedIn: true });
      } else if (r.status !== "cancelled") {
        setRowError({ cli: c.id, text: r.message });
      }
    } catch (e) {
      setSigningIn(null);
      setRowError({ cli: c.id, text: cleanMessage(e) });
    }
  };

  if (error) return <RowError message="Couldn’t check for coding agents." onRetry={load} />;
  if (!clis) return showSkeleton ? <SkeletonRows count={3} withIcon /> : <div className="h-24" />;
  if (!clis.some((c) => c.installed)) return <p className="text-muted-foreground text-xs">None is installed on this computer. Settings › Coding agents shows how to install one.</p>;

  return (
    <div className="-mx-1 flex flex-col gap-0.5">
      {clis.map((c) => {
        const on = chosen === `${c.id}-cli`;
        const waiting = signingIn?.cli === c.id;
        return (
          <div key={c.id}>
            <div className="flex h-9 items-center gap-2.5 rounded-md px-1">
              <ProviderIcon id={c.id} />
              <span className={cn("min-w-0 flex-1 truncate text-sm", !c.installed && "text-muted-foreground")}>{c.name}</span>
              {!c.installed ? (
                <span className="text-muted-foreground text-xs">Not installed</span>
              ) : on ? (
                <span className="flex items-center gap-1 text-success-foreground text-xs">
                  <CheckIcon className="size-3" strokeWidth={2.5} />
                  In use
                </span>
              ) : waiting ? (
                <>
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    <Spinner size="xs" />
                    Signing in…
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void cancelInstanceSignIn(signingIn.instance)}>
                    Cancel
                  </Button>
                </>
              ) : c.loggedIn === false ? (
                <Button size="xs" variant="outline" disabled={!!signingIn} onClick={() => void signIn(c)}>
                  Sign in
                </Button>
              ) : (
                <Button size="xs" variant="outline" disabled={busy === c.id} onClick={() => void use(c)} className="min-w-12">
                  {busy === c.id ? <Spinner size="xs" /> : "Use"}
                </Button>
              )}
            </div>
            {rowError?.cli === c.id ? <FieldError className="px-1 pb-1.5 pl-7.5">{rowError.text}</FieldError> : null}
          </div>
        );
      })}
    </div>
  );
}

// ---- First space ----

function FirstSpace({ draft, patch, onBack, onDone }: { draft: Draft; patch: (p: Partial<Draft>) => void; onBack: () => void; onDone: () => void }) {
  const [spaces, setSpaces] = useState<SpaceView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showSkeleton = useDelayed(!spaces && !loadError);
  const hue = HUES[0]!;

  const load = () => {
    setLoadError(null);
    api.spaces().then(setSpaces, (e) => setLoadError(cleanMessage(e)));
  };
  useEffect(load, []);

  const create = async () => {
    const name = draft.name.trim();
    if (!name) return setError("Give the space a name.");
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSpace({ name, hue, educationEnabled: draft.edu });
      await useNav.getState().loadSpaces();
      useNav.getState().selectSpace(s.id, "chat");
      onDone();
    } catch (e) {
      setError(cleanMessage(e));
      setBusy(false);
    }
  };

  const existing = spaces && spaces.length > 0 && !making;

  return (
    <section>
      <h1 className="font-semibold text-xl tracking-[-0.015em]">{existing ? "Your spaces" : "Make your first space"}</h1>
      <p className="mt-1.5 text-muted-foreground text-sm">
        {existing ? "This Phaethon folder already has spaces. Pick up where you left off, or add another." : "A space holds one part of your life, like school or work. You can add more later."}
      </p>
      {loadError ? (
        <RowError className="mt-5" message="Couldn’t read your spaces." onRetry={load} />
      ) : !spaces ? (
        showSkeleton ? <SkeletonRows count={2} withIcon className="mt-5" /> : <div className="mt-5 h-15" />
      ) : existing ? (
        <div className="mt-5 flex max-h-52 flex-col gap-0.5 overflow-y-auto rounded-xl border p-1">
          {spaces.map((s) => (
            <div key={s.id} className="flex h-8 items-center gap-2.5 px-2">
              <SpaceAvatar name={s.name} hue={s.hue} />
              <Truncate className="min-w-0 flex-1 text-sm">{s.name}</Truncate>
              {s.educationEnabled ? <span className="shrink-0 text-muted-foreground text-xs">Study tools</span> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ob-space">Name</Label>
            <div className="flex items-center gap-2">
              <SpaceAvatar name={draft.name || "S"} hue={hue} className="size-7 rounded-md text-xs" />
              <Input
                id="ob-space"
                autoFocus
                value={draft.name}
                maxLength={60}
                placeholder="School, Work, Thesis…"
                aria-invalid={error ? true : undefined}
                onChange={(e) => (patch({ name: e.target.value }), setError(null))}
                onKeyDown={(e) => e.key === "Enter" && !busy && void create()}
              />
            </div>
            <FieldError>{error}</FieldError>
          </div>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3.5 py-3">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-sm">Study tools</span>
              <span className="text-muted-foreground text-xs">Courses, flashcards, quizzes, grades and a study plan.</span>
            </span>
            <Switch checked={draft.edu} onCheckedChange={(edu) => patch({ edu })} />
          </label>
        </div>
      )}
      <Footer onBack={making && spaces?.length ? () => setMaking(false) : onBack}>
        {existing ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setMaking(true)}>
              New space
            </Button>
            <Button size="sm" autoFocus onClick={onDone}>
              Continue
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={() => void create()} disabled={busy || !spaces} className="min-w-28">
            {busy ? <Spinner size="sm" /> : null}
            {busy ? "Creating…" : "Create space"}
          </Button>
        )}
      </Footer>
    </section>
  );
}
