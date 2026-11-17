// Glyphs by name rather than through the app's icon map (components/icons.ts), which would bundle all of them; same glyphs.
import { AppleIcon, ComputerTerminal01Icon, GithubIcon, WindowsNewIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect, useState, type ReactNode } from "react";
import { BrandMark, BrandWordmark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { detectPlatform, when } from "./format.ts";
import { merge, REPO_URL, snapshot, type Platform, type Snapshot } from "./github.ts";

export const platformIcon: Record<Platform, IconSvgElement> = { mac: AppleIcon, windows: WindowsNewIcon, linux: ComputerTerminal01Icon };
export const PLATFORMS = ["mac", "windows", "linux"] as const;
const CACHE = "phaethon.snapshot.2";

export type Live = { snap: Snapshot; platform: Platform; now?: number };

/**
 * The project's state: what the build read from GitHub at first (so the server
 * render and the first client render match), then this visitor's platform,
 * relative times and a fresh read, cached for the tab for five minutes.
 */
export function useLive(built: Snapshot): Live {
  const [snap, setSnap] = useState(built);
  const [platform, setPlatform] = useState<Platform>("mac");
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setPlatform(detectPlatform());
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    let cached: Snapshot | null = null;
    try {
      const v = JSON.parse(sessionStorage.getItem(CACHE) ?? "null") as Snapshot | null;
      if (v && Date.now() - Date.parse(v.fetched) < 5 * 60_000) cached = v;
    } catch {
      // storage blocked: read GitHub instead
    }
    let stale = false;
    if (cached) setSnap(merge(built, cached));
    else
      void snapshot().then((live) => {
        if (stale) return;
        const next = merge(built, live);
        setSnap(next);
        try {
          if (live.release) sessionStorage.setItem(CACHE, JSON.stringify(next));
        } catch {
          // private mode: read it again next time
        }
      });
    return () => {
      stale = true;
      clearInterval(tick);
    };
  }, [built]);
  return { snap, platform, now };
}

export function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-8", className)}>{children}</div>;
}

export function Time({ iso, now }: { iso: string; now?: number }) {
  return <time dateTime={iso}>{when(iso, now)}</time>;
}

export const textLink = "text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground";

export type Route = "home" | "download" | "status";

/** Skip link, header, the page, footer. `bleed` lets the page draw under the header (the home hero's art). */
export function Shell({ route, stars, bleed, children }: { route: Route; stars: number | null; bleed?: boolean; children: ReactNode }) {
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-ink-foreground">
        Skip to content
      </a>
      <Nav route={route} stars={stars} />
      <main id="main" className={cn(bleed && "-mt-14")}>
        {children}
      </main>
      <Footer />
    </>
  );
}

// Not the muted grey: on the home page these sit on the hero's art, where grey text gets too faint.
const navLink = cn(buttonVariants({ variant: "ghost", size: "sm", shape: "pill" }), "text-foreground/75 hover:text-foreground dark:text-foreground/85");

function Nav({ route, stars }: { route: Route; stars: number | null }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 8);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  const page = (to: Route, href: string, label: string) => (
    <a href={href} aria-current={route === to ? "page" : undefined} className={cn(navLink, "aria-[current=page]:text-foreground")}>
      {label}
    </a>
  );
  return (
    <header className={cn("sticky top-0 z-40 border-b border-transparent transition-colors duration-200", scrolled && "border-border bg-background/80 backdrop-blur-xl")}>
      <Container className="flex h-14 items-center justify-between gap-4">
        <a href="/" aria-label="Phaethon, home" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BrandWordmark markClassName="relative top-px" />
        </a>
        <nav aria-label="Site" className="flex items-center gap-1">
          {page("download", "/download", "Download")}
          {page("status", "/status", "Status")}
          <a href={REPO_URL} className={navLink} aria-label={stars === null ? "GitHub" : `GitHub, ${stars} ${stars === 1 ? "star" : "stars"}`}>
            <Icon icon={GithubIcon} />
            <span className="max-sm:sr-only">GitHub</span>
            {stars === null ? null : <span className="type-live">{stars}</span>}
          </a>
        </nav>
      </Container>
    </header>
  );
}

function Footer() {
  const links = [
    ["Download", "/download"],
    ["Status", "/status"],
    ["Source", REPO_URL],
    ["Issues", `${REPO_URL}/issues`],
    ["License", `${REPO_URL}/blob/main/LICENSE`],
  ] as const;
  return (
    <footer className="border-t">
      <Container className="flex flex-wrap items-center justify-between gap-4 py-8 text-muted-foreground text-sm">
        <span className="flex items-center gap-2">
          <BrandMark className="size-3.5 text-foreground" />
          MIT licensed. Made by Jeryn Vicari.
        </span>
        <nav aria-label="Project" className="flex flex-wrap gap-x-5 gap-y-2">
          {links.map(([label, href]) => (
            <a key={label} href={href} className="hover:text-foreground">
              {label}
            </a>
          ))}
        </nav>
      </Container>
    </footer>
  );
}

/** A page's title block: big heading, then a line under it. */
export function PageHead({ title, children, center }: { title: ReactNode; children?: ReactNode; center?: boolean }) {
  return (
    <div className={cn("flex flex-col gap-3", center && "items-center text-center")}>
      <h1 className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 font-medium text-[clamp(2.25rem,1.6rem+2.2vw,3.25rem)] text-foreground leading-[1.05] tracking-[-0.035em]", center && "justify-center")}>
        {title}
      </h1>
      {children ? <div className="text-[0.9375rem] text-muted-foreground">{children}</div> : null}
    </div>
  );
}

export function SectionTitle({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <h2 id={id} className={cn("font-medium text-[1.5rem] text-foreground leading-tight tracking-[-0.025em] sm:text-[1.75rem]", className)}>
      {children}
    </h2>
  );
}
