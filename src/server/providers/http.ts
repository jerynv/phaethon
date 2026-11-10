/**
 * HTTP pieces shared by the providers: requests that never follow redirects
 * (a key must only ever reach its own provider's address), retry waits that
 * honour `retry-after`, an idle timeout while streaming, and a byte-level
 * server-sent-events splitter that survives a UTF-8 character split across
 * packets.
 */

export const IDLE_TIMEOUT_MS = 180_000;
export const RETRIES = 3;
export const MAX_RETRY_WAIT = 30;

/** Seconds from a `retry-after` header: a finite number ≥ 0, rounded up. HTTP dates are ignored. */
export function retryAfterSecs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const n = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(n) || n < 0) return undefined;
  return Math.ceil(n);
}

/** Wait before attempt `attempt + 1`: the server's wait (at most 30 s), else 1 s, 2 s, … */
export function backoffMs(attempt: number, retryAfter?: number): number {
  if (retryAfter !== undefined) return Math.min(retryAfter, MAX_RETRY_WAIT) * 1000;
  return 1000 * 2 ** (attempt - 1);
}

export function shouldRetry(kind: string, retryAfter: number | undefined, attempt: number): boolean {
  return (kind === "rateLimit" || kind === "unavailable") && (retryAfter === undefined || retryAfter <= MAX_RETRY_WAIT) && attempt < RETRIES;
}

/** The tail of a rate-limit message. */
export function rateLimitSuffix(secs: number | undefined): string {
  if (secs === undefined) return " Wait a minute, then try again.";
  if (secs <= 1) return " Try again in a moment.";
  if (secs < 120) return ` Try again in ${secs} seconds.`;
  return ` Try again in ${Math.ceil(secs / 60)} minutes.`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

export class TimeoutError extends Error {}

/**
 * `fetch` with redirects refused (the 3xx comes back as a response) and an
 * optional total timeout. `signal` cancels.
 */
export async function request(url: string, init: RequestInit & { timeoutMs?: number }, signal?: AbortSignal): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  // The caller's signal stays attached for the whole body, so a cancel also stops a stream in progress.
  const signals = [signal, timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined].filter((s): s is AbortSignal => !!s);
  return fetch(url, { ...rest, redirect: "manual", signal: signals.length ? AbortSignal.any(signals) : undefined });
}

/** Reads a whole small body, for errors and JSON replies; never throws. */
export async function bodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** True for a refused or unreachable connection (nothing listening). */
export function isConnectError(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (e as { code?: string })?.code;
  return code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "UND_ERR_CONNECT_TIMEOUT";
}

export class StreamDropped extends Error {}
export class StreamIdle extends Error {}

/**
 * Server-sent events from a response body. Each yielded value is the joined
 * `data:` lines of one event (an event ends at the first blank line, `\n\n` or
 * `\r\n\r\n`); comment-only events yield "". A trailing event without a blank
 * line is yielded at the end. Throws `StreamIdle` after `idleMs` of silence
 * and `StreamDropped` when reading fails.
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal: AbortSignal, idleMs = IDLE_TIMEOUT_MS): AsyncGenerator<string> {
  const reader = body.getReader();
  let buf = Buffer.alloc(0);
  const decode = (bytes: Buffer) => {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)))
      .join("\n");
  };
  try {
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StreamIdle("idle")), idleMs);
      });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } catch (e) {
        if (signal.aborted || e instanceof StreamIdle) throw e;
        throw new StreamDropped(String(e));
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf = Buffer.concat([buf, Buffer.from(chunk.value)]);
      for (;;) {
        const a = buf.indexOf("\n\n");
        const b = buf.indexOf("\r\n\r\n");
        let end = -1;
        let len = 0;
        if (a >= 0 && (b < 0 || a <= b)) [end, len] = [a, 2];
        else if (b >= 0) [end, len] = [b, 4];
        if (end < 0) break;
        const event = buf.subarray(0, end);
        buf = buf.subarray(end + len);
        yield decode(event);
      }
    }
    if (buf.length && buf.toString("utf8").trim()) yield decode(buf);
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Parses JSON, or undefined. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
