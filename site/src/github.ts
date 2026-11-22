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
export const NIGHTLY_URL = `${REPO_URL}/releases/tag/nightly`;
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
export type Release = { tag: string; version: string; url: string; published: string; prerelease: boolean };
export type NightlyRelease = Release & { installers: Installer[]; sha?: string };
export type Run = { state: BuildState; url: string; at: string; sha: string };
export type Commit = { sha: string; message: string; url: string; at: string };

export type Snapshot = {
  /** The latest full release, with its installers. */
  release: (Release & { installers: Installer[] }) | null;
  /** The rolling signed nightly prerelease, if published. */
  nightly: NightlyRelease | null;
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

type Asset = { name: string; browser_download_url: string; size: number; updated_at?: string };

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

function authHeader(): Record<string, string> {
  if (typeof process === "undefined") return {};
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path.startsWith("https:") ? path : `${API}${path}`, {
      headers: { Accept: "application/vnd.github+json", ...authHeader() },
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

type ApiRelease = {
  tag_name: string;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  target_commitish?: string;
  body?: string | null;
  assets: Asset[];
};

function releaseTimestamp(r: ApiRelease): string {
  let latest = Date.parse(r.published_at) || 0;
  let iso = r.published_at;
  for (const a of r.assets) {
    const t = a.updated_at ? Date.parse(a.updated_at) : 0;
    if (t > latest) {
      latest = t;
      iso = a.updated_at!;
    }
  }
  return iso;
}

function nightlyVersion(r: ApiRelease): string {
  for (const a of r.assets) {
    const m = /^Phaethon-([0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.]+)-(?:mac|win|linux)/.exec(a.name);
    if (m) return m[1]!;
  }
  return r.tag_name.replace(/^v/, "");
}

function nightlySha(r: ApiRelease): string | undefined {
  const fromBody = r.body ? /`([0-9a-f]{7,40})`/i.exec(r.body)?.[1] : undefined;
  if (fromBody) return fromBody.slice(0, 7);
  if (r.target_commitish && /^[0-9a-f]{7,40}$/i.test(r.target_commitish)) return r.target_commitish.slice(0, 7);
  return undefined;
}

export async function snapshot(): Promise<Snapshot> {
  type Runs = { workflow_runs: { status: string; conclusion: string | null; html_url: string; updated_at: string; head_sha: string }[] };
  type ApiCommit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } } };
  type Repo = { stargazers_count: number };
  type ApiIssue = { pull_request?: unknown };
  type Search = { total_count: number };
  const [releases, nightlyRaw, runs, commits, repo, openItems] = await Promise.all([
    get<ApiRelease[]>("/releases?per_page=20"),
    get<ApiRelease>("/releases/tags/nightly"),
    get<Runs>("/actions/workflows/ci.yml/runs?branch=main&per_page=50"),
    get<ApiCommit[]>("/commits?sha=main&per_page=10"),
    get<Repo>(""),
    // Core REST issues endpoint avoids the 10 req/min Search API limit; PRs are filtered out below.
    get<ApiIssue[]>("/issues?state=open&per_page=100"),
  ]);
  let issueCount: number | null = null;
  if (openItems) {
    if (openItems.length < 100) {
      issueCount = openItems.filter((i) => !i.pull_request).length;
    } else {
      const search = await get<Search>(`https://api.github.com/search/issues?q=${encodeURIComponent(`repo:${REPO} type:issue state:open`)}&per_page=1`);
      issueCount = search?.total_count ?? null;
    }
  }
  const published = (releases ?? []).filter((r) => !r.draft);
  const latest = published.find((r) => !r.prerelease);
  const nightlyCandidate = (nightlyRaw && !nightlyRaw.draft ? nightlyRaw : null) ?? published.find((r) => r.tag_name === "nightly" || r.prerelease) ?? null;
  const release = (r: ApiRelease): Release => ({
    tag: r.tag_name,
    version: r.tag_name === "nightly" ? nightlyVersion(r) : r.tag_name.replace(/^v/, ""),
    url: r.html_url,
    published: r.tag_name === "nightly" ? releaseTimestamp(r) : r.published_at,
    prerelease: r.prerelease,
  });
  // A cancelled run was superseded by a newer push; it says nothing about the build.
  const ran = (runs?.workflow_runs ?? [])
    .filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped")
    .slice(0, 20)
    .map((r): Run => ({ state: r.status !== "completed" ? "running" : r.conclusion === "success" ? "passing" : "failing", url: r.html_url, at: r.updated_at, sha: r.head_sha }));
  const changes = (commits ?? []).map((c): Commit => ({ sha: c.sha, message: c.commit.message.split("\n")[0]!, url: c.html_url, at: c.commit.committer.date }));
  return {
    release: latest ? { ...release(latest), installers: installers(latest.assets) } : null,
    nightly: nightlyCandidate ? { ...release(nightlyCandidate), installers: installers(nightlyCandidate.assets), sha: nightlySha(nightlyCandidate) } : null,
    releases: published.map(release),
    runs: ran,
    build: ran[0] ?? null,
    commits: changes,
    commit: changes[0] ?? null,
    stars: repo?.stargazers_count ?? null,
    issues: issueCount,
    fetched: new Date().toISOString(),
  };
}

/** Keeps what the build knew wherever a live read failed (rate limit, offline). */
export function merge(base: Snapshot, live: Snapshot): Snapshot {
  return {
    release: live.release ?? base.release,
    nightly: live.nightly ?? base.nightly ?? null,
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
