import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxRoot, ComboboxSearch } from "vic-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Icon } from "@/icons";
import { listModels, type ModelInfo, type ProviderInfo } from "@/lib/backend";
import { rememberNames } from "@/lib/space-model";

/** A model name as the core accepts it (providers.rs `is_valid_compat_model`). */
const MODEL_ID = /^(?![-./:])(?!.*\.\.)[A-Za-z0-9._:/@+-]{1,200}$/;
const FREE = "__free__";

/**
 * One provider's models: a search field over its list, and any name typed
 * there can be used as it is (a provider may have models its list doesn't
 * show). A combobox: the field keeps focus, Up and Down move through the
 * matches, Enter uses the one marked, Escape clears the search. How many
 * match is said as the list changes.
 */
export function ModelSearch({
  provider,
  current,
  onChoose,
  label,
  onRequestClose,
}: {
  provider: ProviderInfo;
  /** The model in use for this provider, marked in the list. */
  current: string | null;
  onChoose: (model: string, name: string) => void;
  label: string;
  onRequestClose?: () => void;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [problem, setProblem] = useState("");
  const [query, setQuery] = useState("");
  const inputId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setModels(null);
    setProblem("");
    listModels(provider.id).then(
      (m) => {
        if (!live) return;
        setModels(m);
        rememberNames(provider.id, m);
      },
      (e: unknown) => {
        if (!live) return;
        setModels([]);
        setProblem(String(e));
      },
    );
    return () => {
      live = false;
    };
  }, [provider.id, provider.baseUrl, provider.hasKey]);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = useMemo(
    () => (models ?? []).filter((m) => words.every((w) => m.id.toLowerCase().includes(w) || m.name.toLowerCase().includes(w))),
    [models, query],
  );
  const typed = query.trim();
  const offerTyped = MODEL_ID.test(typed) && !(models ?? []).some((m) => m.id === typed);
  const options: { value: string; title: string; detail?: string }[] = [
    ...matches.map((m) => ({ value: m.id, title: m.name, detail: m.name !== m.id ? m.id : undefined })),
    ...(offerTyped ? [{ value: FREE, title: `Use “${typed}”` }] : []),
  ];
  function choose(value: string) {
    if (value === FREE) onChoose(typed, typed);
    else onChoose(value, models?.find((m) => m.id === value)?.name ?? value);
  }

  // Escape clears the search first; a second Escape is the dialog's. The dialog listens
  // on the document while it captures, so this has to be heard before that, on the window.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.key !== "Escape" || document.activeElement !== inputRef.current || !queryRef.current) return;
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    };
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, []);

  const loading = models === null;
  const name = provider.name;
  const status = loading
    ? `Getting the models ${name} offers…`
    : problem
      ? problem
      : !models.length && !typed
        ? "No models listed."
        : !typed
          ? `${models.length} model${models.length === 1 ? "" : "s"}.`
          : matches.length
            ? `${matches.length} match “${typed}”.`
            : offerTyped
              ? `No listed model matches “${typed}”.`
              : `No model matches “${typed}”.`;

  return (
    <div className="flex flex-col gap-2" data-model-search={provider.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <label htmlFor={inputId} className="text-sm font-normal text-ink">{label}</label>
        <span data-model-selection="" className="text-xs text-ink-secondary">{current ? "Selected" : "Not selected"}</span>
      </div>
      <ComboboxRoot label={`${name} models`} items={options.map(option => ({ value: option.value, label: option.title }))}
        value={current} query={query} onQueryChange={setQuery} defaultOpen closeOnSelect={false}
        onValueChange={choose} onOpenChange={open => { if (!open) onRequestClose?.(); }}>
        <div className="relative flex items-center">
          <Icon name="search" className="pointer-events-none absolute start-2.5 z-10 size-3.5 text-ink-tertiary" />
          <ComboboxSearch ref={inputRef} id={inputId} data-model-query="" aria-describedby={statusId}
            autoComplete="off" spellCheck={false} placeholder="Search or enter a model name…" className="w-full ps-9!" />
        </div>
        <div id={statusId} role="status" className="py-2 text-xs text-ink-secondary" data-model-search-status="">{status}</div>
        <ComboboxList aria-label={`${name} models`} className="max-h-(--ph-model-list-max-height)! overflow-y-auto overscroll-contain rounded-md bg-surface-sunken p-1!">
          {options.map(option => <ComboboxItem key={option.value} value={option.value} data-model-choice={option.value}
            className="flex min-h-8! items-center gap-2 rounded-sm px-2! py-1.5! text-sm! font-normal!">
            <span className="min-w-0 flex-1 truncate text-ink" title={option.title}>{option.title}</span>
            {option.detail && <span className="max-w-[45%] truncate text-xs text-ink-secondary" title={option.detail}>{option.detail}</span>}
            {option.value === current && <Icon name="check" className="size-3.5 text-accent-ink" />}
          </ComboboxItem>)}
        </ComboboxList>
        <ComboboxEmpty className="px-2 py-3 text-xs text-ink-secondary">{loading ? "Loading models…" : "No matching models"}</ComboboxEmpty>
      </ComboboxRoot>
    </div>
  );
}
