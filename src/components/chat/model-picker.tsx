import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ModelSearch } from "@/components/settings/model-search";
import { announce } from "@/components/shell/announcer";
import type { Command } from "@/components/shell/command-palette";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconTip } from "@/components/ui/tooltip";
import { Icon, type IconName } from "@/icons";
import { cn } from "@/lib/utils";
import { cliOf, type ProviderId } from "@/lib/backend";
import {
  changedText,
  choosableProviders,
  cliModelName,
  loadCliModels,
  modelGroups,
  modelName,
  modelOf,
  setSpaceModel,
  splitCliRef,
  splitRef,
  toRef,
  useModels,
  type ModelsState,
} from "@/lib/space-model";
import type { Space } from "@/lib/spaces";

/** Fired on window to open a space's model menu (the command palette's "Change model…"). */
export const OPEN_MODEL_PICKER_EVENT = "phaethon:open-model-picker";
export const openModelPicker = (spaceId: string) =>
  window.dispatchEvent(new CustomEvent<string>(OPEN_MODEL_PICKER_EVENT, { detail: spaceId }));

const DEFAULT = "__default__";

/** "Claude Opus 5.5" → "Opus 5.5": the composer's toolbar has little room. */
const shortName = (name: string) => name.replace(/^Claude\s+/, "");
const OTHER = "__other__";

/**
 * The model that answers in this space, as a small button in the composer's
 * toolbar that opens a menu: Use the default first, then each model. A choice
 * is saved in the space (so each space keeps its own) and applies from the
 * next message; a reply already running keeps its model. With a CLI
 * answering (Claude Code, Codex, Gemini CLI), the CLI's own models instead.
 */
export function ModelPicker({ spaceId, spaceName, running }: { spaceId: string; spaceName: string; running: boolean }) {
  const s = useModels();
  const [open, setOpen] = useState(false);
  const [other, setOther] = useState(false);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent<string>).detail === spaceId) setOpen(true);
    };
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_MODEL_PICKER_EVENT, onOpen);
  }, [spaceId]);
  // Open (by pointer, keyboard or the command palette): start on the model in use, not the first item.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() =>
      contentRef.current?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [open]);

  if (s.status === "loading") return null;
  // An assistant this version doesn't know picks its own model too.
  if (s.backend !== "phaethon" && !cliOf(s.backend)) return null;
  if (s.backend !== "phaethon") return <CliModelPicker s={s} spaceId={spaceId} spaceName={spaceName} running={running} open={open} setOpen={setOpen} contentRef={contentRef} />;

  const current = modelOf(s, spaceId);
  const name = modelName(current.id, s.models);
  const defaultName = modelName(s.defaultModel, s.models);
  const label = `Model in ${spaceName}: ${name}${current.own ? "" : ", the default"}`;

  async function choose(value: string): Promise<boolean> {
    const model = value === DEFAULT ? null : value;
    if (model === (current.own ? current.id : null)) return true;
    setError("");
    try {
      await setSpaceModel(spaceId, model);
      announce(`${changedText(spaceName, model, s)}${running ? " The reply now running keeps its model." : ""}`);
      return true;
    } catch (e) {
      const message = `The model couldn’t be changed. ${String(e)}`;
      setError(message);
      announce(message);
      return false;
    }
  }
  const groups = modelGroups(s);
  const canChooseOther = choosableProviders(s).length > 0;

  return (
    <>
    <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
      <IconTip label={label} spoken="Change which model answers here">
        <DropdownMenu.Trigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-label={label}
            data-model-picker={spaceId}
            data-model={current.id}
            className="min-w-0 shrink px-2 text-sm font-medium"
          >
            <span className="truncate">{shortName(name)}</span>
            <Icon name="chevron-down" className="size-(--ph-icon-size-sm)" />
          </Button>
        </DropdownMenu.Trigger>
      </IconTip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={contentRef}
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={`Model in ${spaceName}`}
          data-model-menu=""
          className={MENU}
        >
          <MenuHeader spaceName={spaceName} note={running ? "Applies from your next message. The reply now running keeps its model." : "Applies from your next message."} />
          {error && <MenuError error={error} />}
          <DropdownMenu.RadioGroup value={current.own ? current.id : DEFAULT} onValueChange={(v) => void choose(v)}>
            <ModelItem value={DEFAULT} title="Default" hint={`${defaultName}, as set in Settings`} spoken={`Use the default, ${defaultName}`} />
            {groups.map((g) => (
              <DropdownMenu.Group key={g.provider} aria-label={groups.length > 1 ? g.name : undefined}>
                <Separator />
                {groups.length > 1 && (
                  <DropdownMenu.Label aria-hidden className={GROUP_LABEL} data-model-group={g.provider}>
                    {g.name}
                  </DropdownMenu.Label>
                )}
                {g.models.map((m) => (
                  <ModelItem
                    key={m.id}
                    value={m.id}
                    title={m.name}
                    hint={g.provider === "anthropic" ? anthropicHint(m.id) : undefined}
                    // Grouped under the provider's name on screen; said in full.
                    spoken={g.provider === "anthropic" ? undefined : modelName(m.id, s.models)}
                  />
                ))}
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.RadioGroup>
          {canChooseOther && (
            <MenuFooter>
              <MenuAction
                option={OTHER}
                icon="search"
                onSelect={() => {
                  setOpen(false);
                  setOther(true);
                }}
              >
                Another model…
              </MenuAction>
            </MenuFooter>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
    {other && (
      <OtherModelDialog
        s={s}
        spaceName={spaceName}
        current={current.id}
        onClose={() => {
          setOther(false);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        onChoose={choose}
      />
    )}
    </>
  );
}

/**
 * A CLI answers (Claude Code, Codex, Gemini CLI): the model button offers the
 * CLI's own default first, then the models the CLI itself says it offers
 * (asked once, again on Refresh the list or when Settings opens; a note says
 * in words when it can't list them), the model this space chose if it isn't
 * listed, then Another model… to type a name the CLI knows. Passed on as
 * `-m` / `--model`; saved in the space, apart from Phaethon's own choice.
 */
function CliModelPicker({
  s,
  spaceId,
  spaceName,
  running,
  open,
  setOpen,
  contentRef,
}: {
  s: ModelsState;
  spaceId: string;
  spaceName: string;
  running: boolean;
  open: boolean;
  setOpen: (o: boolean) => void;
  contentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const cli = cliOf(s.backend)!;
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const own = s.own[spaceId] ? splitCliRef(s.own[spaceId]) : null;
  const list = s.cliModels[cli.id];
  const ownName = own ? cliModelName(cli.id, own.model, s) : "";
  const name = own ? ownName : `${cli.name} default`;
  const label = `Model in ${spaceName}: ${own ? `${cli.name} · ${ownName}` : `${cli.name} default, the model ${cli.name} chooses`}`;
  useEffect(() => {
    if (open) void loadCliModels(cli.id);
  }, [open, cli.id]);

  /** `atField`: the dialog shows (and says) a refusal at its own field, so the menu doesn't too. */
  async function choose(model: string | null, atField = false): Promise<string> {
    if (model === (own?.model ?? null)) return "";
    try {
      await setSpaceModel(spaceId, model ? `${cli.id}:${model}` : null);
      announce(
        `${model ? `${spaceName} now uses ${cli.name} · ${cliModelName(cli.id, model, s)}.` : `${spaceName} now uses ${cli.name}’s own default model.`}${running ? " The reply now running keeps its model." : ""}`,
      );
      setError("");
      return "";
    } catch (e) {
      if (!atField) {
        const message = `The model couldn’t be changed. ${String(e)}`;
        setError(message);
        announce(message);
      }
      return String(e);
    }
  }

  return (
    <>
      <DropdownMenu.Root open={open} onOpenChange={setOpen} modal={false}>
        <IconTip label={label} spoken="Change which model answers here">
          <DropdownMenu.Trigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="sm"
              aria-label={label}
              data-model-picker={spaceId}
              data-model={own ? s.own[spaceId] : ""}
              className="min-w-0 shrink px-2 text-sm font-medium"
            >
              <span className="truncate">{name}</span>
              <Icon name="chevron-down" className="size-(--ph-icon-size-sm)" />
            </Button>
          </DropdownMenu.Trigger>
        </IconTip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            ref={contentRef}
            side="top"
            align="end"
            sideOffset={6}
            collisionPadding={8}
            aria-label={`Model in ${spaceName}`}
            data-model-menu=""
            className={MENU}
          >
            <MenuHeader
              spaceName={spaceName}
              note={`${cli.name} answers here. ${running ? "A change applies from your next message; the reply now running keeps its model." : "A change applies from your next message."}`}
            />
            {error && <MenuError error={error} />}
            <DropdownMenu.RadioGroup value={own ? own.model : DEFAULT} onValueChange={(v) => void choose(v === DEFAULT ? null : v)}>
              <ModelItem value={DEFAULT} title="Default" hint={`The model ${cli.name} chooses`} spoken={`${cli.name}’s own default`} />
              {!!list?.models.length && <Separator />}
              {list?.models.map((m) => (
                <ModelItem key={m.id} value={m.id} title={m.name} hint={m.description} spoken={`${cli.name} · ${m.name}`} />
              ))}
              {own && !list?.models.some((m) => m.id === own.model) && <ModelItem value={own.model} title={own.model} spoken={`${cli.name} · ${own.model}`} />}
            </DropdownMenu.RadioGroup>
            {(list?.status === "loading" || list?.note) && (
              <p className="mx-1 mt-1 flex items-start gap-2 rounded-md bg-surface-sunken px-2.5 py-2 text-sm text-ink-secondary" data-cli-models-note={list.status}>
                <Icon name={list.status === "loading" ? "spinner" : "info"} className={cn("mt-0.5 size-(--ph-icon-size-sm) shrink-0", list.status === "loading" && "animate-spin")} />
                <span className="min-w-0">{list.status === "loading" ? `Asking ${cli.name} which models it offers…` : list.note}</span>
              </p>
            )}
            <MenuFooter>
            <MenuAction
              option="__refresh__"
              icon="retry"
              busy={list?.status === "loading"}
              onSelect={(e) => {
                // Stays open: the list is asked again in place, and focus stays here.
                e.preventDefault();
                if (list?.status === "loading") return;
                void loadCliModels(cli.id, true).then((after) =>
                  announce(after?.models.length ? `${cli.name} offers ${after.models.length} models.` : (after?.note ?? `${cli.name} listed no models.`)),
                );
              }}
            >
              {list?.status === "loading" ? "Refreshing the list…" : "Refresh the list"}
            </MenuAction>
            <MenuAction
              option={OTHER}
              icon="edit"
              onSelect={() => {
                setOpen(false);
                setTyping(true);
              }}
            >
              Another model…
            </MenuAction>
            </MenuFooter>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {typing && (
        <CliModelDialog
          cli={cli}
          spaceName={spaceName}
          current={own?.model ?? ""}
          onClose={() => {
            setTyping(false);
            requestAnimationFrame(() => triggerRef.current?.focus());
          }}
          onChoose={(m) => choose(m, true)}
        />
      )}
    </>
  );
}

/** A model's name for a CLI, typed: Save (or Enter) passes it on from the next message; Escape closes. */
function CliModelDialog({
  cli,
  spaceName,
  current,
  onClose,
  onChoose,
}: {
  cli: NonNullable<ReturnType<typeof cliOf>>;
  spaceName: string;
  current: string;
  onClose: () => void;
  onChoose: (model: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState("");
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const example = cli.id === "codex" ? "gpt-5.5" : cli.id === "claude" ? "claude-sonnet-5-5" : "gemini-2.5-pro";
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-cli-model-dialog="">
        <DialogHeader>
          <DialogTitle>Model in {spaceName}</DialogTitle>
          <DialogDescription>
            {cli.name} answers with this model here, from your next message. For a model {cli.name}’s list doesn’t show, type its name as{" "}
            {cli.name} knows it.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const m = draft.trim();
            if (!m) {
              setError("Type a model’s name, or close this to keep the model as it is.");
              return;
            }
            void onChoose(m).then((problem) => (problem ? setError(problem) : onClose()));
          }}
        >
          <label htmlFor={inputId} className="text-base font-medium text-ink">
            Model name
          </label>
          <p id={hintId} className="text-sm text-ink-secondary">
            For example {example}. Your {cli.name} plan decides which models you can use.
          </p>
          <div className="flex flex-wrap gap-2">
            <input
              id={inputId}
              data-cli-model-input=""
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError("");
              }}
              aria-describedby={[hintId, error && errorId].filter(Boolean).join(" ")}
              aria-invalid={error ? true : undefined}
              className="min-h-(--ph-control-height-lg) min-w-0 flex-1 rounded-md border border-line-strong bg-bg px-3 py-1.5 font-mono text-base text-ink aria-invalid:border-danger"
            />
            <Button type="submit" className="min-h-(--ph-control-height-lg)" data-cli-model-save="">
              Use this model
            </Button>
          </div>
          {error && (
            <p id={errorId} role="alert" className="flex items-start gap-1.5 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Any model of any provider that can answer, for one space: the provider,
 * then its list to search (or a model's name to type). Choosing saves it for
 * the space and closes; Escape closes without a change.
 */
function OtherModelDialog({
  s,
  spaceName,
  current,
  onClose,
  onChoose,
}: {
  s: ModelsState;
  spaceName: string;
  current: string;
  onClose: () => void;
  onChoose: (ref: string) => Promise<boolean>;
}) {
  const providers = choosableProviders(s);
  const start = splitRef(current).provider;
  const [provider, setProvider] = useState<ProviderId>(providers.some((p) => p.id === start) ? start : providers[0].id);
  const selectId = useId();
  const info = providers.find((p) => p.id === provider) ?? providers[0];
  const inUse = splitRef(current).provider === info.id ? splitRef(current).model : null;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-other-model-dialog="">
        <DialogHeader>
          <DialogTitle>Model in {spaceName}</DialogTitle>
          <DialogDescription>Any model from a provider you’ve set up in Settings. It applies from your next message here.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={selectId} className="text-base font-medium text-ink">
            Provider
          </label>
          <select
            id={selectId}
            data-other-provider=""
            value={info.id}
            onChange={(e) => setProvider(e.target.value as ProviderId)}
            className="min-h-(--ph-control-height-lg) w-full rounded-md border border-line-strong bg-raised px-2.5 text-base text-ink shadow-sm hover:bg-hover"
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.local ? " (on this computer)" : ""}
              </option>
            ))}
          </select>
        </div>
        <ModelSearch
          key={info.id}
          provider={info}
          current={inUse}
          label="Model"
          onChoose={(id) => {
            void onChoose(toRef(info.id, id)).then((ok) => ok && onClose());
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The command palette's model commands for the shown space: Change model…
 * (opens this space's model menu, starting on the model in use) and, when the
 * space has its own model, Use the default model.
 */
export function useModelCommands(space: Space | undefined): Command[] {
  const s = useModels();
  return useMemo(() => modelCommands(s, space), [s, space]);
}

function modelCommands(s: ModelsState, space: Space | undefined): Command[] {
  if (!space || s.status === "loading") return [];
  const current = modelOf(s, space.id);
  const keywords = "model claude opus sonnet haiku gpt llama openai openrouter ollama provider switch choose";
  const list: Command[] = [
    {
      id: "change-model",
      group: "Actions",
      label: "Change model…",
      hint:
        s.backend === "phaethon"
          ? `in ${space.name}: ${modelName(current.id, s.models)}`
          : `in ${space.name}: ${current.own ? modelName(current.id) : `${cliOf(s.backend)?.name}’s own default`}`,
      keywords: `${keywords} codex gemini`,
      icon: "agent",
      run: () => {
        if (!document.querySelector(`[data-model-picker="${CSS.escape(space.id)}"]`))
          announce(`The model can be changed once the conversation in ${space.name} has loaded.`);
        else openModelPicker(space.id);
      },
    },
  ];
  if (s.backend === "phaethon" && current.own) {
    list.push({
      id: "default-model",
      group: "Actions",
      label: "Use the default model",
      hint: `in ${space.name}: ${modelName(s.defaultModel, s.models)}`,
      keywords,
      icon: "agent",
      run: () =>
        void setSpaceModel(space.id, null).then(
          () => announce(changedText(space.name, null)),
          (e: unknown) => announce(`The model couldn’t be changed. ${String(e)}`),
        ),
    });
  }
  return list;
}

/** A model: its name with a line on what it's for beneath, a check at the end when it's the one in use. */
function ModelItem({ value, title, hint, spoken }: { value: string; title: string; hint?: string; spoken?: string }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      textValue={title}
      aria-label={spoken}
      data-model-option={value}
      className="group/model grid min-h-(--ph-control-height-lg) cursor-default grid-cols-[minmax(0,1fr)_var(--ph-icon-size)] items-center gap-x-3 rounded-md px-2.5 py-2 outline-none select-none data-highlighted:bg-hover data-[state=checked]:bg-accent-soft data-[state=checked]:data-highlighted:bg-selected"
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-base font-medium wrap-break-word group-data-[state=checked]/model:text-accent-soft-ink">{title}</span>
        {hint && <span className="text-sm text-ink-secondary wrap-break-word">{hint}</span>}
      </span>
      <DropdownMenu.ItemIndicator className="flex items-center justify-center">
        <Icon name="check" className="text-accent-ink" />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

/** What each of Anthropic's families is for, said under its name. */
function anthropicHint(id: string): string | undefined {
  if (/opus/i.test(id)) return "Most capable, for hard problems";
  if (/sonnet/i.test(id)) return "Fast and capable, for most things";
  if (/haiku/i.test(id)) return "Quickest, for short answers";
  return undefined;
}

const MENU =
  "z-50 flex max-h-(--radix-dropdown-menu-content-available-height) w-[calc(19rem*var(--ph-ui-scale))] max-w-(--radix-dropdown-menu-content-available-width) flex-col overflow-y-auto overscroll-contain rounded-xl border border-line bg-raised p-1.5 text-ink shadow-lg outline-none origin-(--radix-dropdown-menu-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]";
const GROUP_LABEL = "px-2.5 pt-2 pb-1 text-sm font-medium text-ink-secondary";

function Separator() {
  return <DropdownMenu.Separator className="mx-1 my-1.5 h-px shrink-0 bg-line forced-colors:bg-[CanvasText]" />;
}

/** "Model" over the space's name, and when a change takes effect. */
function MenuHeader({ spaceName, note }: { spaceName: string; note: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-2.5 pt-1.5 pb-2">
      <DropdownMenu.Label className="text-base font-semibold text-ink">Model in {spaceName}</DropdownMenu.Label>
      <p className="text-sm text-ink-secondary" data-model-note="">
        {note}
      </p>
    </div>
  );
}

function MenuError({ error }: { error: string }) {
  return (
    <p role="alert" className="mx-1 mb-1.5 flex items-start gap-2 rounded-md bg-danger-soft px-2.5 py-2 text-sm text-danger-ink">
      <Icon name="error" className="mt-0.5 size-(--ph-icon-size-sm) shrink-0" />
      <span className="min-w-0 wrap-anywhere">{error}</span>
    </p>
  );
}

/** The menu's actions, set apart beneath the models. */
function MenuFooter({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Separator />
      {children}
    </>
  );
}

function MenuAction({
  option,
  icon,
  busy,
  onSelect,
  children,
}: {
  option: string;
  icon: IconName;
  busy?: boolean;
  onSelect: (e: Event) => void;
  children: string;
}) {
  return (
    <DropdownMenu.Item
      data-model-option={option}
      textValue={children.replace(/…$/, "")}
      aria-disabled={busy || undefined}
      onSelect={onSelect}
      className="flex min-h-(--ph-control-height) cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-base text-ink-secondary outline-none select-none data-highlighted:bg-hover data-highlighted:text-ink aria-disabled:cursor-progress"
    >
      <Icon name={busy ? "spinner" : icon} className={cn("size-(--ph-icon-size-sm) shrink-0", busy && "animate-spin")} />
      <span>{children}</span>
    </DropdownMenu.Item>
  );
}
