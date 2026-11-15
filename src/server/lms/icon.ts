import fs from "node:fs";
import path from "node:path";
import { vaultRoot, vaultStateDir } from "../core/vault.ts";
import { Refusal } from "../rpc/registry.ts";
import { USER_AGENT } from "./http.ts";
import { getConn, load } from "./store.ts";

/**
 * A course site's own icon (the school's, when the site is branded): the
 * apple-touch-icon or favicon at the site's origin, as a data URL the UI can
 * show beside the site's name. Remembered for a week under
 * `.phaethon/site-icons/`, misses included, so lists never wait on the network
 * twice. Nothing here needs the sign-in: these files are public.
 */

const PATHS = ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/favicon.png", "/favicon.ico"];
const MAX_BYTES = 256 * 1024;
const TTL_MS = 7 * 86_400_000;
const TIMEOUT_MS = 6000;

export type SiteIcon = { dataUrl: string | null };
type Cached = SiteIcon & { at: number };

export type Fetch = (url: URL, init: RequestInit) => Promise<Response>;

/** The first icon the origin serves as an image of a sane size, as a data URL; null when it has none. */
export async function fetchSiteIcon(origin: URL, fetchImpl: Fetch = (u, i) => fetch(u, i)): Promise<string | null> {
  for (const p of PATHS) {
    try {
      const res = await fetchImpl(new URL(p, origin), { redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { "user-agent": USER_AGENT, accept: "image/*" } });
      if (!res.ok) continue;
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!type.startsWith("image/")) continue;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) continue;
      return `data:${type};base64,${bytes.toString("base64")}`;
    } catch {
      // Not there, too slow, or refused: try the next name.
    }
  }
  return null;
}

function cacheFile(id: string): string {
  return path.join(vaultStateDir(), "site-icons", `${encodeURIComponent(id)}.json`);
}

function readCache(id: string): Cached | null {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(id), "utf8")) as Cached;
    return typeof c.at === "number" && (c.dataUrl === null || typeof c.dataUrl === "string") ? c : null;
  } catch {
    return null;
  }
}

function writeCache(id: string, icon: SiteIcon): void {
  try {
    fs.mkdirSync(path.dirname(cacheFile(id)), { recursive: true });
    fs.writeFileSync(cacheFile(id), JSON.stringify({ ...icon, at: Date.now() }));
  } catch {
    // The icon is fetched again next time.
  }
}

const inFlight = new Map<string, Promise<SiteIcon>>();

/** The icon for a connection, from the cache when it is under a week old. */
export function siteIcon(connection: string, fetchImpl?: Fetch, now = Date.now()): Promise<SiteIcon> {
  const conn = getConn(load(vaultRoot()), connection);
  if (!conn) throw new Refusal("That course site isn’t connected.");
  const cached = readCache(connection);
  if (cached && now - cached.at < TTL_MS) return Promise.resolve({ dataUrl: cached.dataUrl });
  const pending = inFlight.get(connection);
  if (pending) return pending;
  let origin: URL;
  try {
    origin = new URL(/^[a-z]+:\/\//i.test(conn.address) ? conn.address : `https://${conn.address}`);
  } catch {
    return Promise.resolve({ dataUrl: null });
  }
  const task = fetchSiteIcon(new URL(origin.origin), fetchImpl)
    .then((dataUrl) => {
      const icon = { dataUrl };
      writeCache(connection, icon);
      return icon;
    })
    .finally(() => inFlight.delete(connection));
  inFlight.set(connection, task);
  return task;
}
