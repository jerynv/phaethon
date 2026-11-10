/**
 * A space's coding-agent settings: the answering CLI's model and reasoning
 * there, the workspace folder the CLI works in, and full access.
 */
import { FolderIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorText } from "@/lib/core";

import { setSpaceModel } from "../providers/api";
import { COMPAT_MODEL } from "../providers/logic";
import { ModelSelect, type ModelGroup } from "../providers/ModelPicker";
import { FieldMessage, Group, Row } from "../providers/ui";
import {
  bindWorkspace,
  chooseWorkspace,
  CLI_INFO,
  clearWorkspace,
  fullAccessList,
  getReasoning,
  getSpaceModel,
  getWorkspace,
  setFullAccess,
  setReasoning,
  type CliId,
  type WorkspaceView,
} from "./api";
import { currentInstance, useAgents } from "./store";

const EFFORT_NAMES: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};
const effortName = (e: string) => EFFORT_NAMES[e] ?? e;

export function SpaceAgentSettings({ space, spaceName, cli, onSaid }: { space: string; spaceName: string; cli: CliId | null; onSaid: (t: string) => void }) {
  return (
    <Group>
      {cli ? <CliModelRows key={`${space}-${cli}`} space={space} spaceName={spaceName} cli={cli} onSaid={onSaid} /> : null}
      <WorkspaceRow key={`w-${space}`} space={space} onSaid={onSaid} />
      <FullAccessRow key={`f-${space}`} space={space} spaceName={spaceName} onSaid={onSaid} />
    </Group>
  );
}

function CliModelRows({ space, spaceName, cli, onSaid }: { space: string; spaceName: string; cli: CliId; onSaid: (t: string) => void }) {
  const instances = useAgents((s) => s.instances);
  const instance = currentInstance(instances, cli);
  const catalogState = useAgents((s) => (instance ? s.catalogs[instance.config.id] : undefined));
  const loadCatalog = useAgents((s) => s.loadCatalog);
  const [model, setModel] = useState<string | null | undefined>(undefined);
  const [effort, setEffort] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<{ where: "model" | "effort"; text: string } | null>(null);
  const [savingEffort, setSavingEffort] = useState(false);
  const name = CLI_INFO[cli].name;
  const catalog = catalogState?.catalog;
  const modelErrorId = useId();
  const effortErrorId = useId();
  const effortLabelId = useId();

  useEffect(() => {
    if (instance) void loadCatalog(instance.config.id);
  }, [instance, loadCatalog]);

  useEffect(() => {
    let live = true;
    getSpaceModel(space).then(
      (ref) => {
        if (!live) return;
        const m = ref && ref.startsWith(`${cli}:`) ? ref.slice(cli.length + 1) : null;
        setModel(m);
      },
      (e: unknown) => live && setError({ where: "model", text: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [space, cli]);

  const effectiveModel = model ?? catalog?.defaultModel ?? null;
  const modelInfo = catalog?.models.find((m) => m.id === effectiveModel || m.aliases?.includes(effectiveModel ?? ""));
  const efforts = modelInfo?.reasoningEfforts ?? [];

  const loadEffort = useCallback(() => {
    if (model === undefined) return;
    getReasoning(space, cli, model).then(
      (e) => setEffort(e),
      (e: unknown) => setError({ where: "effort", text: errorText(e) }),
    );
  }, [space, cli, model]);
  useEffect(loadEffort, [loadEffort]);

  const groups = useMemo<ModelGroup[]>(() => {
    const defaultName = catalog?.defaultModel ? (catalog.models.find((m) => m.id === catalog.defaultModel)?.name ?? catalog.defaultModel) : undefined;
    const options = (catalog?.models ?? []).map((m) => ({ value: m.id, label: m.name, detail: m.name !== m.id ? m.id : undefined }));
    if (model && !options.some((o) => o.value === model)) options.unshift({ value: model, label: model, detail: undefined });
    return [
      { label: "", options: [{ value: "", label: `${name}’s default`, detail: defaultName }] },
      {
        label: name,
        options,
        status: catalogState?.status === "loading" ? "loading" : undefined,
        error: catalogState?.status === "error" ? catalogState.error : catalog?.note,
        typed: (typed) => (COMPAT_MODEL.test(typed) && typed.length <= 100 ? { value: typed, label: `Use “${typed}”` } : null),
      },
    ];
  }, [catalog, catalogState, model, name]);

  async function chooseModel(value: string) {
    setError(null);
    try {
      await setSpaceModel(space, value ? `${cli}:${value}` : null);
      setModel(value || null);
      const label = value ? (catalog?.models.find((m) => m.id === value)?.name ?? value) : `${name}’s default`;
      onSaid(`${spaceName} uses ${label}.`);
    } catch (e) {
      setError({ where: "model", text: errorText(e) });
    }
  }

  async function chooseEffort(value: string) {
    const next = value === "" ? null : value;
    setSavingEffort(true);
    setError(null);
    try {
      await setReasoning(space, cli, model ?? null, next);
      setEffort(next);
      onSaid(next ? `Reasoning: ${effortName(next)}.` : "Reasoning: the model’s default.");
    } catch (e) {
      setError({ where: "effort", text: errorText(e) });
    } finally {
      setSavingEffort(false);
    }
  }

  const triggerLabel =
    model === undefined ? (
      <Skeleton className="h-4 w-32" />
    ) : model ? (
      (catalog?.models.find((m) => m.id === model)?.name ?? model)
    ) : (
      <span>
        {name}’s default
        {catalog?.defaultModel ? <span className="text-muted-foreground"> · {catalog.models.find((m) => m.id === catalog.defaultModel)?.name ?? catalog.defaultModel}</span> : null}
      </span>
    );

  const defaultEffort = modelInfo?.defaultReasoningEffort;
  return (
    <>
      <Row
        title="Model"
        control={
          <div className="w-full @min-[34rem]/row:w-72">
            <ModelSelect
              groups={groups}
              value={model === undefined ? null : (model ?? "")}
              onChange={(o) => void chooseModel(o.value)}
              ariaLabel={`${name} model in ${spaceName}`}
              ariaDescribedBy={error?.where === "model" ? modelErrorId : undefined}
              invalid={error?.where === "model"}
              disabled={model === undefined}
              triggerLabel={triggerLabel}
            />
          </div>
        }
      >
        {error?.where === "model" ? (
          <FieldMessage id={modelErrorId} tone="error" className="mt-2">
            {error.text}
          </FieldMessage>
        ) : null}
      </Row>
      {efforts.length ? (
        <Row
          title="Reasoning"
          titleId={effortLabelId}
          description="More reasoning answers harder questions better, and takes longer."
          control={
            <div className="flex w-full items-center gap-2 @min-[34rem]/row:w-72">
              <Select value={effort ?? ""} onValueChange={(v) => void chooseEffort(String(v ?? ""))} disabled={effort === undefined || savingEffort}>
                <SelectTrigger aria-labelledby={effortLabelId} aria-describedby={error?.where === "effort" ? effortErrorId : undefined}>
                  <SelectValue>
                    {(v: string) => (v ? effortName(v) : `Model default${defaultEffort ? ` · ${effortName(defaultEffort)}` : ""}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value="">Model default{defaultEffort ? ` · ${effortName(defaultEffort)}` : ""}</SelectItem>
                  {efforts.map((e) => (
                    <SelectItem key={e} value={e}>
                      {effortName(e)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              {savingEffort ? <Spinner className="size-4 shrink-0" /> : null}
            </div>
          }
        >
          {error?.where === "effort" ? (
            <FieldMessage id={effortErrorId} tone="error" className="mt-2">
              {error.text}
            </FieldMessage>
          ) : null}
        </Row>
      ) : null}
    </>
  );
}

function WorkspaceRow({ space, onSaid }: { space: string; onSaid: (t: string) => void }) {
  const answering = useNav((s) => s.activity[space] === "answering");
  const [ws, setWs] = useState<WorkspaceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const errorId = useId();
  const pathId = useId();

  useEffect(() => {
    let live = true;
    getWorkspace(space).then(
      (v) => live && setWs(v),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [space]);

  async function choose() {
    setBusy(true);
    setError("");
    try {
      const choice = await chooseWorkspace();
      if (choice) {
        setWs(await bindWorkspace(space, choice.token));
        onSaid(`Coding agents work in ${choice.name}.`);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function clear() {
    setBusy(true);
    setError("");
    try {
      setWs(await clearWorkspace(space));
      onSaid("Coding agents work in the space’s own folder.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      title="Workspace folder"
      description={
        ws ? (
          <span id={pathId} className="flex flex-col gap-0.5">
            <span className="font-mono text-sm [overflow-wrap:anywhere] text-foreground/80">{ws.path}</span>
            <span>{ws.kind === "managed" ? "The space’s own folder." : null}</span>
          </span>
        ) : (
          <Skeleton className="mt-1 h-4 w-64 max-w-full" />
        )
      }
      control={
        <>
          <Button variant="outline" size="sm" disabled={busy || answering || !ws} onClick={() => void choose()} aria-describedby={ws ? pathId : undefined}>
            {busy ? <Spinner /> : <FolderIcon />}
            Choose folder…
          </Button>
          {ws?.kind === "folder" ? (
            <Button variant="ghost" size="sm" disabled={busy || answering} onClick={() => void clear()}>
              Use the space folder
            </Button>
          ) : null}
        </>
      }
    >
      {ws && !ws.available ? (
        <FieldMessage tone="warning" className="mt-2">
          {ws.kind === "folder" ? "This folder was moved or can’t be found. Choose it again, or use the space folder." : "The space’s folder can’t be found."}
        </FieldMessage>
      ) : null}
      {answering ? (
        <FieldMessage tone="muted" className="mt-2">
          Stop the reply in this space to change its folder.
        </FieldMessage>
      ) : null}
      {error ? (
        <FieldMessage id={errorId} tone="error" className="mt-2">
          {error}
        </FieldMessage>
      ) : null}
    </Row>
  );
}

function FullAccessRow({ space, spaceName, onSaid }: { space: string; spaceName: string; onSaid: (t: string) => void }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labelId = useId();
  const descId = useId();

  useEffect(() => {
    let live = true;
    fullAccessList().then(
      (ids) => live && setOn(ids.includes(space)),
      (e: unknown) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [space]);

  async function toggle(next: boolean) {
    setBusy(true);
    setError("");
    try {
      const now = await setFullAccess(space, next);
      setOn(now);
      onSaid(now ? `Full access is on in ${spaceName}.` : `Full access is off in ${spaceName}.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row
      title={
        <span className="flex items-center gap-1.5">
          {on ? <TriangleAlertIcon aria-hidden className="size-4 text-warning" /> : null}
          <span id={labelId}>Full access</span>
        </span>
      }
      descriptionId={descId}
      description="A coding agent here can read and change any file on this computer, run any command and use the internet, without asking."
      control={
        on === null ? (
          <Skeleton className="h-5 w-9 rounded-full" />
        ) : (
          <Switch checked={on} disabled={busy} onCheckedChange={(v) => void toggle(v)} aria-labelledby={labelId} aria-describedby={descId} />
        )
      }
    >
      {error ? (
        <FieldMessage tone="error" className="mt-2">
          {error}
        </FieldMessage>
      ) : null}
    </Row>
  );
}
