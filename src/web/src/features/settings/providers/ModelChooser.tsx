import { CheckIcon, ChevronDownIcon, CircleAlertIcon, CornerDownLeftIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cleanMessage } from "@/components/errors";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate } from "@/components/truncate";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { listModels, type ModelInfo, type ProviderInfo } from "./api";
import { isValidModelFor, matchModels, modelLabel } from "./logic";

/**
 * A provider's model, chosen from its list (searchable) or typed in when the
 * provider doesn't list them. The list loads when the popover opens and is
 * kept for the page's life.
 */

const cache = new Map<string, ModelInfo[]>();

export function useModels(provider: ProviderInfo["id"], enabled: boolean) {
  const [models, setModels] = useState<ModelInfo[] | undefined>(() => cache.get(provider));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (force = false) => {
    if (!force && cache.has(provider)) return setModels(cache.get(provider));
    setLoading(true);
    setError(null);
    try {
      const list = await listModels(provider);
      cache.set(provider, list);
      setModels(list);
    } catch (e) {
      setError(cleanMessage(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (enabled) void load();
  }, [provider, enabled]);
  return { models, error, loading, load };
}

export function ModelChooser({
  provider,
  current,
  disabled,
  onChoose,
}: {
  provider: ProviderInfo;
  current: string | null;
  disabled?: boolean;
  onChoose: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { models, error, loading, load } = useModels(provider.id, open);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const rows = useMemo(() => matchModels(models ?? [], query), [models, query]);
  const typed = query.trim();
  const canType = !!typed && isValidModelFor(provider.id, typed) && !(models ?? []).some((m) => m.id === typed) && (rows.length === 0 || !models);
  const total = rows.length + (canType ? 1 : 0);
  useEffect(() => setHi(0), [query]);

  const choose = (id: string) => {
    setOpen(false);
    if (id !== current) onChoose(id);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.max(0, Math.min(total - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
      setHi(next);
      listRef.current?.querySelector(`[data-row="${next}"]`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi < rows.length && rows[hi]) choose(rows[hi].id);
      else if (canType) choose(typed);
    }
  };

  const label = current ? modelLabel(current, models) : null;

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        className="inline-flex h-7 w-52 min-w-0 items-center gap-2 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-left text-sm shadow-xs/5 transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-accent/50 dark:bg-input/32"
      >
        <ProviderIcon id={provider.id} className="size-3.5" />
        {label ? <Truncate className="flex-1">{label}</Truncate> : <span className="flex-1 truncate text-placeholder">Choose a model</span>}
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" strokeWidth={2.25} />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" padding="none" className="w-80 max-w-[calc(100vw-2rem)]" initialFocus={() => document.getElementById(`model-search-${provider.id}`) as HTMLElement}>
        <div className="flex max-h-[min(22rem,var(--available-height))] min-h-0 flex-col">
          <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
            <SearchIcon className="size-3.5 shrink-0 text-subtle-foreground" strokeWidth={2} />
            <input
              id={`model-search-${provider.id}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKey}
              placeholder={error ? "Type a model’s name" : "Search or type a model"}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label={`${provider.name} models`}>
            {loading && !models ? <SkeletonRows count={5} /> : null}
            {error && !models ? (
              <div className="flex items-start gap-2 px-2 py-2 text-muted-foreground text-xs">
                <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-error" strokeWidth={2} />
                <span className="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
                <button type="button" className="shrink-0 font-medium text-foreground hover:underline" onClick={() => void load(true)}>
                  Retry
                </button>
              </div>
            ) : null}
            {models && models.length === 0 && !typed ? <p className="px-2 py-4 text-center text-muted-foreground text-xs">No models listed. Type a model’s name.</p> : null}
            {rows.map((m, i) => {
              const selected = m.id === current || !!(current && m.aliases?.includes(current));
              return (
                <div
                  key={m.id}
                  role="option"
                  aria-selected={selected}
                  data-row={i}
                  data-highlighted={i === hi || undefined}
                  onMouseMove={() => setHi(i)}
                  onClick={() => choose(m.id)}
                  className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm data-highlighted:bg-accent"
                >
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <Truncate className="shrink">{m.name}</Truncate>
                    {m.name !== m.id ? <Truncate className="min-w-0 flex-1 font-mono text-[11px] text-subtle-foreground">{m.id}</Truncate> : null}
                  </span>
                  <CheckIcon className={cn("size-3.5 shrink-0", selected ? "opacity-100" : "opacity-0")} strokeWidth={2.25} />
                </div>
              );
            })}
            {canType ? (
              <div
                role="option"
                aria-selected={false}
                data-row={rows.length}
                data-highlighted={hi === rows.length || undefined}
                onMouseMove={() => setHi(rows.length)}
                onClick={() => choose(typed)}
                className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm data-highlighted:bg-accent"
              >
                <span className="shrink-0 text-muted-foreground">Use</span>
                <Truncate className="min-w-0 flex-1 font-mono text-xs">{typed}</Truncate>
                <CornerDownLeftIcon className="size-3.5 shrink-0 text-subtle-foreground" />
              </div>
            ) : null}
            {models && models.length > 0 && rows.length === 0 && !canType && typed ? (
              <p className="px-2 py-4 text-center text-muted-foreground text-xs">No model matches “{typed}”.</p>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
