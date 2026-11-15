import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { type ReactNode, useEffect, useState } from "react";
import { api, type SpaceView } from "@/app/api";
import { HUES } from "@/app/NewSpaceDialog";
import { useNav } from "@/app/store";
import { ArtCanvas, type ArtPalette } from "@/components/art";
import { cleanMessage, FieldError, RowError } from "@/components/errors";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonRows } from "@/components/skeletons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleRow } from "@/components/ui/toggle-row";
import { cancelInstanceSignIn, CLI_IDS, type CliStatus, cliStatuses, listInstances, signInInstance } from "@/features/settings/agents/api";
import { currentInstance } from "@/features/settings/agents/logic";
import { type Backend, checkApiKey, getSettings, type ProviderId, type ProviderInfo, setApiKey, setBackend, setProvider, type Settings } from "@/features/settings/providers/api";
import { canSaveUnchecked, checkAndSave, isSaved, type KeyOutcome, outcomeText } from "@/features/settings/providers/logic";
import { useDelayed } from "@/hooks/use-delayed";
import { cn } from "@/lib/utils";
import { StepPreview } from "./Preview";

/**
 * Progress through first-run setup, kept so a reload or a stray Esc loses
 * nothing. Never holds a key. `answer` is the name of what answers (for the
 * summary), `spaces` the spaces the last step left in place.
 */
export type Draft = {
  step: number;
  method: "key" | "agent" | null;
  provider: ProviderId;
  name: string;
  edu: boolean;
  answer: string | null;
  spaces: string[];
};
const DRAFT = "phaethon.onboarding";
const START: Draft = { step: 0, method: null, provider: "anthropic", name: "", edu: true, answer: null, spaces: [] };
const LAST = 3;

function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT) ?? "null") as Partial<Draft> | null;
    return d ? { ...START, ...d, spaces: Array.isArray(d.spaces) ? d.spaces.filter((x) => typeof x === "string") : [], step: Math.min(Math.max(Number(d.step) || 0, 0), LAST) } : START;
  } catch {
    return START;
  }
}

/** Each step's art (docs/UI-REBUILD.md › Art: onboarding cycles sky → dawn → meadow). */
const PALETTES: ArtPalette[] = ["sky", "dawn", "meadow", "sky"];

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

  const reduce = useReducedMotion();
  const step = Math.min(draft.step, LAST);
  return (
    <main className="@container/onboarding relative flex h-full bg-background">
      <div aria-hidden className="app-drag absolute inset-x-0 top-0 h-(--titlebar-height)" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-24 shrink-0 items-end justify-center pb-2">
          <span className="font-medium text-base tracking-title">Phaethon</span>
        </div>
        <div className="page-scroll min-h-0 flex-1">
          <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-start px-6 pt-(--onboarding-top) pb-16">
            <Dots step={step} />
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? undefined : { opacity: 0, y: -4 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
              >
                {step === 0 ? <Welcome onNext={() => patch({ step: 1 })} /> : null}
                {step === 1 ? <Answers draft={draft} patch={patch} onBack={() => patch({ step: 0 })} onNext={() => patch({ step: 2 })} /> : null}
                {step === 2 ? <FirstSpace draft={draft} patch={patch} onBack={() => patch({ step: 1 })} onDone={(spaces) => patch({ step: 3, spaces })} /> : null}
                {step === 3 ? <AllSet draft={draft} onBack={() => patch({ step: 2 })} onDone={finish} /> : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
      <aside aria-hidden className="hidden w-1/2 shrink-0 border-l @4xl/onboarding:block">
        <div className="relative size-full overflow-hidden">
          <AnimatePresence initial={false}>
            <motion.div key={step} className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
              <ArtCanvas palette={PALETTES[step]} seed={`onboarding-${step}`} animate className="size-full">
                <StepPreview step={step} draft={draft} />
              </ArtCanvas>
            </motion.div>
          </AnimatePresence>
        </div>
      </aside>
    </main>
  );
}

function Dots({ step }: { step: number }) {
  return (
    <div className="mb-8 flex items-center gap-1.5" role="img" aria-label={`Step ${step + 1} of ${LAST + 1}`}>
      {Array.from({ length: LAST + 1 }, (_, i) => (
        <motion.span
          key={i}
          layout
          transition={{ type: "spring", stiffness: 480, damping: 38 }}
          className={cn("h-1.5 rounded-full", i === step ? "w-6 bg-primary" : i < step ? "w-1.5 bg-primary/40" : "w-1.5 bg-input")}
        />
      ))}
    </div>
  );
}

function Title({ children, sub }: { children: ReactNode; sub: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <h1 className="font-medium text-2xl tracking-heading">{children}</h1>
      <p className="text-muted-foreground text-sm">{sub}</p>
    </div>
  );
}

/** Back on the left, the step's one action filling the rest. */
function Footer({ onBack, children }: { onBack?: () => void; children: ReactNode }) {
  return (
    <div className="mt-8 flex items-center gap-2">
      {onBack ? (
        <Button variant="outline" onClick={onBack} aria-label="Back" size="icon" shape="pill" className="shrink-0">
          <Icon icon={icons.arrowLeft} />
        </Button>
      ) : null}
      <div className="flex flex-1 gap-2 [&>*]:flex-1">{children}</div>
    </div>
  );
}

const FEATURES: { icon: IconData; title: string; text: string }[] = [
  { icon: icons.deck, title: "A space for each part of life", text: "School, work and the rest, kept apart" },
  { icon: icons.courses, title: "Study tools", text: "Courses, flashcards, quizzes and a plan" },
  { icon: icons.folder, title: "Plain files you own", text: "Everything lives in a folder on this computer" },
];

function Welcome({ onNext }: { onNext: () => void }) {
  return (
    <section>
      <Title sub="An assistant that keeps each part of your life in its own space.">Welcome to Phaethon</Title>
      <ul className="divide-y overflow-hidden rounded-card border bg-card">
        {FEATURES.map((f) => (
          <li key={f.title} className="flex items-center gap-4 px-4 py-3.5">
            <Icon icon={f.icon} className="size-5 text-muted-foreground" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium text-sm">{f.title}</span>
              <span className="text-muted-foreground text-sm">{f.text}</span>
            </span>
          </li>
        ))}
      </ul>
      <Footer>
        <Button ref={quietFocus} onClick={onNext}>
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
  useEffect(() => {
    if ((readyName ?? null) !== draft.answer) patch({ answer: readyName ?? null });
  }, [readyName]);

  return (
    <section>
      <Title sub="Use a key from a model provider, or a coding agent you already have. You can change this in Settings.">How should Phaethon answer?</Title>
      <AnimatePresence initial={false}>
        {readyName ? (
          <motion.p
            role="status"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="-mt-2 mb-4 flex items-center gap-2 overflow-hidden text-sm text-success-foreground"
          >
            <Icon icon={icons.done} className="size-4" />
            <Truncate>Answers with {readyName}</Truncate>
          </motion.p>
        ) : null}
      </AnimatePresence>
      <div className="flex flex-col gap-3">
        <Choice icon={<Icon icon={icons.key} />} title="An API key" text="Anthropic, OpenAI, OpenRouter and others" on={draft.method === "key"} onClick={() => patch({ method: draft.method === "key" ? null : "key" })}>
          {settingsError ? (
            <RowError message="Couldn’t read your settings." onRetry={load} />
          ) : settings ? (
            <KeyForm settings={settings} provider={draft.provider} onProvider={(provider) => patch({ provider })} onSaved={setReady} />
          ) : (
            <SkeletonRows count={2} />
          )}
        </Choice>
        <Choice icon={<Icon icon={icons.terminal} />} title="A coding agent" text="Claude Code, Codex or Gemini CLI" on={draft.method === "agent"} onClick={() => patch({ method: draft.method === "agent" ? null : "agent" })}>
          <AgentList chosen={ready} onUse={setReady} />
        </Choice>
      </div>
      <Footer onBack={onBack}>
        <Button variant={ready ? "default" : "outline"} onClick={onNext}>
          {ready ? "Continue" : "Skip for now"}
        </Button>
      </Footer>
    </section>
  );
}

/**
 * Puts focus on a step's main button when it appears, so Enter presses it,
 * without the keyboard focus ring (e3e4 and c06d show none on load). Tab
 * still shows the ring as usual.
 */
function quietFocus(el: HTMLButtonElement | null) {
  el?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
}

function Choice({ icon, title, text, on, onClick, children }: { icon: ReactNode; title: string; text: string; on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-card border bg-card transition-[border-color,box-shadow] duration-150", on ? "border-primary ring-1 ring-primary" : "hover:border-border-strong")}>
      <button type="button" aria-expanded={on} onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3.5 text-left outline-none focus-visible:bg-accent">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground [&_svg]:size-4.5">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">{title}</span>
          <span className="block text-muted-foreground text-sm">{text}</span>
        </span>
        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors", on ? "border-primary bg-primary" : "border-input")}>
          {on ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {on ? (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="overflow-hidden">
            <div className="border-t bg-well px-4 pt-3.5 pb-4">{children}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
            <a href={info.keysUrl} target="_blank" rel="noreferrer noopener" className="text-primary text-sm hover:underline">
              Get a key
            </a>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">
          <Input
            id="ob-key"
            type="password"
            value={key}
            autoComplete="off"
            spellCheck={false}
            placeholder={hadKey ? "Saved · paste to replace" : info.keyPrefix ? `${info.keyPrefix}…` : "Paste your key"}
            aria-invalid={outcome?.kind === "problem" ? true : undefined}
            onChange={(e) => (setKey(e.target.value), setOutcome(null))}
            onKeyDown={(e) => e.key === "Enter" && !busy && void run()}
          />
          <Button variant="outline" pending={busy} onClick={() => void run()}>
            Check and save
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
          <p role="status" className={cn("flex items-start gap-1.5 text-xs", outcome.kind === "no-credit" ? "text-warning-foreground" : "text-success-foreground")}>
            <Icon icon={icons.check} className="mt-0.5 size-3" />
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
                  <Icon icon={icons.check} className="size-3" />
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
                <Button size="xs" variant="outline" pending={busy === c.id} onClick={() => void use(c)}>
                  Use
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

function FirstSpace({ draft, patch, onBack, onDone }: { draft: Draft; patch: (p: Partial<Draft>) => void; onBack: () => void; onDone: (spaces: string[]) => void }) {
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
      onDone([s.name]);
    } catch (e) {
      setError(cleanMessage(e));
      setBusy(false);
    }
  };

  const existing = spaces && spaces.length > 0 && !making;

  return (
    <section>
      <Title
        sub={existing ? "This Phaethon folder already has spaces. Pick up where you left off, or add another." : "A space holds one part of your life, like school or work. You can add more later."}
      >
        {existing ? "Your spaces" : "Make your first space"}
      </Title>
      {loadError ? (
        <RowError message="Couldn’t read your spaces." onRetry={load} />
      ) : !spaces ? (
        showSkeleton ? <SkeletonRows count={2} withIcon /> : <div className="h-15" />
      ) : existing ? (
        <div className="flex max-h-60 flex-col overflow-y-auto rounded-card border bg-card p-1.5">
          {spaces.map((s) => (
            <div key={s.id} className="flex h-10 items-center gap-3 rounded-lg px-2.5">
              <SpaceAvatar name={s.name} hue={s.hue} className="size-6 rounded-md text-2xs" />
              <Truncate className="min-w-0 flex-1 text-sm">{s.name}</Truncate>
              {s.educationEnabled ? <span className="shrink-0 rounded-sm bg-primary/8 px-1.5 text-primary text-xs leading-5">Study tools</span> : null}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setMaking(true)}
            className="flex h-10 items-center gap-3 rounded-lg px-2.5 text-primary text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
          >
            <Icon icon={icons.add} className="size-4" />
            New space
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ob-space">Name</Label>
            <div className="flex items-center gap-2">
              <SpaceAvatar name={draft.name || "S"} hue={hue} className="size-8 rounded-lg text-xs" />
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
          <div className="rounded-card border bg-card px-4">
            <ToggleRow title="Study tools" description="Courses, flashcards, quizzes, grades and a study plan." checked={draft.edu} onCheckedChange={(edu) => patch({ edu })} />
          </div>
        </div>
      )}
      <Footer onBack={making && spaces?.length ? () => setMaking(false) : onBack}>
        {existing ? (
          <Button ref={quietFocus} onClick={() => onDone(spaces.map((s) => s.name))}>
            Continue
          </Button>
        ) : (
          <Button onClick={() => void create()} disabled={!spaces} pending={busy}>
            Create space
          </Button>
        )}
      </Footer>
    </section>
  );
}

// ---- Done ----

/** "You're all set" (c06d): what was set up, with blue tick discs, then into the app. */
function AllSet({ draft, onBack, onDone }: { draft: Draft; onBack: () => void; onDone: () => void }) {
  const openSettings = () => {
    onDone();
    useNav.getState().openSettings("providers");
  };
  const names = draft.spaces;
  const items: { done: boolean; text: string }[] = [
    draft.answer ? { done: true, text: `Answers with ${draft.answer}` } : { done: false, text: "No model yet. Add one in Settings when you’re ready." },
    names.length === 1
      ? { done: true, text: `${names[0]} is ready${draft.edu && draft.name.trim() === names[0] ? ", with study tools" : ""}` }
      : names.length > 1
        ? { done: true, text: `${names.length} spaces ready: ${names.slice(0, 3).join(", ")}${names.length > 3 ? "…" : ""}` }
        : { done: true, text: "Your spaces are ready" },
    { done: true, text: "Files stay in your Phaethon folder" },
  ];
  return (
    <section>
      <Title sub="Here’s what you just set up.">You’re all set</Title>
      <ul className="flex flex-col gap-3.5 rounded-xl border bg-well px-4 py-4">
        {items.map((it, i) => (
          <motion.li
            key={it.text}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 * i, duration: 0.18 }}
            className="flex items-start gap-3 text-sm"
          >
            {it.done ? (
              <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Icon icon={icons.check} className="size-3" />
              </span>
            ) : (
              <Icon icon={icons.pending} className="mt-0.5 size-4 text-subtle-foreground" />
            )}
            <span className={cn("min-w-0", !it.done && "text-muted-foreground")}>{it.text}</span>
          </motion.li>
        ))}
      </ul>
      <Footer onBack={onBack}>
        <Button ref={quietFocus} onClick={onDone}>
          Explore
        </Button>
        {draft.answer ? null : (
          <Button variant="outline" onClick={openSettings}>
            Open settings
          </Button>
        )}
      </Footer>
    </section>
  );
}
