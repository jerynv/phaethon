import type { Env } from "./bindings.ts";

/** Thrown to end a request with `status`; the body is a fixed message chosen by errorResponse. */
export class HttpError extends Error {
  constructor(readonly status: number) {
    super();
  }
}

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(value, { status, headers });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every(key => allowed.includes(key));
}

const JSON_CONTENT_TYPE = /^application\/json(?:\s*;|$)/i;

/** Reads a JSON body, enforcing `maxBytes` as the body streams in since Content-Length is optional. */
export async function readJSON(request: Request, maxBytes: number): Promise<unknown> {
  if (!JSON_CONTENT_TYPE.test(request.headers.get("Content-Type") ?? "")) throw new HttpError(415);
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)) {
    throw new HttpError(413);
  }
  if (!request.body) throw new HttpError(400);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new HttpError(413);
      }
      chunks.push(value);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400);
  } finally {
    reader.releaseLock();
  }
}

/** Cookie-authenticated writes must come from the console's own pages. */
export function requireSameOrigin(request: Request, env: Env): void {
  const origin = request.headers.get("Origin");
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  const sentByConsole = !!origin && origin === env.CONSOLE_ORIGIN;
  const servedByConsole = new URL(request.url).origin === env.CONSOLE_ORIGIN;
  const fetchSiteAllowed = fetchSite === null || fetchSite === "same-origin" || fetchSite === "none";
  if (!sentByConsole || !servedByConsole || !fetchSiteAllowed) throw new HttpError(403);
}

const ERROR_MESSAGES: Partial<Record<number, string>> = {
  401: "Unauthorized",
  429: "Too many requests",
  503: "Temporarily unavailable",
};
const RETRY_AFTER_SECONDS: Partial<Record<number, string>> = { 429: "900", 503: "30" };

/** Any error that isn't an HttpError (D1, R2, a tampered archive, bad configuration) becomes a 503. */
export function errorResponse(error: unknown): Response {
  const status = error instanceof HttpError ? error.status : 503;
  const message = ERROR_MESSAGES[status] ?? "Request rejected";
  const retryAfter = RETRY_AFTER_SECONDS[status];
  return json({ error: message }, status, retryAfter ? { "Retry-After": retryAfter } : undefined);
}

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function withSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
