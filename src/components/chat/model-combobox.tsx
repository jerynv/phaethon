import { useMemo, type ReactNode } from "react";
import { Star } from "lucide-react";
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxRoot, ComboboxSearch } from "vic-ui";

import { Icon } from "@/icons";
import { cn } from "@/lib/utils";

export type PickerOption = { value: string; model: string; name: string; provider: string; providerName: string; logo: ReactNode; selected: boolean; detail?: string };

/** T3's pinned search/list composition, rendered and controlled by Vic's inline
 * Combobox parts. The host filters once and keeps provider/footer layout outside
 * the list. Async selection and the enclosing popover remain host-owned.
 */
export function ModelCombobox({ options, query, onQueryChange, onChoose, favorites, onFavorite, searchRef, onFocusProviders, onRequestClose, busy, loading, children }: {
  options: PickerOption[]; query: string; onQueryChange: (value: string) => void; onChoose: (option: PickerOption) => void;
  favorites: Set<string>; onFavorite: (key: string) => void; searchRef: React.RefObject<HTMLInputElement | null>;
  onFocusProviders: () => void; onRequestClose?: () => void; busy: boolean; loading: boolean; children?: ReactNode;
}) {
  const filtered = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return options.filter(option => words.every(word => `${option.name} ${option.value} ${option.providerName}`.toLocaleLowerCase().includes(word)));
  }, [options, query]);
  const items = useMemo(() => filtered.map(option => ({ value: option.value, label: `${option.name}, ${option.providerName}`, disabled: busy })), [filtered, busy]);
  const selected = options.find(option => option.selected)?.value ?? null;

  return <ComboboxRoot label="Models" items={items} value={selected} query={query} onQueryChange={onQueryChange}
    defaultOpen disabled={busy} closeOnSelect={false}
    onOpenChange={open => { if (!open) onRequestClose?.(); }}
    onValueChange={value => { const option = filtered.find(item => item.value === value); if (option) onChoose(option); }}>
    <div className="ph-model-list-column">
      <div className="ph-model-search" data-model-search="">
        <Icon name="search" className="size-3.5 shrink-0 text-ink-tertiary" />
        <ComboboxSearch ref={searchRef} aria-label="Search models" placeholder="Search models…" autoComplete="off"
          onKeyDown={event => {
            if (busy || event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowLeft" && !query && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              event.preventDefault(); onFocusProviders();
            } else if (event.altKey && event.code === "KeyF" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
              const activeId = event.currentTarget.getAttribute("aria-activedescendant");
              const active = activeId ? event.currentTarget.ownerDocument.getElementById(activeId) : null;
              const key = active?.getAttribute("data-picker-value");
              if (key && filtered.some(option => option.value === key)) { event.preventDefault(); onFavorite(key); }
            }
          }} />
      </div>
      <ComboboxList aria-label="Models" aria-busy={busy || loading} className={cn("ph-model-list", !filtered.length && "hidden")} data-model-list="">
        {filtered.map(option => <div key={option.value} className="ph-model-row-group" role="presentation">
          <ComboboxItem value={option.value} aria-label={`${option.name}, ${option.providerName}`}
            data-model-option={option.model} data-picker-value={option.value} className="ph-model-row">
            <span className="ph-model-row-logo">{option.logo}</span>
            <span className="ph-model-row-name" title={option.name}>{option.name}</span>
            {option.detail && <span className="ph-model-row-detail">{option.detail}</span>}
            {option.selected && <Icon name="check" className="size-3.5 shrink-0 text-ink-secondary" />}
          </ComboboxItem>
          <button type="button" tabIndex={option.selected ? 0 : -1} disabled={busy} className={cn("ph-model-star", favorites.has(option.value) && "is-favorite")}
            aria-label={favorites.has(option.value) ? `Remove ${option.name} from favorites` : `Favorite ${option.name}`}
            onMouseDown={event => event.preventDefault()} onClick={() => onFavorite(option.value)}>
            <Star size={13} strokeWidth={1.5} fill={favorites.has(option.value) ? "currentColor" : "none"} />
          </button>
        </div>)}
      </ComboboxList>
      {!filtered.length && <ComboboxEmpty className="ph-model-empty">{loading ? "Loading models…" : query ? "No matching models" : "No models"}</ComboboxEmpty>}
      {children}
    </div>
  </ComboboxRoot>;
}
