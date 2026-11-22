import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { cleanMessage } from "@/components/errors";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { ProviderIcon } from "@/components/provider-icon";
import { SkeletonRows } from "@/components/skeletons";
import { Truncate, TruncateTips } from "@/components/truncate";
import { Kbd } from "@/components/ui/kbd";
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
  const searchRef = useRef<HTMLInputElement>(null);
  const { models, error, loading, load } = useModels(provider.id, open);

  const choose = (id: string) => {
    setOpen(false);
    if (id !== current) onChoose(id);
  };

  const label = current ? modelLabel(current, models) : null;

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger
        disabled={disabled}
        className="inline-flex h-7 w-auto min-w-0 max-w-56 items-center gap-1.5 rounded-md px-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 data-popup-open:bg-accent"
      >
        <ProviderIcon id={provider.id} className="size-3.5" />
        {label ? <Truncate className="flex-1">{label}</Truncate> : <span className="flex-1 truncate text-placeholder">Choose a model</span>}
        <Icon icon={icons.chevronDown} className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" padding="none" className="w-80 max-w-(--viewport-max-width)" initialFocus={() => searchRef.current ?? undefined}>
        <ModelChooserPanel
          provider={provider}
          current={current}
          models={models}
          error={error}
          loading={loading}
          load={load}
          searchRef={searchRef}
          onChoose={choose}
        />
      </PopoverPopup>
    </Popover>
  );
}

function ModelChooserPanel({
  provider,
  current,
  models,
  error,
  loading,
  load,
  searchRef,
  onChoose,
}: {
  provider: ProviderInfo;
  current: string | null;
  models: ModelInfo[] | undefined;
  error: string | null;
  loading: boolean;
  load: (force?: boolean) => Promise<void>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onChoose: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const hideTip = useRef<(() => void) | null>(null);

  const rows = useMemo(() => matchModels(models ?? [], query), [models, query]);
  const typed = query.trim();
  const canType = !!typed && isValidModelFor(provider.id, typed) && !(models ?? []).some((m) => m.id === typed) && (rows.length === 0 || !models);
  const total = rows.length + (canType ? 1 : 0);
  useEffect(() => setHi(0), [query]);

  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => listRef.current,
    estimateSize: () => 32,
    getItemKey: (i) => (i < rows.length ? rows[i]!.id : `__typed:${typed}`),
    initialRect: { width: 320, height: 320 },
    overscan: 8,
  });

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!total) return;
      e.preventDefault();
      const next = Math.max(0, Math.min(total - 1, hi + (e.key === "ArrowDown" ? 1 : -1)));
      setHi(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi < rows.length && rows[hi]) onChoose(rows[hi].id);
      else if (canType) onChoose(typed);
    }
  };

  return (
    <div className="flex max-h-[min(22rem,var(--available-height))] min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Icon icon={icons.search} className="size-3.5 text-subtle-foreground" />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder={error ? "Type a model’s name" : "Search or type a model"}
          className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <TruncateTips hideRef={hideTip}>
        <div ref={listRef} onScroll={() => hideTip.current?.()} className="min-h-0 flex-1 overflow-y-auto p-1" role="listbox" aria-label={`${provider.name} models`}>
          {loading && !models ? <SkeletonRows count={5} /> : null}
          {error && !models ? (
            <div className="flex items-start gap-2 px-2 py-2 text-muted-foreground text-xs">
              <Icon icon={icons.error} className="mt-0.5 size-3.5 text-error" />
              <span className="line-clamp-3 min-w-0 flex-1 [overflow-wrap:anywhere]">{error}</span>
              <button type="button" className="shrink-0 font-medium text-foreground hover:underline" onClick={() => void load(true)}>
                Retry
              </button>
            </div>
          ) : null}
          {models && models.length === 0 && !typed ? <p className="px-2 py-4 text-center text-muted-foreground text-xs">No models listed. Type a model’s name.</p> : null}
          {total > 0 ? (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((v) => {
                const i = v.index;
                if (i < rows.length) {
                  const m = rows[i]!;
                  const selected = m.id === current || !!(current && m.aliases?.includes(current));
                  return (
                    <div
                      key={m.id}
                      role="option"
                      aria-selected={selected}
                      data-row={i}
                      data-highlighted={i === hi || undefined}
                      onMouseMove={() => hi !== i && setHi(i)}
                      onClick={() => onChoose(m.id)}
                      style={{ transform: `translateY(${v.start}px)` }}
                      className="absolute inset-x-0 top-0 flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm data-highlighted:bg-accent"
                    >
                      <span className="flex min-w-0 flex-1 items-baseline gap-2">
                        <Truncate lazy className="shrink">{m.name}</Truncate>
                        {m.name !== m.id ? <Truncate lazy className="min-w-0 flex-1 font-mono text-2xs text-subtle-foreground">{m.id}</Truncate> : null}
                      </span>
                      <Icon icon={icons.check} className={cn("size-3.5 text-primary", selected ? "opacity-100" : "opacity-0")} />
                    </div>
                  );
                }
                return (
                  <div
                    key={`__typed:${typed}`}
                    role="option"
                    aria-selected={false}
                    data-row={rows.length}
                    data-highlighted={hi === rows.length || undefined}
                    onMouseMove={() => hi !== rows.length && setHi(rows.length)}
                    onClick={() => onChoose(typed)}
                    style={{ transform: `translateY(${v.start}px)` }}
                    className="absolute inset-x-0 top-0 flex h-8 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm data-highlighted:bg-accent"
                  >
                    <span className="shrink-0 text-muted-foreground">Use</span>
                    <Truncate lazy className="min-w-0 flex-1 font-mono text-xs">{typed}</Truncate>
                    <Kbd>Enter</Kbd>
                  </div>
                );
              })}
            </div>
          ) : null}
          {models && models.length > 0 && rows.length === 0 && !canType && typed ? (
            <p className="px-2 py-4 text-center text-muted-foreground text-xs">No model matches “{typed}”.</p>
          ) : null}
        </div>
      </TruncateTips>
    </div>
  );
}
