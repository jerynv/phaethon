import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { attach } from "./connection.ts";
import { log } from "../log.ts";

/**
 * The WebSocket transport, used when the core runs on its own: tests, and a
 * page the core serves itself (later, the phone over Tailscale). The desktop
 * app doesn't use it: its renderer talks to the core over a MessagePort and
 * the core opens no port at all.
 */

export type ServeOptions = {
  host: string;
  port: number;
  token: string;
  /**
   * Origins a browser may connect from, besides the page's own. A request with
   * no Origin (a non-browser client such as a test) still needs the token; a
   * `null` Origin is refused.
   */
  origins: string[];
  /** Serve a built UI from this folder (tests, and later the phone over Tailscale). */
  webRoot?: string;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

/** The policy the desktop shell also sends; a served page gets the same one. */
export function contentSecurityPolicy(coreOrigin: string): string {
  const ws = coreOrigin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    `connect-src 'self' ${coreOrigin} ${ws}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function serve(options: ServeOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (!options.webRoot || req.method !== "GET") {
      res.writeHead(404).end();
      return;
    }
    const root = path.resolve(options.webRoot);
    let file = path.resolve(root, "." + decodeURIComponent(url.pathname));
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const origin = `http://${req.headers.host ?? `${options.host}:${options.port}`}`;
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "content-security-policy": contentSecurityPolicy(origin),
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const origin = req.headers.origin;
    const selfOrigin = `http://${req.headers.host}`;
    const originOk = origin === undefined || (origin !== "null" && (origin === selfOrigin || options.origins.includes(origin)));
    const token = url.searchParams.get("token") ?? "";
    if (url.pathname !== "/ws" || !originOk || !sameToken(token, options.token)) {
      log.warn("refused a connection", { path: url.pathname, origin, originOk });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connection(ws));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      options.port = port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

function connection(ws: WebSocket): void {
  ws.on("error", (e) => log.warn("connection error", { message: e.message }));
  ws.on("close", (code) => {
    log.debug("connection closed", { code });
  });
  attach({
    send: (text) => {
      if (ws.readyState !== ws.OPEN) return false;
      ws.send(text);
      return true;
    },
    onMessage: (listener) => ws.on("message", (data) => listener(String(data))),
    onClose: (listener) => ws.on("close", listener),
  });
}
