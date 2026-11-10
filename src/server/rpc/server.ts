import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BYTES_KEY, isChannelRef, type ClientFrame, type ServerFrame } from "#shared/wire.ts";
import { Channel } from "./channel.ts";
import { handlerFor, messageOf, Refusal } from "./registry.ts";
import { log } from "../log.ts";

export type ServeOptions = {
  host: string;
  port: number;
  token: string;
  /** Origins a browser may connect from. A request with no Origin (not a browser) still needs the token. */
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

function encodeResult(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES_KEY]: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64") };
  if (value instanceof ArrayBuffer) return { [BYTES_KEY]: Buffer.from(value).toString("base64") };
  return value === undefined ? null : value;
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
    const originOk = !origin || origin === selfOrigin || options.origins.includes(origin);
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
  const abort = new AbortController();
  const channels = new Map<number, Channel>();
  const send = (frame: ServerFrame): boolean => {
    if (ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  };

  const revive = (value: unknown): unknown => {
    if (isChannelRef(value)) {
      const id = value.__phaethonChannel;
      const channel = new Channel(id, (msg) => send({ t: "ch", ch: id, msg }));
      channels.set(id, channel);
      channel.onClose(() => channels.delete(id));
      return channel;
    }
    if (Array.isArray(value)) return value.map(revive);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = revive(v);
      return out;
    }
    return value;
  };

  ws.on("message", async (data) => {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(data)) as ClientFrame;
    } catch {
      return;
    }
    if (frame.t === "ping") {
      send({ t: "pong" });
      return;
    }
    if (frame.t === "close") {
      channels.get(frame.ch)?.close();
      return;
    }
    if (frame.t !== "req") return;
    const handler = handlerFor(frame.cmd);
    if (!handler) {
      send({ t: "err", id: frame.id, error: `Unknown command ${frame.cmd}.` });
      return;
    }
    try {
      const value = await handler(revive(frame.args ?? {}), { signal: abort.signal });
      send({ t: "ok", id: frame.id, value: encodeResult(value) });
    } catch (e) {
      if (!(e instanceof Refusal) && typeof e !== "string") log.error(`command ${frame.cmd} failed`, e);
      send({ t: "err", id: frame.id, error: messageOf(e) });
    }
  });

  ws.on("close", () => {
    abort.abort();
    for (const channel of [...channels.values()]) channel.close();
  });
}
