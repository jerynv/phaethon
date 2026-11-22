import { ArrowUpRight01Icon, Copy01Icon, Download01Icon, SourceCodeIcon, SparklesIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useState, type ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatVersion, platformName, size } from "../format.ts";
import { NIGHTLY_URL, REPO_URL, RELEASES_URL, type Installer, type NightlyRelease, type Platform } from "../github.ts";
import { Container, PageHead, PLATFORMS, textLink, Time, type Live } from "../layout.tsx";
import { PlatformLogo } from "../logos.tsx";

/** Every installer, by platform, then the signed nightly channel and two ways to build it yourself. */
export function DownloadPage({ snap, now, loading }: Live) {
  const release = snap.release;
  const all = release?.installers ?? [];
  return (
    <>
      <Container className="max-w-4xl pt-16 pb-12 sm:pt-24">
        <PageHead
          center
          title={
            <>
              <span className="flex max-sm:basis-full max-sm:justify-center">
                <img src="/icon.png" width={256} height={256} alt="" className="size-14 sm:size-16" />
              </span>
              Download Phaethon
            </>
          }
        >
          <span className="inline-flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1">
            {release ? (
              <a href={release.url} className="inline-flex items-center gap-1 rounded-sm tabular-nums hover:text-foreground">
                {formatVersion(release.version)}, <Time iso={release.published} now={now} />
                <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
              </a>
            ) : loading ? (
              <span className="inline-block h-4 w-36 rounded-full bg-muted motion-safe:animate-pulse" aria-label="Loading latest release" />
            ) : (
              <a href={RELEASES_URL} className={textLink}>
                Latest release on GitHub
              </a>
            )}
            <span aria-hidden className="text-border-strong">
              ·
            </span>
            <a href="#nightly" className={textLink}>
              Signed nightly
            </a>
          </span>
        </PageHead>
      </Container>
      <Container className="flex max-w-4xl flex-col gap-14 pb-16 sm:pb-20">
        {PLATFORMS.map((p) => (
          <PlatformSection key={p} platform={p} files={all.filter((i) => i.platform === p)} loading={loading && !release} />
        ))}
        <NightlySection nightly={snap.nightly} now={now} loading={loading && !snap.nightly} />
      </Container>
      <FromSource />
    </>
  );
}

const platformHeading = "flex items-center gap-2.5 border-b pb-3 font-medium text-foreground text-xl tracking-[-0.015em]";

function PlatformSection({ platform, files, loading }: { platform: Platform; files: Installer[]; loading: boolean }) {
  // A Mac's second build is for the few Intel Macs left, so it's a line under the card rather than a card of its own.
  const [cards, extra] = platform === "mac" ? [files.filter((f) => f.arch !== "x64"), files.find((f) => f.arch === "x64")] : [files, undefined];
  return (
    <section id={platform} aria-labelledby={`${platform}-title`} className="scroll-mt-20">
      <h2 id={`${platform}-title`} className={platformHeading}>
        <PlatformLogo platform={platform} className="size-5" />
        {platformName[platform]}
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-busy={loading}>
        {cards.length ? (
          cards.map((f) => <InstallerCard key={f.url} file={f} />)
        ) : loading ? (
          <InstallerSkeleton />
        ) : (
          <li>
            <a href={RELEASES_URL} className={cn(cardLink, "py-4")}>
              <span className="font-medium text-foreground text-sm">On the release page</span>
              <Icon icon={ArrowUpRight01Icon} className="ml-auto size-4 text-muted-foreground" />
            </a>
          </li>
        )}
      </ul>
      {extra || notes[platform] ? (
        <div className="mt-3.5 flex flex-col gap-1 text-pretty text-muted-foreground text-sm">
          {extra ? (
            <p>
              On an Intel Mac?{" "}
              <a href={extra.url} download className={textLink}>
                Download the Intel build
              </a>{" "}
              <span className="tabular-nums">({size(extra.size)})</span>.
            </p>
          ) : null}
          {notes[platform] ? <p>{notes[platform]}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function NightlySection({ nightly, now, loading }: { nightly: NightlyRelease | null; now?: number; loading: boolean }) {
  const all = nightly?.installers ?? [];
  const cards = all.filter((f) => !(f.platform === "mac" && f.arch === "x64"));
  const intel = all.find((f) => f.platform === "mac" && f.arch === "x64");
  return (
    <section id="nightly" aria-labelledby="nightly-title" className="scroll-mt-20">
      <h2 id="nightly-title" className={platformHeading}>
        <Icon icon={SparklesIcon} className="size-5" />
        Nightly
        <Badge variant="outline" size="default" className="ml-1 font-normal">
          Signed preview
        </Badge>
        {nightly ? (
          <a href={nightly.url} className="ml-auto inline-flex items-center gap-1 font-normal text-muted-foreground text-xs tabular-nums hover:text-foreground">
            {nightly.sha ? <span className="type-live">{nightly.sha}</span> : formatVersion(nightly.version)}
            {nightly.published ? (
              <>
                {" · "}
                <Time iso={nightly.published} now={now} />
              </>
            ) : null}
            <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
          </a>
        ) : null}
      </h2>
      <p className="mt-2.5 text-pretty text-muted-foreground text-sm">
        Built automatically from <code className="rounded bg-well px-1 py-0.5 font-mono text-foreground text-xs">main</code> every night. macOS builds are signed and notarized by Apple; nightly stays separate from stable in-app updates.
      </p>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2" aria-busy={loading}>
        {cards.length ? (
          cards.map((f) => <InstallerCard key={f.url} file={f} showPlatform />)
        ) : loading ? (
          <>
            <InstallerSkeleton />
            <InstallerSkeleton />
          </>
        ) : (
          <li className="sm:col-span-2">
            <a href={NIGHTLY_URL} className={cn(cardLink, "py-4")}>
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-foreground text-sm">View nightly builds on GitHub</span>
                <span className="text-muted-foreground text-xs">The latest signed nightly installers appear here as soon as the build finishes.</span>
              </span>
              <Icon icon={ArrowUpRight01Icon} className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </a>
          </li>
        )}
      </ul>
      {intel ? (
        <p className="mt-3.5 text-pretty text-muted-foreground text-sm">
          On an Intel Mac?{" "}
          <a href={intel.url} download className={textLink}>
            Download the Intel nightly build
          </a>{" "}
          <span className="tabular-nums">({size(intel.size)})</span>.
        </p>
      ) : null}
    </section>
  );
}

function InstallerSkeleton() {
  return (
    <li aria-hidden className="flex items-center gap-3.5 rounded-card border bg-card px-4 py-3.5">
      <span className="size-9 shrink-0 rounded-lg bg-muted motion-safe:animate-pulse" />
      <span className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="h-3.5 w-36 rounded-full bg-muted motion-safe:animate-pulse" />
        <span className="h-3 w-24 rounded-full bg-muted/80 motion-safe:animate-pulse" />
      </span>
    </li>
  );
}

const notes: Partial<Record<Platform, ReactNode>> = {
  mac: (
    <>
      Apple has checked this app for malicious software. The first time you open it, macOS asks whether to open an app from the internet: choose <b className="font-medium text-foreground">Open</b>.
    </>
  ),
  windows: (
    <>
      It isn’t signed yet, so Windows may warn you once. Choose <b className="font-medium text-foreground">More info</b>, then <b className="font-medium text-foreground">Run anyway</b>.
    </>
  ),
};

const cardLink =
  "group flex items-center gap-3.5 rounded-card border bg-card px-4 py-3.5 outline-none transition-colors duration-150 hover:border-border-strong hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring";

function InstallerCard({ file, showPlatform }: { file: Installer; showPlatform?: boolean }) {
  return (
    <li>
      <a href={file.url} download className={cardLink}>
        {showPlatform ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-well text-foreground">
            <PlatformLogo platform={file.platform} className="size-5" />
          </span>
        ) : (
          <img src="/icon.png" width={256} height={256} alt="" className="size-9 shrink-0" />
        )}
        <span className="flex min-w-0 flex-col">
          <span className="font-medium text-foreground text-sm">
            {showPlatform ? `${platformName[file.platform]} · ${file.label}` : file.label}
            {file.platform === "linux" ? null : <span className="text-muted-foreground"> ({file.arch})</span>}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {file.kind}
            {file.platform === "linux" ? ` · ${file.arch}` : null} · {size(file.size)}
          </span>
        </span>
        <Icon icon={Download01Icon} className="ml-auto size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      </a>
    </li>
  );
}

const ways = [
  { title: "Run it from source", body: "Needs Node 22 and pnpm. It opens the app and reloads as you edit.", lines: [`git clone ${REPO_URL}`, "cd phaethon && pnpm install", "pnpm dev"] },
  { title: "Make your own installer", body: "Builds an installer for the computer you’re on, into release/.", lines: ["pnpm dist"] },
];

function FromSource() {
  return (
    <section aria-labelledby="source-title">
      <Container className="max-w-4xl pb-20 sm:pb-28">
        <h2 id="source-title" className={platformHeading}>
          <Icon icon={SourceCodeIcon} className="size-5" />
          Build it yourself
        </h2>
        <p className="mt-2 text-muted-foreground text-sm">For developers: run Phaethon straight from its code, or make your own installer.</p>
        <div className="mt-4 grid gap-3 lg:grid-cols-[2fr_1fr]">
          {ways.map((w) => (
            <Card key={w.title} className="gap-3.5 p-5">
              <div className="flex flex-col gap-1">
                <h3 className="type-heading">{w.title}</h3>
                <p className="text-pretty text-muted-foreground text-sm">{w.body}</p>
              </div>
              <Command lines={w.lines} />
            </Card>
          ))}
        </div>
      </Container>
    </section>
  );
}

/** Shell lines with a prompt each, and a button that copies them without the prompts. */
export function Command({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="relative rounded-lg border bg-well">
      <pre className="py-2.5 pr-11 pl-3.5 font-mono text-[0.8125rem] text-foreground leading-[1.65]">
        {lines.map((l) => (
          <span key={l} className="block whitespace-pre-wrap pl-[2ch] -indent-[2ch] [overflow-wrap:anywhere]">
            <span aria-hidden className="select-none text-muted-foreground">
              ${" "}
            </span>
            {l}
          </span>
        ))}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : lines.length > 1 ? "Copy commands" : "Copy command"}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-xs", shape: "rect" }), "absolute top-2 right-2 text-muted-foreground hover:text-foreground")}
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} />
      </button>
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
