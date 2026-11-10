/**
 * Who answers in every space: Phaethon's own agent (with an API provider) or
 * one of the coding-agent CLIs. One radio group; each choice says whether it
 * can answer now, and what's missing when it can't.
 */
import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup } from "@base-ui/react/radio-group";
import { SparklesIcon } from "lucide-react";
import { useId, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorText } from "@/lib/core";
import { cn } from "@/lib/utils";

import { CLI_IDS, CLI_INFO, type CliId } from "../agents/api";
import { currentInstance, instanceStatus, useAgents } from "../agents/store";
import { setBackend, type Backend, type Settings } from "./api";
import { modelLabel, providerModel, providerNeed, splitRef } from "./logic";
import { ProviderLogo } from "./ProviderLogo";
import { useAssistant } from "./store";
import { Dot, FieldMessage } from "./ui";

type Choice = {
  value: Backend;
  name: string;
  logo: React.ReactNode;
  status: string;
  tone: "ready" | "warning" | "neutral" | "error";
  /** Can't be chosen now (not installed). */
  blocked: boolean;
  /** Where to fix what's missing. */
  fix?: { label: string; run: () => void };
};

export function BackendChoice({ settings, onSaid, onFixProvider }: { settings: Settings; onSaid: (t: string) => void; onFixProvider: () => void }) {
  const load = useAssistant((s) => s.load);
  const models = useAssistant((s) => s.models);
  const agents = useAgents();
  const openSettings = useNav((s) => s.openSettings);
  const [pending, setPending] = useState<Backend | null>(null);
  const [error, setError] = useState("");
  const labelId = useId();
  const errorId = useId();

  const provider = settings.providers.find((p) => p.id === settings.provider);
  const need = provider ? providerNeed(provider, settings) : { field: "key" as const, text: "Add a provider." };
  const model = provider ? providerModel(provider, settings) : null;
  const ownChoice: Choice = {
    value: "phaethon",
    name: "Phaethon’s agent",
    logo: (
      <span className="flex size-5 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <SparklesIcon aria-hidden className="size-3.5" />
      </span>
    ),
    status: need
      ? need.text
      : `${provider?.name ?? ""} · ${model ? modelLabel(splitRef(model).model, models[settings.provider]?.models) : ""}`,
    tone: need ? "warning" : "ready",
    blocked: false,
    fix: need ? { label: "Set up", run: onFixProvider } : undefined,
  };

  const cliChoices: Choice[] = CLI_IDS.map((cli: CliId) => {
    const status = agents.clis.find((c) => c.id === cli);
    const instance = currentInstance(agents.instances, cli);
    const loading = agents.status === "loading";
    const installed = status?.installed ?? instance?.installed ?? false;
    const s = instance ? instanceStatus(instance) : { text: installed ? "Installed" : "Not installed", tone: "neutral" as const };
    const signedOut = installed && (instance?.loggedIn ?? status?.loggedIn) === false;
    return {
      value: `${cli}-cli` as Backend,
      name: CLI_INFO[cli].name,
      logo: <ProviderLogo id={`${cli}-cli`} />,
      status: loading ? "Checking…" : s.text,
      tone: loading ? "neutral" : s.tone,
      blocked: !loading && !installed,
      fix: !loading && (!installed || signedOut) ? { label: installed ? "Sign in" : "Set up", run: () => openSettings("agents") } : undefined,
    };
  });

  async function choose(next: Backend) {
    if (next === settings.backend || pending) return;
    setPending(next);
    setError("");
    try {
      await setBackend(next);
      await Promise.all([load(), agents.load()]);
      const name = next === "phaethon" ? "Phaethon’s agent" : CLI_INFO[next.slice(0, -4) as CliId].name;
      onSaid(`${name} answers in every space now.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <span id={labelId} className="sr-only">
        Who answers
      </span>
      <RadioGroup
        aria-labelledby={labelId}
        aria-describedby={error ? errorId : undefined}
        value={settings.backend}
        onValueChange={(v) => void choose(v as Backend)}
        className="grid gap-2 sm:grid-cols-2"
      >
        {[ownChoice, ...cliChoices].map((c) => (
          <ChoiceCard key={c.value} choice={c} checked={settings.backend === c.value} pending={pending === c.value} />
        ))}
      </RadioGroup>
      {error ? (
        <FieldMessage id={errorId} tone="error">
          {error}
        </FieldMessage>
      ) : null}
    </div>
  );
}

function ChoiceCard({ choice, checked, pending }: { choice: Choice; checked: boolean; pending: boolean }) {
  const statusId = useId();
  return (
    <div
      className={cn(
        "relative flex min-h-16 items-start gap-3 rounded-xl border bg-card px-3.5 py-3 transition-colors",
        checked ? "border-primary/60 bg-primary/[0.04] ring-1 ring-primary/40 dark:bg-primary/[0.08]" : "hover:bg-accent/40",
        choice.blocked && "bg-muted/40",
      )}
    >
      <label className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 has-[[data-disabled]]:cursor-not-allowed">
        <RadioPrimitive.Root
          value={choice.value}
          disabled={choice.blocked}
          className="peer relative mt-0.5 inline-flex size-[1.125rem] shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background data-checked:border-primary data-disabled:opacity-50 dark:bg-input/32"
        >
          <RadioPrimitive.Indicator className="size-2.5 rounded-full bg-primary data-unchecked:hidden forced-colors:bg-[Highlight]" />
        </RadioPrimitive.Root>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            {choice.logo}
            <span className={cn("truncate text-[0.9375rem] font-medium", choice.blocked && "text-muted-foreground")}>{choice.name}</span>
            {pending ? <Spinner className="size-3.5" /> : null}
          </span>
          <span id={statusId} className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Dot tone={choice.tone} />
            <span className="min-w-0 truncate">{choice.status}</span>
          </span>
        </span>
      </label>
      {choice.fix ? (
        <Button variant="ghost" size="sm" className="-me-1.5 shrink-0 self-center" onClick={choice.fix.run}>
          {choice.fix.label}
          <span className="sr-only"> {choice.name}</span>
        </Button>
      ) : null}
    </div>
  );
}
