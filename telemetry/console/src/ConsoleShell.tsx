import { useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { icons } from "@/components/icons";
import { BrandWordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider } from "@/components/ui/sidebar";
import type { Session } from "./api";

export type Page = "overview" | "events" | "staff" | "preferences";
const titles: Record<Page, string> = { overview: "Overview", events: "Events", staff: "Staff access", preferences: "Preferences" };

export function ConsoleShell({ session, page, navigate, onSignOut, signingOut, signOutError, children }: { session: Session; page: Page; navigate: (page: Page) => void; onSignOut: () => void; signingOut: boolean; signOutError: string; children: ReactNode }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 768);
  const [compact, setCompact] = useState(() => window.innerWidth < 768);
  const wasCompact = useRef(compact);
  const go = (next: Page) => { navigate(next); if (compact) setOpen(false); };
  return <SidebarProvider open={open} onToggle={() => setOpen((v) => !v)} floating={compact} onCompactChange={(next) => { if (next !== wasCompact.current) { wasCompact.current = next; setCompact(next); setOpen(!next); } }} className="console-shell h-svh overflow-hidden">
    <a href="#console-content" onClick={(event) => { event.preventDefault(); document.getElementById("console-content")?.focus(); }} className="sr-only z-50 bg-background p-3 focus:not-sr-only focus:fixed">Skip to content</a>
    <Sidebar aria-label="Console sidebar">
      <SidebarHeader className="gap-2 px-5 pb-7 pt-7"><BrandWordmark markClassName="relative top-px" /><span className="text-xs text-muted-foreground">Telemetry</span></SidebarHeader>
      <SidebarContent>
        <nav aria-label="Telemetry"><SidebarGroup><SidebarGroupLabel>Workspace</SidebarGroupLabel><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton isActive={page === "overview"} aria-current={page === "overview" ? "page" : undefined} onClick={() => go("overview")} className="h-9"><Icon icon={icons.stats} className="size-4" />Overview</SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton isActive={page === "events"} aria-current={page === "events" ? "page" : undefined} onClick={() => go("events")} className="h-9"><Icon icon={icons.fileText} className="size-4" />Events</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroup>
        <SidebarGroup className="mt-6"><SidebarGroupLabel>Settings</SidebarGroupLabel><SidebarMenu>
          {session.role === "owner" ? <SidebarMenuItem><SidebarMenuButton isActive={page === "staff"} aria-current={page === "staff" ? "page" : undefined} onClick={() => go("staff")} className="h-9"><Icon icon={icons.people} className="size-4" />Staff</SidebarMenuButton></SidebarMenuItem> : null}
          <SidebarMenuItem><SidebarMenuButton isActive={page === "preferences"} aria-current={page === "preferences" ? "page" : undefined} onClick={() => go("preferences")} className="h-9"><Icon icon={icons.settings} className="size-4" />Preferences</SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroup></nav>
      </SidebarContent>
      <SidebarFooter className="h-auto gap-3 px-4 py-4"><div className="min-w-0 px-1"><p className="truncate text-sm" title={session.email}>{session.email}</p><p className="mt-1 text-xs text-muted-foreground">{session.role === "owner" ? "Super admin" : "Viewer"}</p></div><Button variant="ghost" pending={signingOut} disabled={signingOut} onClick={onSignOut} className="w-full justify-start"><Icon icon={icons.signOut} className="size-4" />Sign out</Button>{signOutError ? <p role="alert" className="px-1 text-xs text-destructive-foreground">{signOutError}</p> : null}</SidebarFooter>
    </Sidebar>
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6"><Button size="icon-sm" variant="ghost" aria-label={open ? "Close sidebar" : "Open sidebar"} aria-expanded={open} onClick={() => setOpen((v) => !v)}><Icon icon={icons.sidebar} className="size-4" /></Button><span className="text-xs text-muted-foreground">{page === "staff" || page === "preferences" ? "Settings" : "Workspace"}<span className="mx-2 text-border-strong">/</span><span className="text-foreground">{titles[page]}</span></span></div>
      <div id="console-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none"><div className="mx-auto w-full max-w-[1440px] px-5 py-7 sm:px-8 lg:px-10 lg:py-10">{children}</div></div>
    </div>
  </SidebarProvider>;
}
