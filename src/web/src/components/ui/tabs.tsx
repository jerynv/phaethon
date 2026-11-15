"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn-style tabs on Base UI. The segmented look (a muted track with a
 * raised pill that slides to the selected tab) is the only variant the app
 * uses. Panels are optional: the view switcher has none.
 */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

function TabsList({ className, children, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List data-slot="tabs-list" className={cn("relative z-0 inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5", className)} {...props}>
      {children}
      <TabsPrimitive.Indicator
        data-slot="tabs-indicator"
        className="absolute top-(--active-tab-top) left-(--active-tab-left) -z-10 h-(--active-tab-height) w-(--active-tab-width) rounded-md bg-background shadow-xs/5 transition-[left,width] duration-200 ease-out dark:bg-accent"
      />
    </TabsPrimitive.List>
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "flex h-6 items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
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
