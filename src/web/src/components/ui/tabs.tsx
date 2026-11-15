"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The one way to pick one of a few things (docs/UI-REBUILD.md › Primitives ›
 * Tabs): a grey track with a flat pill that slides to the chosen tab. It is
 * the title bar's view switcher, a page's section tabs, and any value choice
 * ("1W · 1M · All", "Quiz · Cards"). Panels are optional.
 */
type Size = "sm" | "default";
const TabsSize = React.createContext<Size>("default");

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({ className, children, size = "default", ...props }: TabsPrimitive.List.Props & { size?: Size }) {
  return (
    <TabsSize value={size}>
      <TabsPrimitive.List data-slot="tabs-list" className={cn("relative z-0 inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)} {...props}>
        {children}
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className="absolute top-(--active-tab-top) left-(--active-tab-left) -z-10 h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-background transition-[left,width] duration-200 ease-out-soft dark:bg-accent"
        />
      </TabsPrimitive.List>
    </TabsSize>
  );
}

const TAB: Record<Size, string> = {
  sm: "h-6 px-2.5 text-xs [&_svg]:size-3.5",
  default: "h-7 px-3 text-sm [&_svg]:size-4",
};

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  const size = React.use(TabsSize);
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "flex min-w-0 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground [&_svg]:shrink-0",
        TAB[size],
        className,
      )}
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-panel" className={cn("outline-none", className)} {...props} />;
}

export { Tabs, TabsList, TabsPanel, TabsTab };
export type TabsValue = React.ComponentProps<typeof TabsPrimitive.Root>["value"];
