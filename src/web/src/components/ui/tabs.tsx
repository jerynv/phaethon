"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * shadcn-style tabs on Base UI, in the references' three looks
 * (docs/UI-REBUILD.md › Primitives):
 *
 * - `segmented` (default): a grey track with a white pill that slides to the
 *   selected tab ("Wiki · Properties · Sources", "Pending · Dismissed").
 * - `pill`: no track; the selected tab sits on a light grey pill. The title
 *   bar's view switcher ("Chat · Agent · Code").
 * - `underline`: text tabs over a hairline with a 2 px ink bar ("Crawl links ·
 *   Individual", "Editor · Runs").
 *
 * Panels are optional: the view switcher has none.
 */
type Variant = "segmented" | "pill" | "underline";
type Size = "sm" | "default";
const TabsStyle = React.createContext<{ variant: Variant; size: Size }>({ variant: "segmented", size: "default" });

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props} />;
}

const LIST: Record<Variant, string> = {
  segmented: "gap-0.5 rounded-lg bg-muted p-0.5",
  pill: "gap-0.5",
  underline: "gap-5 border-b",
};

const INDICATOR: Record<Variant, string> = {
  segmented: "top-(--active-tab-top) h-(--active-tab-height) rounded-md bg-background shadow-raised dark:bg-accent",
  pill: "top-(--active-tab-top) h-(--active-tab-height) rounded-lg bg-row-selected",
  underline: "-bottom-px h-0.5 rounded-full bg-foreground",
};

function TabsList({ className, children, variant = "segmented", size = "default", ...props }: TabsPrimitive.List.Props & { variant?: Variant; size?: Size }) {
  const style = React.useMemo(() => ({ variant, size }), [variant, size]);
  return (
    <TabsStyle value={style}>
      <TabsPrimitive.List data-slot="tabs-list" data-variant={variant} className={cn("relative z-0 inline-flex items-center", LIST[variant], className)} {...props}>
        {children}
        <TabsPrimitive.Indicator
          data-slot="tabs-indicator"
          className={cn("absolute left-(--active-tab-left) -z-10 w-(--active-tab-width) transition-[left,width] duration-200 ease-out-soft", INDICATOR[variant])}
        />
      </TabsPrimitive.List>
    </TabsStyle>
  );
}

const TAB: Record<Variant, Record<Size, string>> = {
  segmented: {
    sm: "h-6 rounded-md px-2.5 text-xs [&_svg]:size-3.5",
    default: "h-7 rounded-md px-3 text-sm [&_svg]:size-4",
  },
  pill: {
    sm: "h-6 rounded-md px-2 text-xs [&_svg]:size-3.5",
    default: "h-7 rounded-lg px-2.5 text-sm [&_svg]:size-4",
  },
  underline: {
    sm: "h-8 text-xs [&_svg]:size-3.5",
    default: "h-9 text-sm [&_svg]:size-4",
  },
};

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  const { variant, size } = React.use(TabsStyle);
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={cn(
        "flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:text-foreground [&_svg]:shrink-0",
        variant === "underline" ? "font-normal data-active:font-medium" : "font-medium",
        TAB[variant][size],
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
