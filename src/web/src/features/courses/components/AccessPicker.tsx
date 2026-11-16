import { useRef, type ReactElement } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { SpaceAvatar } from "@/components/space-avatar";
import { Truncate } from "@/components/truncate";
import { Combobox, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxSearchInput, ComboboxTrigger } from "@/components/ui/combobox";
import { cn } from "@/lib/utils";

export type PickerItem = { id: string; label: string; hue?: number; title?: string };

/**
 * A searchable multi-select over spaces (for a course) or courses (for a
 * space). A tick means it sees every part, "Some parts" that it sees a few;
 * picking either a blank or a partial row gives every part, picking a ticked
 * one takes it away, as the old checkbox did.
 */
export function AccessPicker({
  items,
  all,
  some,
  onToggle,
  trigger,
  search,
  empty,
}: {
  items: PickerItem[];
  all: readonly string[];
  some: readonly string[];
  onToggle: (id: string, on: boolean) => void;
  trigger: ReactElement;
  search: string;
  empty: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const value = items.filter((i) => all.includes(i.id));
  return (
    <Combobox
      items={items}
      multiple
      value={value}
      itemToStringLabel={(i: PickerItem) => i.label}
      isItemEqualToValue={(a: PickerItem, b: PickerItem) => a.id === b.id}
      onValueChange={(next: PickerItem[]) => {
        const ids = new Set(next.map((i) => i.id));
        for (const i of items) {
          const was = all.includes(i.id);
          if (ids.has(i.id) !== was) onToggle(i.id, !was);
        }
      }}
    >
      <ComboboxTrigger ref={anchor} render={trigger} />
      <ComboboxPopup anchor={anchor} align="end" className="w-72">
        {items.length > 6 ? <ComboboxSearchInput placeholder={search} aria-label={search} /> : null}
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const on = all.includes(item.id);
            const part = !on && some.includes(item.id);
            return (
              <ComboboxItem key={item.id} value={item} selectedFill={false} title={item.title}>
                {item.hue != null ? <SpaceAvatar hue={item.hue} /> : null}
                <Truncate className="min-w-0 flex-1">{item.label}</Truncate>
                {part ? <span className="shrink-0 text-muted-foreground text-xs">Some parts</span> : null}
                <Icon icon={icons.check} className={cn("size-4 shrink-0 text-foreground", !on && "invisible")} />
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
