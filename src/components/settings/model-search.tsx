import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Icon } from "@/icons";
import { listModels, type ModelInfo, type ProviderInfo } from "@/lib/backend";
import { rememberNames } from "@/lib/space-model";
import { cn } from "@/lib/utils";

/** Most models listed at once; typing narrows a long list (OpenRouter's has hundreds). */
const SHOWN = 50;
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
}: {
  provider: ProviderInfo;
  /** The model in use for this provider, marked in the list. */
  current: string | null;
  onChoose: (model: string, name: string) => void;
  label: string;
}) {
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [problem, setProblem] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const inputId = useId();
  const listId = useId();
  const statusId = useId();
  const listRef = useRef<HTMLUListElement>(null);
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
    ...matches.slice(0, SHOWN).map((m) => ({ value: m.id, title: m.name, detail: m.name !== m.id ? m.id : undefined })),
    ...(offerTyped ? [{ value: FREE, title: `Use “${typed}”`, detail: "as the model’s name" }] : []),
  ];
  const at = Math.min(active, Math.max(0, options.length - 1));
  const optionId = (i: number) => `${listId}-o${i}`;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`#${CSS.escape(optionId(at))}`)?.scrollIntoView({ block: "nearest" });
  }, [at]);

  function choose(value: string) {
    if (value === FREE) onChoose(typed, typed);
    else onChoose(value, models?.find((m) => m.id === value)?.name ?? value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(Math.max(0, Math.min(options.length - 1, at + (e.key === "ArrowDown" ? 1 : -1))));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (options[at]) choose(options[at].value);
    }
  }

  // Escape clears the search first; a second Escape is the dialog's. The dialog listens
  // on the document while it captures, so this has to be heard before that, on the window.
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement !== inputRef.current || !queryRef.current) return;
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
      ? `${problem} Type a model’s name above to use it.`
      : !models.length && !typed
        ? `${name} listed no models. Type a model’s name above to use it.`
        : !typed
          ? models.length > SHOWN
            ? `${models.length} models. The first ${SHOWN} are shown; type to find others.`
            : `${models.length} model${models.length === 1 ? "" : "s"}.`
          : matches.length
            ? `${matches.length} match “${typed}”${matches.length > SHOWN ? `; the first ${SHOWN} are shown` : ""}.`
            : offerTyped
              ? `No listed model matches “${typed}”. Press Enter to use it as the model’s name.`
              : `No model matches “${typed}”.`;

  return (
    <div className="flex flex-col gap-2" data-model-search={provider.id}>
      <label htmlFor={inputId} className="text-base font-medium text-ink">
        {label}
      </label>
      <div className="relative flex items-center">
        <Icon name="search" className="pointer-events-none absolute start-2.5 text-ink-tertiary" />
        <input
          ref={inputRef}
          id={inputId}
          data-model-query=""
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={options.length ? optionId(at) : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search, or type a model’s name"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          className="min-h-(--ph-control-height-lg) w-full rounded-md border border-line-strong bg-bg py-1.5 ps-9 pe-3 text-base text-ink placeholder:text-ink-tertiary"
        />
      </div>
      <div id={statusId} role="status" className="text-sm text-ink-secondary" data-model-search-status="">
        {status}
      </div>
      {options.length > 0 && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={`${name} models`}
          className="flex max-h-(--ph-model-list-max-height) flex-col overflow-y-auto overscroll-contain rounded-md border border-line bg-raised p-1"
        >
          {options.map((o, i) => {
            const inUse = o.value === current;
            return (
              <li
                key={o.value}
                id={optionId(i)}
                role="option"
                aria-selected={i === at}
                data-model-choice={o.value === FREE ? FREE : o.value}
                // The field keeps focus: a press chooses without moving it.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o.value)}
                onMouseMove={() => i !== at && setActive(i)}
                className={cn(
                  "grid min-h-(--ph-target-min) cursor-default grid-cols-[var(--ph-icon-size)_minmax(0,1fr)] items-start gap-x-2 rounded-sm px-2 py-1.5",
                  i === at && focused && "bg-hover outline-2 -outline-offset-2 outline-accent-fill forced-colors:outline-[Highlight]",
                )}
              >
                <span className="flex h-[1lh] items-center">{inUse && <Icon name="check" className="text-accent-ink" />}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-base text-ink wrap-anywhere">
                    {o.title}
                    {inUse && <span className="sr-only"> (in use)</span>}
                  </span>
                  {o.detail && <span className="text-sm text-ink-secondary wrap-anywhere">{o.detail}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
