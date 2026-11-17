// Glyphs by name rather than through the app's icon map (components/icons.ts), which would bundle all of them; same glyphs.
import { AppleIcon, ArrowRight02Icon, ComputerTerminal01Icon, Copy01Icon, Download01Icon, GithubIcon, LinkSquare02Icon, Tick02Icon, WindowsNewIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArtCanvas } from "@/components/art";
import { BrandMark, BrandWordmark } from "@/components/brand-mark";
import { Icon } from "@/components/icon";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { detectPlatform, platformName, size, when } from "./format.ts";
import { merge, REPO_URL, RELEASES_URL, snapshot, type Installer, type Platform, type Snapshot } from "./github.ts";
import { mountShader } from "./shader.ts";

const platformIcon: Record<Platform, IconSvgElement> = { mac: AppleIcon, windows: WindowsNewIcon, linux: ComputerTerminal01Icon };
const PLATFORMS = ["mac", "windows", "linux"] as const;
const CLONE = `git clone ${REPO_URL} && cd phaethon && pnpm install && pnpm dev`;
const CACHE = "phaethon.snapshot";

/**
 * The project's state: what the build read from GitHub at first (so the server
 * render and the first client render match), then this visitor's platform,
 * relative times and a fresh read, cached for the tab for five minutes.
 */
function useLive(built: Snapshot) {
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

export function Page({ built }: { built: Snapshot }) {
  const { snap, platform, now } = useLive(built);
  return (
    <>
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-2 focus:text-ink-foreground">
        Skip to content
      </a>
      <Nav stars={snap.stars} />
      <main id="main">
        <Hero snap={snap} platform={platform} />
        <Stage />
        <Facts />
        <Downloads snap={snap} platform={platform} now={now} />
        <Status snap={snap} now={now} />
      </main>
      <Footer />
    </>
  );
}

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto w-full max-w-6xl px-4 sm:px-8", className)}>{children}</div>;
}

function Time({ iso, now }: { iso: string; now?: number }) {
  return <time dateTime={iso}>{when(iso, now)}</time>;
}

const navLink = buttonVariants({ variant: "ghost-muted", size: "sm", shape: "pill" });

function Nav({ stars }: { stars: number | null }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(scrollY > 8);
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);
  return (
    <header className={cn("sticky top-0 z-40 border-b border-transparent transition-colors duration-200", scrolled && "border-border bg-background/80 backdrop-blur-xl")}>
      <Container className="flex h-14 items-center justify-between gap-4">
        <a href="/" aria-label="Phaethon, home" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <BrandWordmark markClassName="relative top-px" />
        </a>
        <nav aria-label="Site" className="flex items-center gap-1">
          <a href="#download" className={cn(navLink, "max-sm:hidden")}>
            Download
          </a>
          <a href="#status" className={cn(navLink, "max-sm:hidden")}>
            Status
          </a>
          <a href={REPO_URL} className={navLink} aria-label={stars === null ? "GitHub" : `GitHub, ${stars} ${stars === 1 ? "star" : "stars"}`}>
            <Icon icon={GithubIcon} />
            GitHub
            {stars === null ? null : <span className="type-live text-subtle-foreground">{stars}</span>}
          </a>
        </nav>
      </Container>
    </header>
  );
}

function Hero({ snap, platform }: { snap: Snapshot; platform: Platform }) {
  const files = snap.release?.installers.filter((i) => i.platform === platform) ?? [];
  const [first, second] = files;
  return (
    <Container className="pt-16 pb-12 sm:pt-28 sm:pb-16">
      <h1 className="max-w-3xl text-balance font-medium text-[clamp(2.5rem,1.4rem+3.6vw,4.25rem)] text-foreground leading-[1.02] tracking-[-0.04em]">
        A desktop workspace for the AI you choose.
      </h1>
      <p className="mt-6 max-w-xl text-pretty text-[1.0625rem] text-muted-foreground leading-relaxed sm:text-lg/relaxed sm:text-[1.1875rem]">
        Phaethon is an open-source app for Claude, GPT, local models and the coding agents you already use, with each part of your life kept in its own space.
      </p>
      <div className="mt-9 flex flex-wrap items-center gap-3">
        <a href={first?.url ?? RELEASES_URL} className={buttonVariants({ size: "xl", shape: "pill" })}>
          <Icon icon={platformIcon[platform]} />
          Download for {platformName[platform]}
        </a>
        <a href={REPO_URL} className={buttonVariants({ size: "xl", variant: "outline", shape: "pill" })}>
          <Icon icon={GithubIcon} />
          View source
        </a>
      </div>
      {first && snap.release ? (
        <p className="mt-4 text-xs text-muted-foreground tabular-nums">
          v{snap.release.version} · {first.label}
          {platform === "mac" ? "" : ` ${first.kind}`} · {size(first.size)}
          {platform === "mac" && second ? (
            <>
              {" · "}
              <a className="underline decoration-border-strong underline-offset-2 hover:text-foreground" href={second.url}>
                {second.label}
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </Container>
  );
}

/** The app in the hero's art: the app's CSS mesh first, then the shader over it once WebGL draws. */
function Stage() {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => mountShader(host.current!, canvas.current!, { palette: "dawn", darkPalette: "lilac", seed: 3, onLive: setLive }), []);
  return (
    <Container>
      <div ref={host} data-stage className="relative aspect-[5/4] overflow-hidden rounded-panel border sm:aspect-[16/9]">
        <ArtCanvas palette="dawn" seed="stage" grain="subtle" className="absolute inset-0" />
        <canvas ref={canvas} aria-hidden className={cn("absolute inset-0 size-full opacity-0 transition-opacity duration-700", live && "opacity-100")} />
        <figure data-window className="absolute top-[8%] left-[6%] w-[190%] overflow-hidden rounded-tl-xl shadow-[0_40px_80px_-32px_oklch(30%_0.05_260/0.35),0_12px_24px_-12px_oklch(30%_0.05_260/0.2)] ring-1 ring-black/5 sm:top-[11%] sm:left-[8.5%] sm:w-full dark:shadow-[0_40px_80px_-24px_oklch(0%_0_0/0.7)] dark:ring-white/8">
          <picture>
            <source srcSet="/shots/chat-dark.webp" media="(prefers-color-scheme: dark)" />
            <img
              src="/shots/chat-light.webp"
              width={2640}
              height={1480}
              className="block h-auto w-full"
              alt="Phaethon's chat in a space called School: the agent explains why strong induction needs two base cases, with the math typeset, and asks a follow-up question."
            />
          </picture>
        </figure>
      </div>
    </Container>
  );
}

const facts = [
  { title: "Plain files", body: "A vault is a folder on your computer. Back it up or sync it with iCloud Drive, git or Syncthing." },
  { title: "Walled-off spaces", body: "An agent in your school space can't read your work space, and it asks before it changes a file." },
  { title: "Accessible", body: "Everything works from the keyboard and with a screen reader, and motion stops when you turn it off." },
];

function Facts() {
  return (
    <Container className="py-16 sm:py-24">
      <h2 className="sr-only">What it is</h2>
      <div className="grid gap-x-10 gap-y-8 sm:grid-cols-3">
        {facts.map((f) => (
          <div key={f.title} className="border-t pt-5">
            <h3 className="font-medium text-[0.9375rem] text-foreground">{f.title}</h3>
            <p className="mt-1.5 text-pretty text-[0.9375rem] text-muted-foreground leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </Container>
  );
}

function SectionHead({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-2">
      <h2 id={id} className="flex items-center gap-3 font-medium text-[1.75rem] text-foreground leading-tight tracking-[-0.025em]">
        {title}
      </h2>
      <div className="text-[0.9375rem] text-muted-foreground">{children}</div>
    </div>
  );
}

const notes: Partial<Record<Platform, ReactNode>> = {
  mac: (
    <>
      Not notarized yet. The first time, choose <b className="font-medium text-foreground">Open Anyway</b> in System Settings › Privacy &amp; Security.
    </>
  ),
  windows: "Not signed yet, so SmartScreen may ask once.",
};

function InstallerRow({ file }: { file: Installer }) {
  return (
    <li>
      <a href={file.url} download className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <span className="font-medium text-foreground text-sm">{file.label}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {file.kind} · {size(file.size)}
        </span>
        <Icon icon={Download01Icon} className="size-4 text-subtle-foreground group-hover:text-foreground" />
      </a>
    </li>
  );
}

function Downloads({ snap, platform, now }: { snap: Snapshot; platform: Platform; now?: number }) {
  const all = snap.release?.installers ?? [];
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(CLONE);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <section id="download" aria-labelledby="download-title" className="scroll-mt-20 border-t py-16 sm:py-24">
      <Container>
        <SectionHead id="download-title" title="Download">
          {snap.release ? (
            <>
              Version {snap.release.version}, released <Time iso={snap.release.published} now={now} /> ·{" "}
              <a className="text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground" href={snap.release.url}>
                Release notes
              </a>
            </>
          ) : (
            <a className="text-foreground underline underline-offset-4" href={RELEASES_URL}>
              Latest release on GitHub
            </a>
          )}
        </SectionHead>
        <div className="grid gap-4 md:grid-cols-3">
          {PLATFORMS.map((p) => {
            const files = all.filter((i) => i.platform === p);
            return (
              <Card key={p} className={cn("gap-4 p-5", p === platform && "border-border-strong")}>
                <div className="flex items-center gap-2.5">
                  <Icon icon={platformIcon[p]} className="size-5 text-foreground" />
                  <h3 className="type-heading">{platformName[p]}</h3>
                  {p === platform ? (
                    <Badge variant="secondary" size="lg" className="ml-auto">
                      This computer
                    </Badge>
                  ) : null}
                </div>
                <ul className="flex flex-col">
                  {files.length ? (
                    files.map((f) => <InstallerRow key={f.url} file={f} />)
                  ) : (
                    <li>
                      <a href={RELEASES_URL} className="-mx-2 flex items-center gap-3 rounded-lg px-2 py-2 text-foreground text-sm hover:bg-accent">
                        Release page
                        <Icon icon={LinkSquare02Icon} className="ml-auto size-4 text-subtle-foreground" />
                      </a>
                    </li>
                  )}
                </ul>
                {notes[p] ? <p className="mt-auto text-pretty text-muted-foreground text-sm">{notes[p]}</p> : null}
              </Card>
            );
          })}
        </div>
        <div className="mt-10 flex flex-col gap-2.5">
          <h3 className="font-medium text-muted-foreground text-xs">Build from source with Node 22 and pnpm</h3>
          <div className="flex items-center gap-2 rounded-xl border bg-well py-1.5 pr-1.5 pl-4">
            <code tabIndex={0} className="scroll-quiet min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-sm py-1 text-foreground text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {CLONE}
            </code>
            <button type="button" className={buttonVariants({ variant: "ghost", size: "icon-sm", shape: "rect" })} aria-label={copied ? "Copied" : "Copy command"} onClick={() => void copy()}>
              <Icon icon={copied ? Tick02Icon : Copy01Icon} />
            </button>
            <span role="status" className="sr-only">
              {copied ? "Copied" : ""}
            </span>
          </div>
        </div>
      </Container>
    </section>
  );
}

const buildWord = { passing: "Passing", failing: "Failing", running: "Running" } as const;
const buildDot = { passing: "bg-success", failing: "bg-destructive", running: "bg-warning motion-safe:animate-pulse" } as const;

function Row({ label, href, children }: { label: string; href: string; children: ReactNode }) {
  return (
    <li>
      <a href={href} className="group flex items-center gap-4 px-5 py-3.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:flex-wrap max-sm:gap-y-1">
        <span className="w-32 shrink-0 text-muted-foreground text-sm max-sm:w-full">{label}</span>
        <span className="flex min-w-0 flex-1 items-center gap-3 text-foreground text-sm">{children}</span>
        <Icon icon={ArrowRight02Icon} className="size-4 shrink-0 text-subtle-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground max-sm:hidden" />
      </a>
    </li>
  );
}

const roadmap = [
  { lane: "Next", items: ["Signed and notarized builds", "An alpha with disabled testers", "Sync conflicts you can see and resolve"] },
  { lane: "Later", items: ["Your phone, served by your desktop over Tailscale", "An optional hosted sync relay", "Hosted model credits, for when you'd rather not bring a key"] },
];

function Status({ snap, now }: { snap: Snapshot; now?: number }) {
  const { release, build, commit, issues } = snap;
  return (
    <section id="status" aria-labelledby="status-title" className="scroll-mt-20 border-t py-16 sm:py-24">
      <Container>
        <SectionHead
          id="status-title"
          title={
            <>
              Status
              <Badge variant="warning" size="lg">
                Pre-alpha
              </Badge>
            </>
          }
        >
          Fine to try. Not yet for data you can't lose.
        </SectionHead>
        <Card render={<ul aria-live="polite" />} className="divide-y">
          {release ? (
            <Row label="Latest release" href={release.url}>
              <span className="type-live">v{release.version}</span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                <Time iso={release.published} now={now} />
              </span>
            </Row>
          ) : null}
          {build ? (
            <Row label="Build on main" href={build.url}>
              <span className="inline-flex items-center gap-2">
                <span aria-hidden className={cn("size-1.5 rounded-full", buildDot[build.state])} />
                {buildWord[build.state]}
              </span>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                <Time iso={build.at} now={now} />
              </span>
            </Row>
          ) : null}
          {commit ? (
            <Row label="Latest change" href={commit.url}>
              <span className="min-w-0 truncate">{commit.message}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                <span className="type-live">{commit.sha}</span> · <Time iso={commit.at} now={now} />
              </span>
            </Row>
          ) : null}
          {issues === null ? null : (
            <Row label="Open issues" href={`${REPO_URL}/issues`}>
              <span className="type-live">{issues}</span>
            </Row>
          )}
        </Card>
        <div className="mt-12 grid gap-10 sm:grid-cols-2">
          {roadmap.map((r) => (
            <div key={r.lane}>
              <h3 className="font-medium text-muted-foreground text-xs">{r.lane}</h3>
              <ul className="mt-3 flex flex-col gap-2 text-[0.9375rem] text-foreground">
                {r.items.map((item) => (
                  <li key={item} className="text-pretty">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

function Footer() {
  const links = [
    ["Source", REPO_URL],
    ["Releases", `${REPO_URL}/releases`],
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
        <nav aria-label="Project" className="flex gap-5">
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
