import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { log } from "../log.ts";
import { MCP_SERVER, type ToolHost } from "./phaethon-tools.ts";

/**
 * Phaethon's tools as an MCP server (streamable HTTP, JSON responses) for
 * Claude Code and Gemini CLI. It listens on 127.0.0.1 only, and every turn
 * gets its own random token: a request without a live token is refused, and
 * the token stops working when the turn ends. Nothing else is served here.
 */

const PROTOCOL = "2025-06-18";
const MAX_BODY = 1024 * 1024;

const turns = new Map<string, ToolHost>();
let server: http.Server | undefined;
let listening: Promise<number> | undefined;

function reply(res: http.ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

function hostFor(req: http.IncomingMessage): ToolHost | undefined {
  const auth = req.headers.authorization ?? "";
  const m = /^Bearer ([a-f0-9]{64})$/.exec(auth);
  if (!m) return undefined;
  for (const [token, host] of turns) {
    const a = Buffer.from(token);
    const b = Buffer.from(m[1]!);
    if (a.length === b.length && timingSafeEqual(a, b)) return host;
  }
  return undefined;
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

async function answer(host: ToolHost, msg: Rpc): Promise<unknown | undefined> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL, capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER, version: "1" } });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: host.defs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.input_schema })) });
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const r = await host.call(name, msg.params?.arguments ?? {});
      return ok({ content: [{ type: "text", text: r.text }], isError: r.isError });
    }
    default:
      // Notifications (no id) are acknowledged; unknown requests are refused.
      if (msg.id === undefined) return undefined;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url ?? "";
  if (!url.startsWith("/mcp")) return reply(res, 404);
  const host = hostFor(req);
  if (!host) return reply(res, 401, { error: "This tool session has ended." });
  if (req.method === "GET") return reply(res, 405, undefined, { allow: "POST, DELETE" });
  if (req.method === "DELETE") return reply(res, 200);
  if (req.method !== "POST") return reply(res, 405);
  const chunks: Buffer[] = [];
  let size = 0;
  req.on("data", (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    let body: Rpc | Rpc[];
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return reply(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const list = Array.isArray(body) ? body : [body];
    Promise.all(list.map((m) => answer(host, m)))
      .then((out) => {
        const answers = out.filter((x) => x !== undefined);
        if (!answers.length) return reply(res, 202);
        reply(res, 200, Array.isArray(body) ? answers : answers[0], { "mcp-session-id": "phaethon" });
      })
      .catch((e) => {
        log.warn("mcp request failed", { error: String(e) });
        reply(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
      });
  });
}

function port(): Promise<number> {
  listening ??= new Promise((resolve, reject) => {
    server = http.createServer(handle);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
    server.unref();
  });
  return listening;
}

/** Opens Phaethon's tools for one turn; call `close` when the turn ends. */
export async function openTurnTools(host: ToolHost): Promise<{ url: string; token: string; close: () => void }> {
  const p = await port();
  const token = randomBytes(32).toString("hex");
  turns.set(token, host);
  return { url: `http://127.0.0.1:${p}/mcp`, token, close: () => turns.delete(token) };
}

/** Tests and shutdown. */
export function closeMcp(): void {
  turns.clear();
  server?.close();
  server = undefined;
  listening = undefined;
}
