import { ChevronDownIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { useNav } from "@/app/nav";
import { Button } from "@/components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu";
import { cn } from "@/lib/utils";
import { modelsList, spaceModelSet, spaceModelsList, type ModelInfo, type SettingsView } from "../api";
import { useSettings } from "../context";

// ---- What each space chose, and each provider's models: asked once, shared ----

let own: Record<string, string> = {};
const models = new Map<string, ModelInfo[] | "loading" | "error">();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
let ownAsked = false;
function refreshOwn() {
  ownAsked = true;
  spaceModelsList().then((o) => ((own = o), emit()), () => {});
}
function loadModels(provider: string) {
  const had = models.get(provider);
  if (had && had !== "error") return;
  models.set(provider, "loading");
  modelsList(provider).then(
    (list) => (models.set(provider, list), emit()),
    () => (models.set(provider, "error"), emit()),
  );
}

const CLI_NAMES: Record<string, string> = { "claude-cli": "Claude Code", "codex-cli": "Codex", "gemini-cli": "Gemini CLI" };

/** A model reference as the core saves it: a plain id is Anthropic's, else "provider:model". */
export function splitRef(ref: string, providers: { id: string }[]): { provider: string; model: string } {
  const at = ref.indexOf(":");
  const head = at > 0 ? ref.slice(0, at) : "";
  if (head && providers.some((p) => p.id === head)) return { provider: head, model: ref.slice(at + 1) };
  return { provider: "anthropic", model: ref };
}
export const joinRef = (provider: string, model: string) => (provider === "anthropic" ? model : `${provider}:${model}`);

const MARKS: Record<string, string> = {
  anthropic: "A", openai: "O", openrouter: "OR", groq: "G", together: "T", mistral: "M", deepseek: "D", xai: "X", ollama: "Ol", lmstudio: "LM", custom: "S",
};

/** A provider's small mark: letters in a box, so it never depends on colour. */
export function ProviderMark({ id, className }: { id: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-[0.3rem] border border-foreground/15 bg-foreground/5 px-0.5 text-[0.625rem] leading-none font-semibold text-foreground/80",
        className,
      )}
    >
      {MARKS[id] ?? id.slice(0, 1).toUpperCase()}
    </span>
  );
}

function nameOf(ref: string, s: SettingsView): string {
  const { provider, model } = splitRef(ref, s.providers);
  const list = models.get(provider);
  return (Array.isArray(list) ? list.find((m) => m.id === model)?.name : undefined) ?? model;
}

/**
 * The model that answers in this space, compact in the composer's toolbar:
 * its provider's mark and name, a menu of the ready providers' models, and
 * the default from Settings. With a coding agent answering, its name, and the
 * way to its settings.
 */
export function ModelPicker({ space, disabled }: { space: string; disabled?: boolean }) {
  const settings = useSettings();
  const nav = useNav();
  useSyncExternalStore(subscribe, () => version);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!ownAsked) refreshOwn();
  }, []);
  const ownRef = own[space];
  const defaultRef = settings?.defaultModel ?? settings?.model ?? "";
  const current = ownRef ?? defaultRef;
  const currentProvider = settings && current ? splitRef(current, settings.providers).provider : "";
  useEffect(() => {
    if (currentProvider) loadModels(currentProvider);
  }, [currentProvider]);

  if (!settings) return <span className="h-7 w-28 animate-pulse rounded-md bg-muted motion-reduce:animate-none" aria-hidden />;

  if (settings.backend !== "phaethon") {
    const cli = CLI_NAMES[settings.backend] ?? "Coding agent";
    const model = ownRef?.includes(":") ? ownRef.slice(ownRef.indexOf(":") + 1) : null;
    return (
      <Button variant="ghost-muted" size="xs" className="min-w-0 gap-1.5" onClick={() => nav.openSettings("agents")} title="Coding agent settings">
        <TerminalIcon aria-hidden className="size-3.5" />
        <span className="truncate">
          {cli}
          {model ? ` · ${model}` : ""}
        </span>
      </Button>
    );
  }

  const ready = settings.providers.filter((p) => p.ready);
  const choose = async (ref: string) => {
    setProblem(null);
    const next = ref === "default" ? null : ref;
    const before = own;
    own = { ...own };
    if (next) own[space] = next;
    else delete own[space];
    emit();
    try {
      await spaceModelSet(space, next);
    } catch (e) {
      own = before;
      emit();
      setProblem(String(e));
    }
  };

  return (
    <Menu onOpenChange={(open) => open && ready.forEach((p) => loadModels(p.id))}>
      <MenuTrigger
        disabled={disabled}
        render={<Button variant="ghost-muted" size="xs" className="min-w-0 max-w-56 gap-1.5" />}
        aria-label={`Model: ${current ? nameOf(current, settings) : "none chosen"}${ownRef ? "" : " (default)"}. Change model`}
      >
        {currentProvider && <ProviderMark id={currentProvider} />}
        <span className="truncate">{current ? nameOf(current, settings) : "Choose a model"}</span>
        <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="max-h-[min(28rem,60dvh)] w-72">
        <MenuRadioGroup value={ownRef ?? "default"} onValueChange={(v) => void choose(String(v))}>
          <MenuRadioItem value="default">
            <span className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <span>Default</span>
                {defaultRef && <span className="truncate text-xs text-muted-foreground">{nameOf(defaultRef, settings)}</span>}
              </span>
              <MenuRadioItemIndicator />
            </span>
          </MenuRadioItem>
          {ready.map((p) => {
            const list = models.get(p.id);
            return (
              <MenuGroup key={p.id}>
                <MenuSeparator />
                <MenuGroupLabel className="flex items-center gap-1.5">
                  <ProviderMark id={p.id} />
                  {p.name}
                </MenuGroupLabel>
                {list === "loading" || list === undefined ? (
                  <MenuItem disabled>Loading models…</MenuItem>
                ) : list === "error" || list.length === 0 ? (
                  <MenuItem disabled>{list === "error" ? "Couldn’t list its models" : "No models"}</MenuItem>
                ) : (
                  list.map((m) => (
                    <MenuRadioItem key={m.id} value={joinRef(p.id, m.id)}>
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate">{m.name}</span>
                        {m.sees === "no" && <span className="text-xs text-muted-foreground">text only</span>}
                        <MenuRadioItemIndicator />
                      </span>
                    </MenuRadioItem>
                  ))
                )}
              </MenuGroup>
            );
          })}
        </MenuRadioGroup>
        <MenuSeparator />
        <MenuItem onClick={() => nav.openSettings("assistant")}>Providers and keys…</MenuItem>
        {problem && <p className="px-2 py-1 text-xs text-destructive-foreground">{problem}</p>}
      </MenuPopup>
    </Menu>
  );
}
