import type { HostCookie, HostEventBody } from "#shared/host.ts";
import { host } from "../host.ts";
import { log } from "../log.ts";
import { Refusal } from "../rpc/registry.ts";
import { loginResult, loginUrl } from "./adapters/index.ts";
import { fill } from "./csrf.ts";
import { CANCELLED, type Cookie, type Credential, type Site } from "./types.ts";

/**
 * Signing in to a course site in a window of the desktop app that shows the
 * school's own login page (whatever SSO, Duo or consent pages it puts in the
 * way). The window lives in Electron's main process with its own persistent
 * cookie partition per vault and no access to the app; the core decides when
 * the person is signed in by reading the window's cookies, and those cookies
 * go only to the keychain.
 */

/** How often the window's cookies are checked, besides after each page load. */
export const CHECK_EVERY_MS = 1500;
/** After this long the window is closed and the sign-in given up. */
export const LIMIT_MS = 30 * 60 * 1000;

const timing = { every: CHECK_EVERY_MS, limit: LIMIT_MS };

/** Tests: shorter waits. */
export function setLoginTimingForTests(every: number, limit: number): void {
  timing.every = every;
  timing.limit = limit;
}

/** The cookies a browser would send to `site`: one per name, the most specific domain winning. */
export function siteCookies(site: Site, all: { name: string; value: string; domain: string | null; secure: boolean }[]): Cookie[] {
  const h = site.base.hostname.toLowerCase();
  const https = site.base.protocol === "https:";
  const picked: { len: number; c: Cookie }[] = [];
  for (const { name, value, domain, secure } of all) {
    if (domain === null || domain === undefined) continue;
    const d = domain.replace(/^\.+/, "").toLowerCase();
    const applies = d !== "" && (h === d || h.endsWith(`.${d}`));
    if (!applies || (secure && !https)) continue;
    const found = picked.find((p) => p.c.name === name);
    if (found) {
      if (d.length > found.len) {
        found.len = d.length;
        found.c.value = value;
      }
    } else picked.push({ len: d.length, c: { name, value } });
  }
  return picked.map((p) => p.c);
}

/** Where the sign-in window may go (enforced by the desktop shell). */
export function allowedNavigation(u: URL): boolean {
  return ["https:", "http:", "about:", "blob:", "data:"].includes(u.protocol);
}

/** The sign-in window's data store for a vault: 16 stable bytes (UUIDv4-shaped), as the Rust app made them. */
export function dataStoreId(vault: string): Uint8Array {
  const key = Buffer.from(`phaethon-lms-login\0${vault}\0vault`, "utf8");
  const fnv = (seed: bigint) => {
    let hsh = seed;
    for (const b of key) hsh = ((hsh ^ BigInt(b)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return hsh;
  };
  const id = new Uint8Array(16);
  const view = new DataView(id.buffer);
  view.setBigUint64(0, fnv(0xcbf29ce484222325n));
  view.setBigUint64(8, fnv(0x6c62272e07bb0142n));
  id[6] = (id[6] & 0x0f) | 0x40;
  id[8] = (id[8] & 0x3f) | 0x80;
  return id;
}

export function partitionFor(vault: string): string {
  return `persist:lms-login-${Buffer.from(dataStoreId(vault)).toString("hex")}`;
}

/** Where the window is, for the log: no query or fragment (they can carry tokens). */
function where(u: string): string {
  try {
    const p = new URL(u);
    return `${p.protocol}//${p.host}${p.pathname}`;
  } catch {
    return "(an address)";
  }
}

let open: number | null | "opening" = null;

/**
 * Open the sign-in window for `site` and wait until the site's adapter sees the
 * person signed in (the credential, CSRF token filled in where it can be), or
 * the window is closed or times out (`"cancelled"`). One window at a time.
 */
export async function signIn(site: Site, title: string, partition: string): Promise<Credential> {
  if (open !== null) {
    if (typeof open === "number") void host().call({ op: "windowFocus", window: open }).catch(() => {});
    throw new Refusal("A sign-in window is already open. Finish signing in there, or close it.");
  }
  open = "opening";
  let windowId: number | null = null;
  let unlisten = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    const started = Date.now();
    let at: string | null = null;
    let closed = false;
    let checking = false;
    let wake: (() => void) | null = null;
    const pending: HostEventBody[] = [];
    unlisten = host().on((e) => {
      pending.push(e);
      wake?.();
    });
    windowId = await host().call<number>({ op: "windowOpen", url: loginUrl(site).href, title, partition, width: 960, height: 780 });
    open = windowId;
    let tick = true;
    timer = setInterval(() => {
      tick = true;
      wake?.();
    }, timing.every);
    for (;;) {
      while (pending.length) {
        const e = pending.shift()!;
        if (e.kind === "windowClosed" && e.window === windowId) closed = true;
        else if (e.kind === "quitting") closed = true;
        else if (e.kind === "windowNavigated" && e.window === windowId) {
          at = e.url;
          tick = true;
          log.debug("[lms-login] at", { where: where(e.url) });
        }
      }
      if (closed) throw new Refusal(CANCELLED);
      if (Date.now() - started > timing.limit) throw new Refusal(CANCELLED);
      if (tick && at !== null && !checking) {
        tick = false;
        checking = true;
        let jar: HostCookie[];
        try {
          jar = await host().call<HostCookie[]>({ op: "windowCookies", window: windowId });
        } catch {
          // The window went away mid-check: the close event says so.
          jar = [];
        }
        checking = false;
        let url: URL | null = null;
        try {
          url = new URL(at);
        } catch {
          url = null;
        }
        if (url) {
          const cookies = siteCookies(
            site,
            jar.map((c) => ({ name: c.name, value: c.value, domain: c.domain || null, secure: c.secure })),
          );
          const credential = loginResult(site, { url, cookies });
          if (credential) return await fill(site, credential);
        }
        continue;
      }
      tick = false;
      await new Promise<void>((resolve) => {
        wake = resolve;
        if (pending.length) resolve();
      });
      wake = null;
    }
  } finally {
    clearInterval(timer);
    unlisten();
    if (typeof windowId === "number") await host().call({ op: "windowClose", window: windowId }).catch(() => {});
    open = null;
  }
}
