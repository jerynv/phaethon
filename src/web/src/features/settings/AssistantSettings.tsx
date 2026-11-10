/**
 * Settings › Assistant: who answers (Phaethon's agent or a coding-agent CLI),
 * the provider connections Phaethon's agent can use, the default model, and,
 * with `spaceId`, that space's own model. Also used in onboarding, so it
 * stands alone and works at phone width.
 */
import { ChevronRightIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useNav } from "@/app/nav";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { errorText } from "@/lib/core";

import { useAgents } from "./agents/store";
import {
  cliOfBackend,
  setAnthropicModel,
  setProvider,
  setProviderModel,
  setSpaceModel,
  SETTINGS_CHANGED_EVENT,
  type ProviderInfo,
  type Settings,
} from "./providers/api";
import { BackendChoice } from "./providers/BackendChoice";
import { addedProviders, DEFAULT_ANTHROPIC_MODEL, isValidModelFor, modelLabel, providerModel, providerNeed, splitRef, toRef } from "./providers/logic";
import { ModelSelect, type ModelGroup, type ModelOption } from "./providers/ModelPicker";
import { ProviderDialog, type ProviderDialogTarget } from "./providers/ProviderDialog";
import { ProviderLogo } from "./providers/ProviderLogo";
import { useAssistant, type ModelList } from "./providers/store";
import { Dot, FieldMessage, Group, Row, Section, useLiveRegion } from "./providers/ui";
import { CLI_INFO } from "./agents/api";

export function AssistantSettings({ spaceId }: { spaceId?: string }) {
  const { status, error, settings, load } = useAssistant();
  const loadAgents = useAgents((s) => s.load);
  const [dialog, setDialog] = useState<ProviderDialogTarget | null>(null);
  const { say, region } = useLiveRegion();

  useEffect(() => {
    void load();
    void loadAgents();
    // Another window or the chat may change these; read again when told.
    const reread = () => void load();
    window.addEventListener(SETTINGS_CHANGED_EVENT, reread);
    window.addEventListener("focus", reread);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED_EVENT, reread);
      window.removeEventListener("focus", reread);
    };
  }, [load, loadAgents]);

  if (!settings) {
    return (
      <div className="flex flex-col gap-8">
        {status === "error" ? (
          <Alert variant="error">
            <AlertTitle>Assistant settings couldn’t be read</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RotateCcwIcon />
                Try again
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <LoadingSkeleton />
        )}
      </div>
    );
  }

  const defaultProvider = settings.providers.find((p) => p.id === settings.provider);
  const need = defaultProvider ? providerNeed(defaultProvider, settings) : null;

  return (
    <div className="flex flex-col gap-8">
      {region}
      <Section title="Who answers" description="The same in every space." headingId="assistant-backend">
        <BackendChoice
          settings={settings}
          onSaid={say}
          onFixProvider={() =>
            setDialog(defaultProvider && (defaultProvider.hasKey || defaultProvider.key !== "required" || addedProviders(settings).length) ? { mode: "provider", id: settings.provider, focus: need?.field } : { mode: "pick" })
          }
        />
      </Section>

      <ProvidersSection settings={settings} need={need} onOpen={setDialog} />

      <ModelsSection settings={settings} spaceId={spaceId} onSaid={say} />

      <ProviderDialog target={dialog} onClose={() => setDialog(null)} onSaid={say} />
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Loading assistant settings">
      {[0, 1].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <Skeleton className="ms-1 h-5 w-36" />
          <div className="grid gap-2 sm:grid-cols-2">
            <Skeleton className="h-16 rounded-xl" />
            <Skeleton className="h-16 rounded-xl" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ProvidersSection({ settings, need, onOpen }: { settings: Settings; need: ReturnType<typeof providerNeed>; onOpen: (t: ProviderDialogTarget) => void }) {
  const models = useAssistant((s) => s.models);
  const rows = addedProviders(settings);
  const defaultProvider = settings.providers.find((p) => p.id === settings.provider);
  const nothingAdded = !rows.some((p) => p.hasKey || p.key !== "required");
  return (
    <Section
      title="Providers"
      description="API connections for Phaethon’s agent."
      headingId="assistant-providers"
      action={
        nothingAdded ? null : (
          <Button variant="outline" size="sm" onClick={() => onOpen({ mode: "pick" })}>
            <PlusIcon />
            Add provider
          </Button>
        )
      }
    >
      {need && defaultProvider && settings.backend === "phaethon" && !nothingAdded ? (
        <Alert variant="warning">
          <AlertTitle>Phaethon’s agent can’t answer yet</AlertTitle>
          <AlertDescription>
            {defaultProvider.name}: {need.text}
          </AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => onOpen({ mode: "provider", id: defaultProvider.id, focus: need.field })}>
              {need.field === "key" ? "Add key" : need.field === "url" ? "Add address" : "Choose model"}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {nothingAdded ? (
        <Empty className="rounded-xl border border-dashed bg-card/50 py-8">
          <EmptyHeader>
            <EmptyTitle className="text-base">No provider yet</EmptyTitle>
            <EmptyDescription className="text-sm">Add an API key from Anthropic, OpenAI or another service, or connect a model running on this computer.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => onOpen({ mode: "pick" })}>
              <PlusIcon />
              Add provider
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <Group>
          {rows.map((p) => (
            <ProviderRow key={p.id} provider={p} settings={settings} list={models[p.id]} onOpen={() => onOpen({ mode: "provider", id: p.id })} />
          ))}
        </Group>
      )}
    </Section>
  );
}

function ProviderRow({ provider, settings, list, onOpen }: { provider: ProviderInfo; settings: Settings; list?: ModelList; onOpen: () => void }) {
  const isDefault = provider.id === settings.provider;
  const need = providerNeed(provider, settings);
  const model = providerModel(provider, settings);
  const summary = need ? need.text : model ? modelLabel(model, list?.models) : "";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Manage ${provider.name}`}
      aria-describedby={undefined}
      className="group flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background">
        <ProviderLogo id={provider.id} className="size-[1.125rem]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[0.9375rem] font-medium">{provider.name}</span>
          {isDefault ? (
            <Badge variant="secondary" size="lg">
              Default
            </Badge>
          ) : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
          <Dot tone={need ? "warning" : "ready"} />
          <span className="truncate">{summary}</span>
        </span>
      </span>
      <span className="hidden text-sm text-muted-foreground sm:inline" aria-hidden>
        Manage
      </span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
    </button>
  );
}

/** Groups of models from every provider that can answer, for the model selects. */
function useModelGroups(settings: Settings): { groups: ModelGroup[]; loadAll: () => void; label: (ref: string) => string } {
  const models = useAssistant((s) => s.models);
  const loadModels = useAssistant((s) => s.loadModels);
  const usable = settings.providers.filter((p) => p.ready || p.id === settings.provider);
  const groups = useMemo<ModelGroup[]>(
    () =>
      usable
        .filter((p) => p.ready)
        .map((p) => {
          const list = models[p.id];
          const chosen = providerModel(p, settings);
          const options: ModelOption[] = (list?.models ?? []).map((m) => ({
            value: toRef(p.id, m.id),
            label: m.name,
            detail: p.id !== "anthropic" && m.name !== m.id ? m.id : undefined,
            icon: <ProviderLogo id={p.id} className="size-4" />,
          }));
          if (chosen && !options.some((o) => o.value === toRef(p.id, chosen)))
            options.unshift({ value: toRef(p.id, chosen), label: modelLabel(chosen, list?.models), icon: <ProviderLogo id={p.id} className="size-4" /> });
          return {
            label: p.name,
            options,
            status: list?.status === "loading" ? ("loading" as const) : list?.status === "error" ? ("error" as const) : undefined,
            error: list?.status === "error" ? list.error : undefined,
            typed: (name: string) => (isValidModelFor(p.id, name) ? { value: toRef(p.id, name), label: `Use “${name}”`, detail: p.name } : null),
          };
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [models, settings],
  );
  const label = (ref: string) => {
    const { provider, model } = splitRef(ref);
    const name = modelLabel(model, models[provider]?.models);
    if (provider === "anthropic") return name;
    return `${settings.providers.find((p) => p.id === provider)?.name ?? provider} · ${name}`;
  };
  return { groups, loadAll: () => usable.filter((p) => p.ready).forEach((p) => void loadModels(p.id)), label };
}

function ModelsSection({ settings, spaceId, onSaid }: { settings: Settings; spaceId?: string; onSaid: (t: string) => void }) {
  const { spaces, spaceModels, load } = useAssistant();
  const openSettings = useNav((s) => s.openSettings);
  const { groups, loadAll, label } = useModelGroups(settings);
  const [error, setError] = useState<{ where: string; text: string } | null>(null);
  const cli = cliOfBackend(settings.backend);
  const anyReady = settings.providers.some((p) => p.ready);

  // Names for the models in use, once.
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.provider, settings.providers.map((p) => p.ready).join()]);

  async function chooseDefault(option: ModelOption) {
    const { provider, model } = splitRef(option.value);
    setError(null);
    try {
      if (provider === "anthropic") await setAnthropicModel(model === DEFAULT_ANTHROPIC_MODEL ? null : model);
      else await setProviderModel(provider, model);
      if (provider !== settings.provider) await setProvider(provider);
      await load();
      onSaid(`The default model is ${label(option.value)}.`);
    } catch (e) {
      setError({ where: "default", text: errorText(e) });
    }
  }

  async function chooseForSpace(space: string, ref: string | null) {
    setError(null);
    try {
      await setSpaceModel(space, ref);
      await load();
      const name = spaces.find((s) => s.id === space)?.name ?? "This space";
      onSaid(ref ? `${name} uses ${label(ref)}.` : `${name} uses the default model.`);
    } catch (e) {
      setError({ where: space, text: errorText(e) });
    }
  }

  const defaultRef = settings.defaultModel;
  const space = spaceId ? spaces.find((s) => s.id === spaceId) : undefined;
  const spaceName = space?.name ?? "this space";
  const own = cli ? [] : spaces.filter((s) => spaceModels[s.id]);

  return (
    <Section title="Models" description="For Phaethon’s agent." headingId="assistant-models">
      <Group>
        <Row
          title="Default model"
          description="Used in every space that hasn’t chosen its own."
          titleId="model-default-label"
          control={
            <div className="w-full @min-[34rem]/row:w-72">
              <ModelSelect
                groups={groups}
                value={defaultRef}
                onChange={(o) => void chooseDefault(o)}
                ariaLabel="Default model"
                ariaDescribedBy={error?.where === "default" ? "model-default-error" : undefined}
                invalid={error?.where === "default"}
                disabled={!anyReady}
                triggerLabel={
                  defaultRef ? (
                    <>
                      <ProviderLogo id={splitRef(defaultRef).provider} className="size-4" />
                      <span className="truncate">{label(defaultRef)}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{anyReady ? "Choose a model" : "Add a provider first"}</span>
                  )
                }
              />
            </div>
          }
        >
          {error?.where === "default" ? (
            <FieldMessage id="model-default-error" tone="error" className="mt-2">
              {error.text}
            </FieldMessage>
          ) : null}
        </Row>

        {spaceId ? (
          cli ? (
            <Row
              title={`Model in ${spaceName}`}
              description={`${CLI_INFO[cli].name} answers now, so this space’s model is chosen under Coding agents.`}
              control={
                <Button variant="outline" size="sm" onClick={() => openSettings("agents")}>
                  Coding agents
                </Button>
              }
            />
          ) : (
            <Row
              title={`Model in ${spaceName}`}
              control={
                <div className="w-full @min-[34rem]/row:w-72">
                  <ModelSelect
                    groups={[
                      { label: "", options: [{ value: "", label: "Same as default", detail: defaultRef ? label(defaultRef) : undefined }] },
                      ...groups,
                    ]}
                    value={spaceModels[spaceId] ?? ""}
                    onChange={(o) => void chooseForSpace(spaceId, o.value || null)}
                    ariaLabel={`Model in ${spaceName}`}
                    ariaDescribedBy={error?.where === spaceId ? "model-space-error" : undefined}
                    invalid={error?.where === spaceId}
                    disabled={!anyReady}
                    triggerLabel={
                      spaceModels[spaceId] ? (
                        <>
                          <ProviderLogo id={splitRef(spaceModels[spaceId]).provider} className="size-4" />
                          <span className="truncate">{label(spaceModels[spaceId])}</span>
                        </>
                      ) : (
                        <span>
                          Same as default<span className="text-muted-foreground">{defaultRef ? ` · ${label(defaultRef)}` : ""}</span>
                        </span>
                      )
                    }
                  />
                </div>
              }
            >
              {error?.where === spaceId ? (
                <FieldMessage id="model-space-error" tone="error" className="mt-2">
                  {error.text}
                </FieldMessage>
              ) : null}
            </Row>
          )
        ) : (
          own.map((s) => (
            <Row
              key={s.id}
              title={s.name}
              description={label(spaceModels[s.id])}
              control={
                <Button variant="outline" size="sm" onClick={() => void chooseForSpace(s.id, null)}>
                  Use the default
                  <span className="sr-only"> in {s.name}</span>
                </Button>
              }
            >
              {error?.where === s.id ? (
                <FieldMessage tone="error" className="mt-2">
                  {error.text}
                </FieldMessage>
              ) : null}
            </Row>
          ))
        )}
      </Group>
    </Section>
  );
}
