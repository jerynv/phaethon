import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type net from "node:net";
import { Cancelled } from "./types.ts";

/**
 * A small HTTP client over node:http(s) for talking to course sites, with what
 * `fetch` doesn't give: no automatic redirects or decompression (sizes and
 * hashes are over the bytes as sent), a connect timeout separate from the total
 * one, and an optional DNS `lookup` so a checked address is the one connected
 * to. Bodies are read only when asked, with a cap.
 */

export const USER_AGENT = `Phaethon/${process.env.PHAETHON_VERSION ?? "0.2.0"}`;

export type RequestOptions = {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | Buffer;
  connectTimeoutMs?: number;
  totalTimeoutMs?: number;
  signal?: AbortSignal;
  /** Replaces DNS resolution for this request (used to pin a checked public address). */
  lookup?: net.LookupFunction;
};

export class HttpError extends Error {
  constructor(
    message: string,
    readonly timeout = false,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpResponse {
  #consumed = false;
  constructor(
    readonly status: number,
    readonly url: URL,
    private readonly res: http.IncomingMessage,
    private readonly done: () => void,
  ) {}

  header(name: string): string | undefined {
    const v = this.res.headers[name.toLowerCase()];
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v.join(", ") : v;
  }

  /** Every value of a header (each `Set-Cookie`, each `Link`). */
  headerAll(name: string): string[] {
    const v = this.res.headers[name.toLowerCase()];
    if (v === undefined) return [];
    return Array.isArray(v) ? v : [v];
  }

  /** Header names, lowercased. */
  headerNames(): string[] {
    return Object.keys(this.res.headers);
  }

  contentLength(): number | null {
    const v = this.header("content-length");
    if (v === undefined || !/^\d+$/.test(v.trim())) return null;
    return Number(v.trim());
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300;
  }

  /** The body's chunks as they arrive. */
  async *chunks(): AsyncGenerator<Buffer> {
    if (this.#consumed) return;
    this.#consumed = true;
    try {
      for await (const chunk of this.res) yield chunk as Buffer;
    } finally {
      this.done();
    }
  }

  /** The whole body; with `limit`, stops reading once more than `limit` bytes came (returns what it has). */
  async bytes(limit = Number.POSITIVE_INFINITY): Promise<Buffer> {
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of this.chunks()) {
      parts.push(chunk);
      size += chunk.length;
      if (size > limit) {
        this.discard();
        break;
      }
    }
    return Buffer.concat(parts);
  }

  async text(limit?: number): Promise<string> {
    return (await this.bytes(limit)).toString("utf8");
  }

  /** Drops the body without reading it. */
  discard(): void {
    this.#consumed = true;
    this.res.destroy();
    this.done();
  }
}

/** One request, no redirects followed. Network failures reject with `HttpError`; an abort with `Cancelled`. */
export function request(url: URL, options: RequestOptions = {}): Promise<HttpResponse> {
  const { method = "GET", headers = {}, body, connectTimeoutMs = 15_000, totalTimeoutMs = 120_000, signal, lookup } = options;
  if (signal?.aborted) return Promise.reject(new Cancelled());
  const mod = url.protocol === "https:" ? https : url.protocol === "http:" ? http : null;
  if (!mod) return Promise.reject(new HttpError(`unsupported scheme ${url.protocol}`));
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    let total: NodeJS.Timeout | undefined;
    let connect: NodeJS.Timeout | undefined;
    const allHeaders: Record<string, string> = { "user-agent": USER_AGENT, "accept-encoding": "identity", ...headers };
    if (body !== undefined) allHeaders["content-length"] = String(Buffer.byteLength(body));
    const req = mod.request(url, { method, headers: allHeaders, agent: false, lookup });
    const cleanup = () => {
      clearTimeout(total);
      clearTimeout(connect);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(e);
    };
    const onAbort = () => {
      fail(new Cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    total = setTimeout(() => fail(new HttpError("operation timed out", true)), totalTimeoutMs);
    connect = setTimeout(() => fail(new HttpError("connection timed out", true)), connectTimeoutMs);
    req.on("socket", (socket: net.Socket) => {
      if (!socket.connecting) clearTimeout(connect);
      else socket.once("connect", () => clearTimeout(connect));
      socket.once("secureConnect", () => clearTimeout(connect));
    });
    req.on("error", (e) => fail(e instanceof Cancelled ? e : new HttpError(describe(e))));
    req.on("response", (res) => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      clearTimeout(connect);
      // The total timeout and the caller's signal keep covering the body.
      const stopBody = () => res.destroy(signal?.aborted ? new Cancelled() : new HttpError("operation timed out", true));
      clearTimeout(total);
      total = setTimeout(stopBody, totalTimeoutMs);
      signal?.removeEventListener("abort", onAbort);
      const abortBody = () => res.destroy(new Cancelled());
      signal?.addEventListener("abort", abortBody, { once: true });
      const done = () => {
        clearTimeout(total);
        signal?.removeEventListener("abort", abortBody);
      };
      res.once("end", done);
      res.once("close", done);
      resolve(new HttpResponse(res.statusCode ?? 0, url, res, done));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function describe(e: Error): string {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `error sending request: dns error: ${e.message}`;
  if (code === "ECONNREFUSED") return `error sending request: connection refused`;
  return `error sending request: ${e.message}`;
}

/** `dns.lookup` with every address, for checking all of them before connecting. */
export function lookupAll(host: string): Promise<dns.LookupAddress[]> {
  return dns.promises.lookup(host, { all: true, verbatim: true });
}
