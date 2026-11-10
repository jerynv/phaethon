import { decodeEntities } from "./html.ts";
import { Session } from "./session.ts";
import type { Cookie, Credential, Site } from "./types.ts";

/**
 * The CSRF token kept beside a sign-in's cookies: Canvas's `_csrf_token`
 * cookie, Moodle's `sesskey`, or a page's `<meta name="csrf-token">`. Stored
 * with the credential; adapters only ever read, so none sends it today.
 */

/** Percent-decodes `%XX` (invalid escapes kept), `+` is a space, lossy UTF-8. */
export function urlDecode(s: string): string {
  const b = Buffer.from(s, "utf8");
  const out: number[] = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0x25) {
      const h = b.subarray(i + 1, i + 3).toString("latin1");
      if (h.length === 2 && /^[0-9A-Fa-f]{2}$/.test(h)) {
        out.push(parseInt(h, 16));
        i += 2;
        continue;
      }
      out.push(0x25);
    } else if (c === 0x2b) out.push(0x20);
    else out.push(c);
  }
  return Buffer.from(out).toString("utf8");
}

/** The last cookie with this name. */
export function cookie(cookies: Cookie[], name: string): string | undefined {
  for (let i = cookies.length - 1; i >= 0; i--) if (cookies[i].name === name) return cookies[i].value;
  return undefined;
}

/** A token fit for a header: printable ASCII, at most 1024 bytes. */
export function plausible(t: string): string | null {
  const s = t.trim();
  if (!s || Buffer.byteLength(s) > 1024) return null;
  for (const ch of Buffer.from(s)) if (ch < 0x21 || ch > 0x7e) return null;
  return s;
}

export function fromCookies(cookies: Cookie[]): string | null {
  for (const n of ["_csrf_token", "XSRF-TOKEN", "csrftoken"]) {
    const v = cookie(cookies, n);
    if (v !== undefined) return plausible(urlDecode(v));
  }
  return null;
}

export function moodleSesskey(html: string): string | null {
  const i = html.indexOf('"sesskey":"');
  if (i >= 0) {
    const rest = html.slice(i + 11);
    const e = rest.indexOf('"');
    return e >= 0 ? plausible(rest.slice(0, e)) : null;
  }
  const j = html.indexOf('name="sesskey"');
  if (j < 0) return null;
  const start = html.lastIndexOf("<", j);
  if (start < 0) return null;
  const end = html.indexOf(">", j);
  if (end < 0) return null;
  return attrValue(html.slice(start, end), "value");
}

export function metaToken(html: string): string | null {
  const lower = html.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let from = 0;
  for (;;) {
    const start = lower.indexOf("<meta", from);
    if (start < 0) return null;
    const end = lower.indexOf(">", start);
    if (end < 0) return null;
    const tag = html.slice(start, end);
    const name = (attrValue(tag, "name") ?? "").toLowerCase();
    if (["csrf-token", "_csrf", "csrf_token", "xsrf-token"].includes(name)) return attrValue(tag, "content");
    from = end;
  }
}

function attrValue(tag: string, name: string): string | null {
  const lower = tag.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let from = 0;
  for (;;) {
    const at = lower.indexOf(name, from);
    if (at < 0) return null;
    from = at + name.length;
    const beforeOk = at === 0 || /[\t\n\f\r ]/.test(lower[at - 1]);
    let rest = tag.slice(from).trimStart();
    if (!beforeOk || !rest.startsWith("=")) continue;
    rest = rest.slice(1).trimStart();
    if (!rest) return null;
    const q = rest[0] === '"' || rest[0] === "'" ? rest[0] : " ";
    const body = q === " " ? rest : rest.slice(1);
    const e = body.indexOf(q);
    return plausible(decodeEntities(body.slice(0, e < 0 ? body.length : e)));
  }
}

/** GET a page on the site (at most 4 MiB read) and look for a token in it. */
export async function fromPage(session: Session, rel: string, find: (html: string) => string | null): Promise<string | null> {
  const res = await session.get(session.joinPath(rel));
  const body = await res.bytes(4 * 1024 * 1024);
  return find(body.toString("utf8"));
}

/**
 * The credential with its CSRF token filled in where it was missing: from the
 * cookies, else from the site's front page (relative, so a Moodle install
 * folder is kept). Never fails.
 */
export async function fill(site: Site, credential: Credential): Promise<Credential> {
  if (credential.csrf !== null) return credential;
  const t = fromCookies(credential.cookies);
  if (t !== null) return { ...credential, csrf: t };
  try {
    const found = await fromPage(new Session(site, credential), "./", (html) => moodleSesskey(html) ?? metaToken(html));
    if (found !== null) return { ...credential, csrf: found };
  } catch {
    // No token is fine: nothing sends it today.
  }
  return credential;
}
