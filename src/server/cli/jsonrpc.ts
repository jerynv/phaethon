// Adapted from T3 Code (https://github.com/pingdotgg/t3code), MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// (The JSONL framing and request correlation of packages/effect-codex-app-server/src/protocol.ts, as plain async TypeScript.)
import type { Readable, Writable } from "node:stream";
import { readLines } from "./process.ts";

/**
 * JSON-RPC 2.0 over newline-delimited JSON on a child's stdio: what
 * `codex app-server` and ACP agents (`gemini --acp`) speak. Requests are
 * correlated by id; the peer's own requests are answered by `onRequest`
 * (an unknown method gets "method not found"); notifications go to
 * `onNotification`. Lines that aren't JSON are ignored.
 */

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export class PeerClosed extends Error {
  constructor() {
    super("The assistant closed its connection.");
    this.name = "PeerClosed";
  }
}

export type PeerOptions = {
  /** Include `"jsonrpc":"2.0"` in what we send (ACP wants it; Codex accepts either). */
  jsonrpc?: boolean;
  onNotification?: (method: string, params: unknown) => void;
  /** Answers a request from the peer; throw an RpcError to answer with an error. */
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;
  /** Longest line accepted (T3 uses 128 MB for Codex). */
  maxLine?: number;
};

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class JsonRpcPeer {
  #next = 1;
  #pending = new Map<number | string, Pending>();
  #closed = false;
  /** Resolves when the peer's output ends. */
  readonly ended: Promise<void>;

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly opts: PeerOptions = {},
  ) {
    this.ended = readLines(output, (line) => this.#onLine(line), opts.maxLine ?? 128 * 1024 * 1024).then(() => this.close());
  }

  get closed(): boolean {
    return this.#closed;
  }

  #send(msg: Record<string, unknown>): void {
    if (this.#closed || this.input.destroyed || this.input.writableEnded) return;
    const framed = this.opts.jsonrpc ? { jsonrpc: "2.0", ...msg } : msg;
    try {
      this.input.write(`${JSON.stringify(framed)}\n`);
    } catch {
      // The peer is gone; its pending requests fail when its output ends.
    }
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new PeerClosed());
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#send({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.#send({ method, params });
  }

  /** Fails every pending request; later requests fail at once. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new PeerClosed());
    this.#pending.clear();
  }

  #onLine(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      const v = JSON.parse(line);
      if (!v || typeof v !== "object" || Array.isArray(v)) return;
      msg = v;
    } catch {
      return;
    }
    const id = msg.id as number | string | undefined | null;
    const method = typeof msg.method === "string" ? msg.method : undefined;
    if (method !== undefined && id !== undefined && id !== null) {
      void this.#answer(id, method, msg.params);
    } else if (method !== undefined) {
      try {
        this.opts.onNotification?.(method, msg.params);
      } catch {
        // a listener's failure must not stop the stream
      }
    } else if (id !== undefined && id !== null) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      const error = msg.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
      if (error && typeof error === "object") {
        pending.reject(new RpcError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : "Request failed.", error.data));
      } else pending.resolve(msg.result);
    }
  }

  async #answer(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.opts.onRequest) {
      this.#send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      return;
    }
    try {
      const result = await this.opts.onRequest(method, params);
      this.#send({ id, result: result ?? null });
    } catch (e) {
      const err = e instanceof RpcError ? e : new RpcError(-32603, e instanceof Error ? e.message : String(e));
      this.#send({ id, error: { code: err.code, message: err.message } });
    }
  }
}
