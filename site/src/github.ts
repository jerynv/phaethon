/**
 * Everything the page says about the project's state, read from GitHub's
 * public API: the latest published release and its installers, the last CI
 * run on main, the last commit, stars and open issues. The build reads it once
 * (vite.config.ts) so the page is right with no script; the browser reads it
 * again on load so it never goes stale between deploys.
 */

export const REPO = "jerynv/phaethon";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
const API = `https://api.github.com/repos/${REPO}`;

export type Platform = "mac" | "windows" | "linux";

export type Installer = {
  platform: Platform;
  /** "Apple silicon", "Intel", "Installer", "AppImage", "Debian / Ubuntu". */
  label: string;
  /** ".dmg", ".exe", … */
  kind: string;
  arch: string;
  url: string;
  size: number;
};

export type Snapshot = {
  release: { version: string; url: string; published: string; installers: Installer[] } | null;
  build: { state: "passing" | "failing" | "running"; url: string; at: string } | null;
  commit: { sha: string; message: string; url: string; at: string } | null;
  stars: number | null;
  issues: number | null;
  fetched: string;
};

type Asset = { name: string; browser_download_url: string; size: number };

const kinds: { test: RegExp; platform: Platform; label: string; kind: string; arch: string }[] = [
  { test: /-mac-arm64\.dmg$/, platform: "mac", label: "Apple silicon", kind: ".dmg", arch: "arm64" },
  { test: /-mac-x64\.dmg$/, platform: "mac", label: "Intel", kind: ".dmg", arch: "x64" },
  { test: /-win-x64\.exe$/, platform: "windows", label: "Installer", kind: ".exe", arch: "x64" },
  { test: /\.AppImage$/, platform: "linux", label: "AppImage", kind: ".AppImage", arch: "x86_64" },
  { test: /\.deb$/, platform: "linux", label: "Debian, Ubuntu", kind: ".deb", arch: "amd64" },
];

export function installers(assets: Asset[]): Installer[] {
  const out: Installer[] = [];
  for (const k of kinds) {
    const a = assets.find((x) => k.test.test(x.name));
    if (a) out.push({ platform: k.platform, label: k.label, kind: k.kind, arch: k.arch, url: a.browser_download_url, size: a.size });
  }
  return out;
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API}${path}`, { headers: { Accept: "application/vnd.github+json" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function snapshot(): Promise<Snapshot> {
  type Release = { tag_name: string; html_url: string; published_at: string; assets: Asset[] };
  type Runs = { workflow_runs: { status: string; conclusion: string | null; html_url: string; updated_at: string }[] };
  type Commit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } } };
  type Repo = { stargazers_count: number; open_issues_count: number };
  const [release, runs, commit, repo] = await Promise.all([
    get<Release>("/releases/latest"),
    get<Runs>("/actions/workflows/ci.yml/runs?branch=main&per_page=6"),
    get<Commit>("/commits/main"),
    get<Repo>(""),
  ]);
  // A cancelled run was superseded by a newer push; it says nothing about the build.
  const run = runs?.workflow_runs.find((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");
  return {
    release: release
      ? { version: release.tag_name.replace(/^v/, ""), url: release.html_url, published: release.published_at, installers: installers(release.assets) }
      : null,
    build: run
      ? { state: run.status !== "completed" ? "running" : run.conclusion === "success" ? "passing" : "failing", url: run.html_url, at: run.updated_at }
      : null,
    commit: commit
      ? { sha: commit.sha.slice(0, 7), message: commit.commit.message.split("\n")[0]!, url: commit.html_url, at: commit.commit.committer.date }
      : null,
    stars: repo?.stargazers_count ?? null,
    issues: repo?.open_issues_count ?? null,
    fetched: new Date().toISOString(),
  };
}

/** Keeps what the build knew wherever a live read failed (rate limit, offline). */
export function merge(base: Snapshot, live: Snapshot): Snapshot {
  return {
    release: live.release ?? base.release,
    build: live.build ?? base.build,
    commit: live.commit ?? base.commit,
    stars: live.stars ?? base.stars,
    issues: live.issues ?? base.issues,
    fetched: live.fetched,
  };
}
