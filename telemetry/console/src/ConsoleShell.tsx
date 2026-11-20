import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Icon, type IconData } from "@/components/icon";
import { icons } from "@/components/icons";
import { BrandWordmark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { roleName, type Session } from "./api";

export type Page = "overview" | "events" | "staff" | "preferences";

const TITLES: Record<Page, string> = {
  overview: "Overview",
  events: "Events",
  staff: "Staff access",
  preferences: "Preferences",
};

type NavItem = { page: Page; label: string; icon: IconData; ownerOnly?: boolean };

const NAV: { label: string; className?: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { page: "overview", label: "Overview", icon: icons.stats },
      { page: "events", label: "Events", icon: icons.fileText },
    ],
  },
  {
    label: "Settings",
    className: "mt-6",
    items: [
      { page: "staff", label: "Staff", icon: icons.people, ownerOnly: true },
      { page: "preferences", label: "Preferences", icon: icons.settings },
    ],
  },
];

const isCompact = () => window.innerWidth < 768;

export function ConsoleShell({
  session,
  page,
  navigate,
  onSignOut,
  signingOut,
  signOutError,
  children,
}: {
  session: Session;
  page: Page;
  navigate: (page: Page) => void;
  onSignOut: () => void;
  signingOut: boolean;
  signOutError: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !isCompact());
  const [compact, setCompact] = useState(isCompact);
  const wasCompact = useRef(compact);
  const toggle = () => setOpen((value) => !value);
  const section = NAV.find((group) => group.items.some((item) => item.page === page))!.label;

  const go = (next: Page) => {
    navigate(next);
    if (compact) setOpen(false);
  };
  // Only crossing the breakpoint resets the sidebar; resizing within a layout keeps what the user chose.
  const compactChanged = (next: boolean) => {
    if (next === wasCompact.current) return;
    wasCompact.current = next;
    setCompact(next);
    setOpen(!next);
  };
  const skipToContent = (event: MouseEvent) => {
    event.preventDefault();
    document.getElementById("console-content")?.focus();
  };

  return (
    <SidebarProvider
      open={open}
      onToggle={toggle}
      floating={compact}
      onCompactChange={compactChanged}
      className="console-shell h-svh overflow-hidden"
    >
      <a
        href="#console-content"
        onClick={skipToContent}
        className="sr-only z-50 bg-background p-3 focus:not-sr-only focus:fixed"
      >
        Skip to content
      </a>
      <Sidebar aria-label="Console sidebar">
        <SidebarHeader className="gap-2 px-5 pb-7 pt-7">
          <BrandWordmark markClassName="relative top-px" />
          <span className="text-xs text-muted-foreground">Telemetry</span>
        </SidebarHeader>
        <SidebarContent>
          <nav aria-label="Telemetry">
            {NAV.map((group) => (
              <SidebarGroup key={group.label} className={group.className}>
                <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
                <SidebarMenu>
                  {group.items
                    .filter((item) => !item.ownerOnly || session.role === "owner")
                    .map((item) => (
                      <SidebarMenuItem key={item.page}>
                        <SidebarMenuButton
                          isActive={page === item.page}
                          aria-current={page === item.page ? "page" : undefined}
                          onClick={() => go(item.page)}
                          className="h-9"
                        >
                          <Icon icon={item.icon} className="size-4" />
                          {item.label}
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
        <SidebarFooter className="h-auto gap-3 px-4 py-4">
          <div className="min-w-0 px-1">
            <p className="truncate text-sm" title={session.email}>
              {session.email}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{roleName(session.role)}</p>
          </div>
          <Button
            variant="ghost"
            pending={signingOut}
            disabled={signingOut}
            onClick={onSignOut}
            className="w-full justify-start"
          >
            <Icon icon={icons.signOut} className="size-4" />
            Sign out
          </Button>
          {signOutError ? (
            <p role="alert" className="px-1 text-xs text-destructive-foreground">
              {signOutError}
            </p>
          ) : null}
        </SidebarFooter>
      </Sidebar>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <div className="flex h-14 shrink-0 items-center gap-3 border-b px-4 sm:px-6">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={open ? "Close sidebar" : "Open sidebar"}
            aria-expanded={open}
            onClick={toggle}
          >
            <Icon icon={icons.sidebar} className="size-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {section}
            <span className="mx-2 text-border-strong">/</span>
            <span className="text-foreground">{TITLES[page]}</span>
          </span>
        </div>
        <div id="console-content" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div className="mx-auto w-full max-w-[1440px] px-5 py-7 sm:px-8 lg:px-10 lg:py-10">{children}</div>
        </div>
      </div>
    </SidebarProvider>
  );
}
