import { useRef, useState } from "react";
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxRoot, ComboboxSearch } from "vic-ui";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/menu";
import { Icon } from "@/icons";
import { NEW_SPACE_EVENT } from "@/lib/chat-actions";
import { useSpaces } from "@/lib/spaces";
import { startWorkspaceFromFolder } from "@/lib/workspace";
import { SpaceMark } from "./space-mark";

/** T3 DraftHeroHeadline's inline project choice, using Vic's real query/keyboard controller. */
export function WorkspacePicker({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const { spaces } = useSpaces();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const matched = spaces.filter(space => space.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const items = [...matched.map(space => ({ value: space.id, label: space.name })), { value: "$folder", label: "Open folder…" }, { value: "$new", label: "New space" }];
  const select = (id: string) => {
    setOpen(false); setError("");
    if (id === "$folder") void startWorkspaceFromFolder().catch(e => setError(String(e)));
    else if (id === "$new") window.dispatchEvent(new Event(NEW_SPACE_EVENT));
    else window.dispatchEvent(new CustomEvent("phaethon:choose-space", { detail: id }));
  };
  return <span className="inline-flex max-w-full flex-col items-start align-baseline">
    <Popover.Root open={open} onOpenChange={value => { setOpen(value); if (!value) setQuery(""); }}>
      <Popover.Trigger asChild><Button type="button" variant="ghost" size="sm" data-empty-workspace="" aria-label={`Workspace: ${spaceName}`} className="h-auto! max-w-full px-1! py-0.5! text-inherit! font-medium!">
        <span className="truncate">{spaceName}</span><Icon name="chevron-down" className="size-3.5 text-ink-secondary" />
      </Button></Popover.Trigger>
      <Popover.Portal><Popover.Content align="start" sideOffset={6} className="z-50 w-72 max-w-[calc(100vw-2rem)] p-1.5!" aria-label="Choose workspace" onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus(); }} data-workspace-picker="">
        <ComboboxRoot label="Choose workspace" items={items} value={spaceId} onValueChange={select} query={query} onQueryChange={setQuery} open={open} onOpenChange={setOpen}>
          <ComboboxSearch ref={input} placeholder="Find a space…" className="mb-1 w-full" />
          <ComboboxList className="max-h-64 overflow-auto">
            {matched.map(space => <ComboboxItem key={space.id} value={space.id} data-choose-workspace={space.id} className="flex items-center gap-2 text-sm font-normal"><SpaceMark hue={space.hue} /><span className="min-w-0 flex-1 truncate">{space.name}</span>{space.id === spaceId && <Icon name="check" className="size-3.5 text-ink-secondary" />}</ComboboxItem>)}
            <ComboboxItem value="$folder" data-workspace-open-folder="" className="flex items-center gap-2 text-sm font-normal"><Icon name="folder-plus" className="size-3.5 text-ink-secondary" />Open folder…</ComboboxItem>
            <ComboboxItem value="$new" className="flex items-center gap-2 text-sm font-normal"><Icon name="plus" className="size-3.5 text-ink-secondary" />New space</ComboboxItem>
          </ComboboxList>
          <ComboboxEmpty>No matching spaces</ComboboxEmpty>
        </ComboboxRoot>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {error && <span role="alert" className="mt-1 text-xs font-normal text-danger-ink">{error}</span>}
  </span>;
}
