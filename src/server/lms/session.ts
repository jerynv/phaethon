import net from "node:net";
import { HttpError, lookupAll, request, type HttpResponse } from "./http.ts";
import { Cancelled, LmsError, type Credential, type Site } from "./types.ts";

/**
 * A signed-in site: the only way adapters talk to the network. The credential
 * only ever goes to the site's own origin; redirects are followed by hand and
 * the cookie is dropped on any hop off the origin. Links out of a course are
 * fetched without it, and only to public addresses.
 */

/** Largest single download (a file from the site or a linked textbook). */
// Course archives can exceed 300 MiB. Downloads stream to disk; document
// extraction keeps its own, smaller limits on bytes read into memory.
export const MAX_DOWNLOAD = 512 * 1024 * 1024;

const testing = { loopback: false };

/**
 * Tests only: a plain-http loopback server stands in for an https storage host
 * and for the public internet. Never set outside tests.
 */
export function allowLoopbackForTests(on: boolean): void {
  testing.loopback = on;
}

function isLoopbackHost(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
}

export class Session {
  constructor(
    readonly site: Site,
    private readonly credential: Credential,
    /** Aborts every request this session makes (an import's cancel). */
    readonly signal?: AbortSignal,
  ) {}

  getCredential(): Credential {
    return this.credential;
  }

  /** A copy of this session whose requests also stop on `signal`. */
  withSignal(signal: AbortSignal | undefined): Session {
    return new Session(this.site, this.credential, signal);
  }

  private cookieHeader(): string {
    return this.credential.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }

  private async send(url: URL, init: Parameters<typeof request>[1]): Promise<HttpResponse> {
    try {
      return await request(url, { ...init, signal: this.signal });
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      if (e instanceof HttpError) throw LmsError.network(e.message);
      throw LmsError.network((e as Error).message);
    }
  }

  /**
   * POST a JSON body to a path on the site with the session (Moodle's read-only
   * AJAX service). Never follows redirects: any 3xx or 401 means signed out.
   */
  async postJson<T = unknown>(pathAndQuery: string, body: unknown, csrfHeader?: string): Promise<T> {
    const url = this.joinPath(pathAndQuery);
    if (!this.site.owns(url)) throw LmsError.other("Refused to send your sign-in to another site.");
    const headers: Record<string, string> = { cookie: this.cookieHeader(), "content-type": "application/json" };
    if (csrfHeader && this.credential.csrf) headers[csrfHeader.toLowerCase()] = this.credential.csrf;
    const res = await this.send(url, { method: "POST", headers, body: JSON.stringify(body) });
    const s = res.status;
    if (s < 200 || s > 299) {
      res.discard();
      if ((s >= 300 && s <= 399) || s === 401) throw LmsError.signedOut();
      throw statusError(s);
    }
    return parseJson<T>(await res.text());
  }

  /**
   * GET `url` with the credential. Refuses any address off the site's origin;
   * follows up to 5 redirects, dropping the credential the moment one leaves
   * the origin. 401 → SignedOut, 403 → Forbidden, 404 → NotFound.
   */
  get(url: URL): Promise<HttpResponse> {
    return this.getWith(url, null, null);
  }

  /** A conditional GET; a 304 comes back as is when a validator was sent. Validators go on every hop. */
  getConditional(url: URL, etag: string | null, modified: string | null): Promise<HttpResponse> {
    return this.getWith(url, etag, modified);
  }

  private async getWith(url: URL, etag: string | null, modified: string | null): Promise<HttpResponse> {
    if (!this.site.owns(url)) throw LmsError.other(`Refused to send your sign-in to ${url.hostname || "another site"}`);
    let at = url;
    for (let hop = 0; hop < 6; hop++) {
      const headers: Record<string, string> = {};
      if (this.site.owns(at)) headers.cookie = this.cookieHeader();
      if (etag !== null) headers["if-none-match"] = etag;
      if (modified !== null) headers["if-modified-since"] = modified;
      const res = await this.send(at, { headers });
      const s = res.status;
      if (s === 304 && (etag !== null || modified !== null)) return res;
      if (s >= 300 && s <= 399) {
        res.discard();
        const loc = res.header("location");
        let next: URL | null = null;
        if (loc !== undefined) {
          try {
            next = new URL(loc, at);
          } catch {
            next = null;
          }
        }
        if (!next) throw LmsError.other("The site sent a redirect without an address.");
        const loopback = testing.loopback && isLoopbackHost(next);
        if (next.protocol !== "https:" && !this.site.owns(next) && !loopback) throw LmsError.other("The site redirected to an insecure address.");
        at = next;
        continue;
      }
      if (s >= 200 && s <= 299) return res;
      if (s === 403) {
        const remaining = res.header("x-rate-limit-remaining");
        let body = "";
        try {
          body = (await res.bytes(4096)).toString("utf8");
        } catch {
          body = "";
        }
        const e = LmsError.forbidden();
        e.rateLimited = /rate limit exceeded/i.test(body) || (remaining !== undefined && Number(remaining.trim()) <= 0);
        throw e;
      }
      res.discard();
      if (s === 401) throw LmsError.signedOut();
      throw statusError(s);
    }
    throw LmsError.other("Too many redirects.");
  }

  /** `base.join(path)`; a path that can't be joined is an Other error. */
  joinPath(pathAndQuery: string): URL {
    try {
      return new URL(pathAndQuery, this.site.base);
    } catch (e) {
      throw LmsError.other((e as Error).message);
    }
  }

  /** GET a path on the site and parse JSON. A sign-in page (text/html) instead of JSON means signed out. */
  async getJson<T = unknown>(pathAndQuery: string): Promise<T> {
    const res = await this.get(this.joinPath(pathAndQuery));
    if ((res.header("content-type") ?? "").startsWith("text/html")) {
      res.discard();
      throw LmsError.signedOut();
    }
    return parseJson<T>(await res.text());
  }

  /** A link out of the course, fetched without the credential. See `fetchExternal`. */
  fetchExternal(url: URL): Promise<HttpResponse> {
    return fetchExternal(url, this.signal);
  }
}

function statusError(s: number): LmsError {
  if (s === 403) return LmsError.forbidden();
  if (s === 404) return LmsError.notFound();
  return LmsError.other(`Your course site answered with an error (${s}).`);
}

export function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw LmsError.other(`Your course site sent something unexpected: ${(e as Error).message}`);
  }
}

/**
 * GET a link out of the course (a publisher's PDF, an open textbook) without
 * any credential. https and http only, and only to the public internet: every
 * hop's host is resolved, every address checked, and the connection made to a
 * checked address (so a second DNS answer can't point it somewhere local).
 */
export async function fetchExternal(url: URL, signal?: AbortSignal): Promise<HttpResponse> {
  let at = url;
  for (let hop = 0; hop < 6; hop++) {
    if (at.protocol !== "https:" && at.protocol !== "http:") throw LmsError.other("Not a web link.");
    let lookup: net.LookupFunction | undefined;
    if (!(testing.loopback && isLoopbackHost(at))) {
      const pinned = await publicAddress(at);
      if (!pinned) throw LmsError.other("Not downloaded: the link points at this computer or its local network.");
      lookup = ((_host: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        if (options?.all) cb(null, [pinned]);
        else cb(null, pinned.address, pinned.family);
      }) as unknown as net.LookupFunction;
    }
    let res: HttpResponse;
    try {
      res = await request(at, { signal, lookup });
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      throw LmsError.network((e as Error).message);
    }
    const s = res.status;
    if (s >= 300 && s <= 399) {
      res.discard();
      const loc = res.header("location");
      let next: URL | null = null;
      if (loc !== undefined) {
        try {
          next = new URL(loc, at);
        } catch {
          next = null;
        }
      }
      if (!next) throw LmsError.other("The link redirected without an address.");
      at = next;
      continue;
    }
    if (s < 200 || s > 299) {
      res.discard();
      throw LmsError.other(`The link answered with an error (${s}).`);
    }
    return res;
  }
  throw LmsError.other("The link redirected too many times.");
}

/** The first address `url`'s host resolves to, when every one of them is public; else null. */
async function publicAddress(url: URL): Promise<{ address: string; family: number } | null> {
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!host) return null;
  if (net.isIP(host)) return isPublic(host) ? { address: host, family: net.isIP(host) } : null;
  try {
    const addrs = await lookupAll(host);
    if (addrs.length === 0 || !addrs.every((a) => isPublic(a.address))) return null;
    return { address: addrs[0].address, family: addrs[0].family };
  } catch {
    return null;
  }
}

/**
 * Not loopback, private, link-local, shared (CGNAT), unspecified, multicast,
 * broadcast or documentation space, for IPv4, IPv6 and IPv4 inside IPv6.
 */
export function isPublic(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    const [a, b, c] = o;
    return !(
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0 ||
      a >= 224 ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 100 && b >= 64 && b < 128)
    );
  }
  if (net.isIPv6(ip)) {
    const seg = ipv6Segments(ip);
    if (!seg) return false;
    // IPv4-mapped (::ffff:a.b.c.d)
    if (seg.slice(0, 5).every((s) => s === 0) && seg[5] === 0xffff) {
      return isPublic(`${seg[6] >> 8}.${seg[6] & 255}.${seg[7] >> 8}.${seg[7] & 255}`);
    }
    const loopback = seg.slice(0, 7).every((s) => s === 0) && seg[7] === 1;
    const unspecified = seg.every((s) => s === 0);
    const first = seg[0];
    return !(loopback || unspecified || (first & 0xff00) === 0xff00 || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
  }
  return false;
}

function ipv6Segments(ip: string): number[] | null {
  let s = ip.split("%")[0];
  // A trailing dotted IPv4 part becomes two segments.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    s = s.slice(0, -v4[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - h.length - t.length : 0;
  if (fill < 0) return null;
  const all = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}
