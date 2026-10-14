import { DropdownMenu } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { ModelSearch } from "@/components/settings/model-search";
import { announce } from "@/components/shell/announcer";
import type { Command } from "@/components/shell/command-palette";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconTip } from "@/components/ui/tooltip";
import { Icon } from "@/icons";
import type { ProviderId } from "@/lib/backend";
import {
  changedText,
  choosableProviders,
  modelGroups,
  modelName,
  modelOf,
  setSpaceModel,
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
 * next message; a reply already running keeps its model. Not shown when
 * Claude Code answers: it picks its own model (Settings says so).
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

  if (s.backend !== "phaethon" || s.status === "loading") return null;

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
          className="z-50 flex max-h-(--radix-dropdown-menu-content-available-height) w-[calc(20rem*var(--ph-ui-scale))] max-w-(--radix-dropdown-menu-content-available-width) flex-col overflow-y-auto overscroll-contain rounded-lg border border-line bg-raised p-1 text-ink shadow-lg outline-none origin-(--radix-dropdown-menu-content-transform-origin) animate-in duration-(--ph-duration-fast) fade-in-0 zoom-in-[0.97] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.97]"
        >
          <DropdownMenu.Label className="px-2.5 pt-1.5 text-sm font-semibold text-ink-secondary">Model in {spaceName}</DropdownMenu.Label>
          <p className="px-2.5 pb-1.5 text-sm text-ink-secondary" data-model-note="">
            {running ? "Applies from your next message. The reply now running keeps its model." : "Applies from your next message."}
          </p>
          {error && (
            <p role="alert" className="flex items-start gap-2 px-2.5 pb-1.5 text-sm text-danger-ink">
              <Icon name="error" className="mt-0.5 shrink-0" />
              <span className="min-w-0 wrap-anywhere">{error}</span>
            </p>
          )}
          <DropdownMenu.RadioGroup value={current.own ? current.id : DEFAULT} onValueChange={(v) => void choose(v)}>
            <ModelItem value={DEFAULT} title={`Use the default (${defaultName})`} hint="Follows the default in Settings" />
            {groups.map((g) => (
              <DropdownMenu.Group key={g.provider} aria-label={groups.length > 1 ? g.name : undefined}>
                <DropdownMenu.Separator className="mx-1 my-1 h-px shrink-0 bg-line forced-colors:bg-[CanvasText]" />
                {groups.length > 1 && (
                  <DropdownMenu.Label aria-hidden className="px-2.5 pt-1 pb-0.5 text-sm font-semibold text-ink-secondary" data-model-group={g.provider}>
                    {g.name}
                  </DropdownMenu.Label>
                )}
                {g.models.map((m) => (
                  <ModelItem
                    key={m.id}
                    value={m.id}
                    title={m.name}
                    // Grouped under the provider's name on screen; said in full.
                    spoken={g.provider === "anthropic" ? undefined : modelName(m.id, s.models)}
                  />
                ))}
              </DropdownMenu.Group>
            ))}
          </DropdownMenu.RadioGroup>
          {canChooseOther && (
            <>
              <DropdownMenu.Separator className="mx-1 my-1 h-px shrink-0 bg-line forced-colors:bg-[CanvasText]" />
              <DropdownMenu.Item
                data-model-option={OTHER}
                textValue="Another model"
                onSelect={() => {
                  setOpen(false);
                  setOther(true);
                }}
                className="grid min-h-(--ph-control-height-lg) cursor-default grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-center gap-x-2 rounded-md px-2.5 py-1.5 outline-none select-none data-highlighted:bg-hover"
              >
                <Icon name="search" />
                <span className="text-base font-medium">Another model…</span>
              </DropdownMenu.Item>
            </>
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
      hint: s.backend === "phaethon" ? `in ${space.name}: ${modelName(current.id, s.models)}` : `in ${space.name}`,
      keywords,
      icon: "agent",
      run: () => {
        if (s.backend !== "phaethon") announce("Claude Code chooses its own model. Change it in Claude Code.");
        else if (!document.querySelector(`[data-model-picker="${CSS.escape(space.id)}"]`))
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

function ModelItem({ value, title, hint, spoken }: { value: string; title: string; hint?: string; spoken?: string }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      textValue={title}
      aria-label={spoken}
      data-model-option={value}
      className="grid min-h-(--ph-control-height-lg) cursor-default grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-start gap-x-2 rounded-md px-2.5 py-1.5 outline-none select-none data-highlighted:bg-hover"
    >
      <span className="flex h-[1lh] items-center text-base">
        <DropdownMenu.ItemIndicator>
          <Icon name="check" className="text-accent-ink" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-base font-medium wrap-break-word">{title}</span>
        {hint && <span className="text-sm text-ink-secondary">{hint}</span>}
      </span>
    </DropdownMenu.RadioItem>
  );
}
