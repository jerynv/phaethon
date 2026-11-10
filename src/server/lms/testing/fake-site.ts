import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Tests only: a small fake course site on 127.0.0.1 that answers each request
 * through a route function and logs what it was sent (method, path and query,
 * Cookie, conditional headers, body).
 */

export type Reply = {
  status: number;
  ctype: string;
  headers?: Record<string, string | string[]>;
  body: string | Buffer;
  /** Start the body and never finish it (a slow download, for cancelling). */
  stall?: boolean;
};

export type Seen = {
  method: string;
  target: string;
  cookie: string | undefined;
  ifNoneMatch: string | undefined;
  ifModifiedSince: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
};

export type Route = (target: string, req: Seen) => Reply | Promise<Reply>;

export const json = (body: unknown): Reply => ({
  status: 200,
  ctype: "application/json; charset=utf-8",
  body: typeof body === "string" ? body : JSON.stringify(body),
});
export const html = (body: string): Reply => ({ status: 200, ctype: "text/html; charset=utf-8", body });
export const status = (code: number): Reply => ({ status: code, ctype: "application/json", body: '{"errors":[{"message":"no"}]}' });
export const redirect = (to: string, code = 302): Reply => ({ status: code, ctype: "text/html", headers: { location: to }, body: "" });
export const bytes = (ctype: string, body: Buffer | string, headers: Record<string, string> = {}): Reply => ({ status: 200, ctype, headers, body });
/** `body` with an ETag: answers 304 to a request whose If-None-Match matches it. */
export const tagged = (ctype: string, body: Buffer | string, etag: string): Reply => ({ status: 200, ctype, headers: { etag }, body });
export const stalled = (ctype: string, first: string): Reply => ({ status: 200, ctype, body: first, stall: true });

export type FakeSite = { base: string; log: Seen[]; close: () => Promise<void> };

export async function serve(route: Route): Promise<FakeSite> {
  const log: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const seen: Seen = {
      method: req.method ?? "",
      target: req.url ?? "/",
      cookie: req.headers.cookie,
      ifNoneMatch: req.headers["if-none-match"] as string | undefined,
      ifModifiedSince: req.headers["if-modified-since"] as string | undefined,
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    log.push(seen);
    let r: Reply;
    try {
      r = await route(seen.target, seen);
    } catch (e) {
      r = { status: 500, ctype: "text/plain", body: String(e) };
    }
    const etag = r.headers?.etag;
    if (etag !== undefined && etag === seen.ifNoneMatch) {
      res.writeHead(304, { etag: etag as string, connection: "close" });
      res.end();
      return;
    }
    const body = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
    if (r.stall) {
      res.writeHead(200, { "content-type": r.ctype, "content-length": "100000000", connection: "close" });
      res.write(body);
      return;
    }
    res.writeHead(r.status, { "content-type": r.ctype, "content-length": String(body.length), connection: "close", ...(r.headers ?? {}) });
    res.end(body);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Every request was a GET carrying `cookie`, and none sent an API token. */
export function assertReadOnlyWithSession(log: Seen[], cookie: string): void {
  if (log.length === 0) throw new Error("no requests were made");
  for (const s of log) {
    if (s.method !== "GET") throw new Error(`read-only: ${s.method} ${s.target}`);
    if (!s.cookie?.includes(cookie)) throw new Error(`the person's session: ${s.target} sent ${s.cookie}`);
    if (s.headers.authorization) throw new Error(`no API token: ${s.target}`);
  }
}
