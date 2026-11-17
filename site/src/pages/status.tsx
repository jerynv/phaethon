import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { REPO_URL, type BuildState, type Run } from "../github.ts";
import { Container, PageHead, SectionTitle, Time, type Live } from "../layout.tsx";

export const buildWord: Record<BuildState, string> = { passing: "Passing", failing: "Failing", running: "Running" };
export const buildDot: Record<BuildState, string> = { passing: "bg-success", failing: "bg-destructive", running: "bg-warning motion-safe:animate-pulse" };

/** Where the project stands: the numbers, recent changes with their builds, releases, and what's next. */
export function StatusPage({ snap, now }: Live) {
  const { release, build, commit, issues, runs, commits, releases } = snap;
  const ranFor = new Map<string, Run>();
  for (const r of runs) if (!ranFor.has(r.sha)) ranFor.set(r.sha, r);
  return (
    <>
      <Container className="pt-16 pb-12 sm:pt-24">
        <PageHead title="Status">
          <span className="flex flex-wrap items-center gap-2.5">
            <Badge variant="warning" size="lg">
              Pre-alpha
            </Badge>
            Fine to try. Not yet for data you can't lose.
          </span>
        </PageHead>
        <ul aria-label="At a glance" className="mt-10 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Tile label="Latest release" href={release?.url ?? `${REPO_URL}/releases`} hint={release ? <Time iso={release.published} now={now} /> : null}>
            {release ? `v${release.version}` : "None yet"}
          </Tile>
          <Tile label="Build on main" href={build?.url ?? `${REPO_URL}/actions`} hint={build ? <Time iso={build.at} now={now} /> : null}>
            {build ? (
              <span className="inline-flex items-center gap-2.5">
                <span aria-hidden className={cn("size-2 rounded-full", buildDot[build.state])} />
                {buildWord[build.state]}
              </span>
            ) : (
              "Unknown"
            )}
          </Tile>
          <Tile label="Last change" href={commit?.url ?? `${REPO_URL}/commits/main`} hint={commit ? <span className="type-live">{commit.sha.slice(0, 7)}</span> : null}>
            {commit ? <Time iso={commit.at} now={now} /> : "Unknown"}
          </Tile>
          <Tile label="Open issues" href={`${REPO_URL}/issues`} hint="Bugs and requests">
            {issues ?? "Unknown"}
          </Tile>
        </ul>
      </Container>

      <Container className="grid gap-x-12 gap-y-16 pb-20 sm:pb-28 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="changes-title" className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <SectionTitle id="changes-title">Changes on main</SectionTitle>
            {runs.length ? <BuildStrip runs={runs} /> : null}
          </div>
          <Card render={<ol />} className="mt-6 divide-y">
            {commits.map((c) => {
              const run = ranFor.get(c.sha);
              return (
                <li key={c.sha}>
                  <a href={c.url} className="group flex items-center gap-3.5 px-5 py-3.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                    <span
                      role="img"
                      aria-label={run ? `Build ${buildWord[run.state].toLowerCase()}` : "No build"}
                      className={cn("size-2 shrink-0 rounded-full", run ? buildDot[run.state] : "border border-border-strong")}
                    />
                    <span className="min-w-0 flex-1 truncate text-foreground text-sm">{c.message}</span>
                    <span className="shrink-0 text-muted-foreground text-xs tabular-nums max-sm:hidden">
                      <span className="type-live">{c.sha.slice(0, 7)}</span> · <Time iso={c.at} now={now} />
                    </span>
                  </a>
                </li>
              );
            })}
          </Card>
          <a href={`${REPO_URL}/commits/main`} className="mt-4 inline-flex items-center gap-1 text-muted-foreground text-sm hover:text-foreground">
            Full history
            <Icon icon={ArrowUpRight01Icon} className="size-3.5" />
          </a>
        </section>

        <div className="flex flex-col gap-16">
          <section aria-labelledby="releases-title">
            <SectionTitle id="releases-title">Releases</SectionTitle>
            <ol className="mt-6 flex flex-col">
              {releases.map((r) => (
                <li key={r.version} className="border-b first:border-t">
                  <a href={r.url} className="flex items-center gap-3 py-3 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="type-live text-foreground text-sm">v{r.version}</span>
                    {r.prerelease ? (
                      <Badge variant="outline" size="default">
                        Preview
                      </Badge>
                    ) : null}
                    <span className="ml-auto text-muted-foreground text-xs tabular-nums">
                      <Time iso={r.published} now={now} />
                    </span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
          <section aria-labelledby="roadmap-title">
            <SectionTitle id="roadmap-title">Roadmap</SectionTitle>
            <div className="mt-6 flex flex-col gap-8">
              {roadmap.map((r) => (
                <div key={r.lane}>
                  <h3 className="font-medium text-muted-foreground text-xs">{r.lane}</h3>
                  <ul className="mt-3 flex flex-col gap-2.5 text-[0.9375rem] text-foreground">
                    {r.items.map((item) => (
                      <li key={item} className="flex gap-3 text-pretty">
                        <span aria-hidden className={cn("mt-[0.55em] size-1.5 shrink-0 rounded-full", r.lane === "Next" ? "bg-primary" : "border border-border-strong")} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        </div>
      </Container>
    </>
  );
}

const roadmap = [
  { lane: "Next", items: ["Signed and notarized builds", "An alpha with disabled testers", "Sync conflicts you can see and resolve"] },
  { lane: "Later", items: ["Your phone, served by your desktop over Tailscale", "An optional hosted sync relay", "Hosted model credits, for when you'd rather not bring a key"] },
];

function Tile({ label, href, hint, children }: { label: string; href: string; hint: ReactNode; children: ReactNode }) {
  return (
    <li>
      <a href={href} className="flex h-full flex-col gap-1 rounded-xl border border-border/70 bg-well px-4 py-3.5 outline-none transition-colors hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring">
        <span className="text-muted-foreground text-sm">{label}</span>
        <span className="type-stat">{children}</span>
        {hint ? <span className="text-muted-foreground text-xs tabular-nums">{hint}</span> : null}
      </a>
    </li>
  );
}

/** The last builds on main as a row of ticks, oldest first, like a status page's uptime bar. */
function BuildStrip({ runs }: { runs: Run[] }) {
  const shown = runs.slice(0, 20).reverse();
  const passed = shown.filter((r) => r.state === "passing").length;
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted-foreground text-xs tabular-nums">
        {passed} of the last {shown.length} builds passed
      </span>
      <span aria-hidden className="flex h-5 items-stretch gap-[3px]">
        {shown.map((r) => (
          <span key={r.url} className={cn("w-1 rounded-full", r.state === "passing" ? "bg-success/80" : r.state === "failing" ? "bg-destructive" : "bg-warning")} />
        ))}
      </span>
    </div>
  );
}
