import { Menu } from "@base-ui/react/menu";
import { ArrowDown01Icon, ArrowRight02Icon, GithubIcon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/icon";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatVersion, platformName, size, when } from "../format.ts";
import { REPO_URL, RELEASES_URL, type BuildState, type Platform, type Snapshot } from "../github.ts";
import { Container, PLATFORMS, type Live } from "../layout.tsx";
import { PlatformLogo } from "../logos.tsx";
import { mountShader } from "../shader.ts";
import { Chapters, WorksWith } from "./chapters.tsx";

export function HomePage({ snap, platform, now, loading }: Live) {
  return (
    <>
      <Hero snap={snap} platform={platform} loading={loading} />
      <WorksWith />
      <Chapters />
      <Facts />
      <Onward snap={snap} now={now} />
    </>
  );
}

/** The headline and download over the shader, which fades into the page behind the app's window. */
function Hero({ snap, platform, loading }: { snap: Snapshot; platform: Platform; loading: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [live, setLive] = useState(false);
  useEffect(() => mountShader(host.current!, canvas.current!, { palette: "hero", darkPalette: "hero-dark", seed: 3, onLive: setLive }), []);
  const files = snap.release?.installers.filter((i) => i.platform === platform) ?? [];
  const first = files[0];
  return (
    <section aria-labelledby="hero-title" className="relative isolate overflow-hidden pt-14">
      <div ref={host} data-stage aria-hidden className="absolute inset-x-0 top-0 -z-10 h-[78%] [mask-image:linear-gradient(to_bottom,#000_50%,transparent)] sm:h-[72%]">
        <div className="hero-art absolute inset-0" />
        <canvas ref={canvas} className={cn("absolute inset-0 size-full opacity-0 transition-opacity duration-700", live && "opacity-100")} />
      </div>
      <Container className="flex flex-col items-center pt-16 text-center sm:pt-28">
        <h1 id="hero-title" className="max-w-4xl text-balance font-medium text-[clamp(2.5rem,1.3rem+4vw,4.5rem)] text-foreground leading-[1.02] tracking-[-0.04em]">
          The AI you choose, in a workspace you own.
        </h1>
        <p className="mt-6 max-w-2xl text-pretty text-[1.0625rem] text-foreground/85 leading-relaxed sm:text-[1.1875rem]">
          Phaethon is a free app for your computer that puts your AI in one place. Use Claude, GPT or a model that runs on your own machine, and give each part of your life its own space, saved as files you keep.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <DownloadButton snap={snap} platform={platform} />
          <a href={REPO_URL} className={buttonVariants({ size: "xl", variant: "outline", shape: "pill" })}>
            <Icon icon={GithubIcon} />
            View source
          </a>
        </div>
        <p className="mt-4 h-4 text-foreground/80 text-xs tabular-nums" aria-busy={loading && !first}>
          {first && snap.release ? (
            <>
              {formatVersion(snap.release.version)} · {platform === "linux" ? first.kind : first.label} · {size(first.size)}
            </>
          ) : loading ? (
            <span className="inline-block h-3 w-44 rounded-full bg-foreground/15 motion-safe:animate-pulse" aria-label="Loading latest release" />
          ) : null}
        </p>
      </Container>
      <Container className="mt-14 pb-16 sm:mt-20 sm:pb-24">
        <AppWindow />
      </Container>
    </section>
  );
}

const primary = buttonVariants({ size: "xl", shape: "pill" });
const menuItem = "flex min-h-8 cursor-pointer select-none items-center gap-3 rounded-sm px-2 py-1 text-foreground text-sm outline-none data-highlighted:bg-accent sm:min-h-7";

/** The visitor's installer, with every other one (and the downloads page) a click away in its menu. */
function DownloadButton({ snap, platform }: { snap: Snapshot; platform: Platform }) {
  const all = snap.release?.installers ?? [];
  const first = all.find((i) => i.platform === platform);
  return (
    <div className="inline-flex">
      <a href={first?.url ?? "/download"} className={cn(primary, "rounded-r-none pr-3.5 before:rounded-r-none")}>
        <PlatformLogo platform={platform} className="size-4" />
        Download for {platformName[platform]}
      </a>
      <Menu.Root>
        <Menu.Trigger aria-label="Other downloads" className={cn(primary, "rounded-l-none border-l-ink-foreground/20 pr-3.5 pl-3 before:rounded-l-none")}>
          <Icon icon={ArrowDown01Icon} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={8} align="end" className="z-50">
            <Menu.Popup className="dropdown-glass min-w-64 origin-(--transform-origin) rounded-lg p-1 shadow-popup outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
              {PLATFORMS.map((p) => {
                const files = all.filter((i) => i.platform === p);
                if (!files.length) return null;
                return (
                  <Menu.Group key={p}>
                    <Menu.GroupLabel className="flex items-center gap-1.5 px-2 pt-2 pb-1 font-medium text-muted-foreground text-xs">
                      <PlatformLogo platform={p} className="size-3" />
                      {platformName[p]}
                    </Menu.GroupLabel>
                    {files.map((f) => (
                      <Menu.LinkItem key={f.url} href={f.url} className={menuItem}>
                        {f.label}
                        <span className="sr-only">, </span>
                        <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                          {f.kind} · {size(f.size)}
                        </span>
                      </Menu.LinkItem>
                    ))}
                  </Menu.Group>
                );
              })}
              <Menu.Separator className="mx-2 my-1 h-px bg-border" />
              <Menu.LinkItem href={all.length ? "/download" : RELEASES_URL} className={menuItem}>
                All downloads and notes
                <Icon icon={ArrowRight02Icon} className="ml-auto size-4 text-muted-foreground" />
              </Menu.LinkItem>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

/**
 * The real app's screenshot (site/scripts/shots.spec.ts) as a Mac window. The
 * shot is the window's web content, which leaves room at the top left for the
 * traffic lights the app asks for at 17 px in (src/desktop/main.ts), centred on
 * its 24 px title-bar line; they're drawn here in the shot's own units (1320
 * px across = 100cqw).
 */
function AppWindow() {
  return (
    <figure data-window className="hero-window relative mx-auto w-[175%] max-w-none overflow-hidden rounded-[max(0.75cqw,8px)] bg-background shadow-[0_40px_80px_-32px_oklch(30%_0.05_260/0.35),0_12px_24px_-12px_oklch(30%_0.05_260/0.2)] ring-1 ring-black/8 [container-type:inline-size] sm:w-full dark:shadow-[0_40px_80px_-24px_oklch(0%_0_0/0.7)] dark:ring-white/10">
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
      <span aria-hidden className="absolute top-[calc(18/1320*100cqw)] left-[calc(17/1320*100cqw)] flex gap-[calc(8/1320*100cqw)]">
        {["bg-[#ff5f57]", "bg-[#febc2e]", "bg-[#28c840]"].map((c) => (
          <span key={c} className={cn("size-[calc(12/1320*100cqw)] rounded-full ring-[0.5px] ring-black/15 ring-inset", c)} />
        ))}
      </span>
    </figure>
  );
}

const facts = [
  { title: "Open source", body: "The code is public under the MIT license, so anyone can read what it does, change it or build it themselves." },
  { title: "Keys stay with you", body: "An API key is the code a provider gives you to use its AI. Phaethon keeps yours in your computer’s password store, never in your files." },
  { title: "Accessible", body: "Everything works from the keyboard and with a screen reader, the software that reads the screen aloud. Motion stops when you turn it off." },
];

function Facts() {
  return (
    <Container className="pb-16 sm:pb-24">
      <h2 className="sr-only">Also</h2>
      <div className="grid gap-x-10 gap-y-8 sm:grid-cols-3">
        {facts.map((f, i) => (
          <div key={f.title} data-reveal="" style={{ ["--i" as string]: i }} className="border-t pt-5">
            <h3 className="font-medium text-[0.9375rem] text-foreground">{f.title}</h3>
            <p className="mt-1.5 text-pretty text-[0.9375rem] text-muted-foreground leading-relaxed">{f.body}</p>
          </div>
        ))}
      </div>
    </Container>
  );
}

/** How the latest automated checks on the code went, as the end of a sentence. */
const checksSay: Record<BuildState, string> = { passing: "passes its automated checks", failing: "is failing its automated checks", running: "is being checked now" };

/** Where to go from here: every download, and where the project stands. */
function Onward({ snap, now }: { snap: Snapshot; now?: number }) {
  const { release, build, commit } = snap;
  const cards = [
    {
      href: "/download",
      title: "Download",
      body: release ? `Version ${release.version} for macOS, Windows and Linux, or build it from source.` : "For macOS, Windows and Linux, or build it from source.",
      cta: "All downloads",
    },
    {
      href: "/status",
      title: "Status",
      body: `Pre-alpha: early and changing fast.${build ? ` The latest code ${checksSay[build.state]}` : ""}${build && commit ? `, and the last change was ${now ? "" : "on "}${when(commit.at, now)}.` : build ? "." : ""}`,
      cta: "Status and roadmap",
    },
  ];
  return (
    <section aria-label="More" className="pb-16 sm:pb-24">
      <Container className="grid gap-4 md:grid-cols-2">
        {cards.map((c) => (
          <Card key={c.href} variant="interactive" render={<a href={c.href} />} className="group gap-2 p-6 sm:p-8">
            <h2 className="type-title">{c.title}</h2>
            <p className="text-pretty text-[0.9375rem] text-muted-foreground">{c.body}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 font-medium text-foreground text-sm">
              {c.cta}
              <Icon icon={ArrowRight02Icon} className="size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Card>
        ))}
      </Container>
    </section>
  );
}
