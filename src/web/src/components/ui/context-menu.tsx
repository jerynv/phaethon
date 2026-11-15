// Right-click menus on Base UI's ContextMenu, drawn like `menu.tsx`. Items, groups,
// separators and submenus are the menu's own parts (Base UI shares them).
import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";

import { cn } from "@/lib/utils";
import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "./menu";

const ContextMenu = ContextMenuPrimitive.Root;

function ContextMenuTrigger({ className, ...props }: ContextMenuPrimitive.Trigger.Props) {
  return <ContextMenuPrimitive.Trigger className={className} data-slot="context-menu-trigger" {...props} />;
}

function ContextMenuPopup({ className, children, ...props }: ContextMenuPrimitive.Popup.Props) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-(--z-popup)" data-slot="context-menu-positioner">
        <ContextMenuPrimitive.Popup
          className={cn(
            "dropdown-glass relative flex min-w-[min(--spacing(40),var(--viewport-max-width))] max-w-(--viewport-max-width) origin-(--transform-origin) rounded-lg outline-none focus:outline-none dark:shadow-none",
            "[-webkit-app-region:no-drag]",
            "transition-[opacity,scale] duration-150 ease-out data-[ending-style]:duration-100 data-[ending-style]:scale-95 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            className,
          )}
          data-slot="context-menu-popup"
          {...props}
        >
          <div className="max-h-(--available-height) w-full overflow-y-auto p-1">{children}</div>
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuPopup,
  MenuItem as ContextMenuItem,
  MenuCheckboxItem as ContextMenuCheckboxItem,
  MenuRadioGroup as ContextMenuRadioGroup,
  MenuRadioItem as ContextMenuRadioItem,
  MenuGroup as ContextMenuGroup,
  MenuGroupLabel as ContextMenuGroupLabel,
  MenuSeparator as ContextMenuSeparator,
  MenuShortcut as ContextMenuShortcut,
  MenuItemDetail as ContextMenuItemDetail,
  MenuSub as ContextMenuSub,
  MenuSubTrigger as ContextMenuSubTrigger,
  MenuSubPopup as ContextMenuSubPopup,
};
