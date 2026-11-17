/**
 * Everything the site says about the project's state, read from GitHub's
 * public API: recent releases (the latest with its installers), recent CI runs
 * and commits on main, stars and open issues. The build reads it once
 * (vite.config.ts) so every page is right with no script; the browser reads it
 * again on load so it never goes stale between deploys.
 */

export const REPO = "jerynv/phaethon";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
const API = `https://api.github.com/repos/${REPO}`;

export type Platform = "mac" | "windows" | "linux";

export type Installer = {
  platform: Platform;
  /** "Apple silicon", "Intel", "Windows 10, 11", "Debian, Ubuntu", "Any distribution". */
  label: string;
  /** ".dmg", ".exe", … */
  kind: string;
  arch: string;
  url: string;
  size: number;
};

export type BuildState = "passing" | "failing" | "running";
export type Release = { version: string; url: string; published: string; prerelease: boolean };
export type Run = { state: BuildState; url: string; at: string; sha: string };
export type Commit = { sha: string; message: string; url: string; at: string };

export type Snapshot = {
  /** The latest full release, with its installers. */
  release: (Release & { installers: Installer[] }) | null;
  /** Newest first, prereleases included. */
  releases: Release[];
  /** CI on main, newest first; `build` is the newest. */
  runs: Run[];
  build: Run | null;
  /** Commits on main, newest first; `commit` is the newest. */
  commits: Commit[];
  commit: Commit | null;
  stars: number | null;
  issues: number | null;
  fetched: string;
};

type Asset = { name: string; browser_download_url: string; size: number };

const kinds: { test: RegExp; platform: Platform; label: string; kind: string; arch: string }[] = [
  { test: /-mac-arm64\.dmg$/, platform: "mac", label: "Apple silicon", kind: ".dmg", arch: "arm64" },
  { test: /-mac-x64\.dmg$/, platform: "mac", label: "Intel", kind: ".dmg", arch: "x64" },
  { test: /-win-x64\.exe$/, platform: "windows", label: "Windows 10, 11", kind: ".exe", arch: "x64" },
  { test: /\.AppImage$/, platform: "linux", label: "Any distribution", kind: ".AppImage", arch: "x86_64" },
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
    const res = await fetch(path.startsWith("https:") ? path : `${API}${path}`, { headers: { Accept: "application/vnd.github+json" } });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export async function snapshot(): Promise<Snapshot> {
  type ApiRelease = { tag_name: string; html_url: string; published_at: string; draft: boolean; prerelease: boolean; assets: Asset[] };
  type Runs = { workflow_runs: { status: string; conclusion: string | null; html_url: string; updated_at: string; head_sha: string }[] };
  type ApiCommit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } } };
  type Repo = { stargazers_count: number };
  type Search = { total_count: number };
  const [releases, runs, commits, repo, issues] = await Promise.all([
    get<ApiRelease[]>("/releases?per_page=8"),
    get<Runs>("/actions/workflows/ci.yml/runs?branch=main&per_page=20"),
    get<ApiCommit[]>("/commits?sha=main&per_page=10"),
    get<Repo>(""),
    // The repo's open_issues_count counts pull requests too.
    get<Search>(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} type:issue state:open`)}&per_page=1`),
  ]);
  const published = (releases ?? []).filter((r) => !r.draft);
  const latest = published.find((r) => !r.prerelease);
  const release = (r: ApiRelease): Release => ({ version: r.tag_name.replace(/^v/, ""), url: r.html_url, published: r.published_at, prerelease: r.prerelease });
  // A cancelled run was superseded by a newer push; it says nothing about the build.
  const ran = (runs?.workflow_runs ?? [])
    .filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped")
    .map((r): Run => ({ state: r.status !== "completed" ? "running" : r.conclusion === "success" ? "passing" : "failing", url: r.html_url, at: r.updated_at, sha: r.head_sha }));
  const changes = (commits ?? []).map((c): Commit => ({ sha: c.sha, message: c.commit.message.split("\n")[0]!, url: c.html_url, at: c.commit.committer.date }));
  return {
    release: latest ? { ...release(latest), installers: installers(latest.assets) } : null,
    releases: published.map(release),
    runs: ran,
    build: ran[0] ?? null,
    commits: changes,
    commit: changes[0] ?? null,
    stars: repo?.stargazers_count ?? null,
    issues: issues?.total_count ?? null,
    fetched: new Date().toISOString(),
  };
}

/** Keeps what the build knew wherever a live read failed (rate limit, offline). */
export function merge(base: Snapshot, live: Snapshot): Snapshot {
  return {
    release: live.release ?? base.release,
    releases: live.releases.length ? live.releases : base.releases,
    runs: live.runs.length ? live.runs : base.runs,
    build: live.build ?? base.build,
    commits: live.commits.length ? live.commits : base.commits,
    commit: live.commit ?? base.commit,
    stars: live.stars ?? base.stars,
    issues: live.issues ?? base.issues,
    fetched: live.fetched,
  };
}
