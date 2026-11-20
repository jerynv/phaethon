import { MAX_EMAIL_LENGTH, type StaffRole } from "./accounts.ts";
import type { Env } from "./bindings.ts";
import { DUMMY_PASSWORD_HASH, MAX_PASSWORD_LENGTH, randomToken, sha256, verifyPassword } from "./crypto.ts";
import { hasOnlyKeys, HttpError, isRecord, json, readJSON, requireSameOrigin } from "./http.ts";
import { MINUTE_MS, sessionTtlSeconds } from "./settings.ts";

const SESSION_COOKIE = "__Host-phaethon_session";
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PRESENTED_SESSION = /(?:^|;\s*)__Host-phaethon_session=([A-Za-z0-9_-]{43})(?:;|$)/;

export interface StaffSession {
  id: string;
  email: string;
  role: StaffRole;
  token_hash: string;
}

const RATE_LIMITS = {
  login: { windowMs: 15 * MINUTE_MS, global: 120, perAddress: 20 },
  ingest: { windowMs: MINUTE_MS, global: 2000, perAddress: 60 },
} as const;

/** Counts one request against `limit` per fixed window of `windowMs`, throwing 429 once over. */
export async function countRequest(
  env: Env,
  scope: string,
  identity: string,
  limit: number,
  windowMs: number,
): Promise<void> {
  const bucket = Math.floor(Date.now() / windowMs);
  // Only a short-lived keyed digest is stored, so client addresses and account names never reach D1.
  const key = await sha256(`${env.ARCHIVE_RECEIPT_KEY}\n${scope}\n${bucket}\n${identity}`);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits(key, count, expires_at) VALUES (?, 1, ?)
     ON CONFLICT(key) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, (bucket + 1) * windowMs)
    .first<{ count: number }>();
  if (!row || row.count > limit) throw new HttpError(429);
}

export async function rateLimit(request: Request, env: Env, scope: keyof typeof RATE_LIMITS): Promise<void> {
  const { windowMs, global, perAddress } = RATE_LIMITS[scope];
  await countRequest(env, `${scope}:global`, "all", global, windowMs);
  const address = request.headers.get("CF-Connecting-IP") ?? "local";
  await countRequest(env, `${scope}:ip`, address, perAddress, windowMs);
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

function sessionToken(request: Request): string | undefined {
  const prefix = `${SESSION_COOKIE}=`;
  const cookie = request.headers
    .get("Cookie")
    ?.split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(prefix));
  return cookie?.slice(prefix.length);
}

/** Joining on auth_version means rotating a staff member's version revokes all their sessions at once. */
export async function authenticate(request: Request, env: Env): Promise<StaffSession> {
  const token = sessionToken(request);
  if (!token || !SESSION_TOKEN.test(token)) throw new HttpError(401);
  const session = await env.DB.prepare(
    `SELECT staff.id, staff.email, staff.role, sessions.token_hash
     FROM sessions JOIN staff ON staff.id = sessions.staff_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND staff.disabled = 0
       AND sessions.auth_version = staff.auth_version`,
  )
    .bind(await sha256(token), Date.now())
    .first<StaffSession>();
  if (!session) throw new HttpError(401);
  return session;
}

/** `email` accepts an email address or a username. */
function parseCredentials(value: unknown): { email: string; password: string } | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["email", "password"])) return null;
  const { email, password } = value;
  if (typeof email !== "string" || typeof password !== "string") return null;
  if (email.length > MAX_EMAIL_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  return { email, password };
}

interface StaffLogin {
  id: string;
  email: string;
  role: StaffRole;
  password_hash: string;
  disabled: number;
  auth_version: string;
}

export async function login(request: Request, env: Env): Promise<Response> {
  requireSameOrigin(request, env);
  await rateLimit(request, env, "login");
  const credentials = parseCredentials(await readJSON(request, 4096));
  if (!credentials) throw new HttpError(401);
  const identity = credentials.email.trim().toLowerCase();
  await countRequest(env, "login:account", identity, 10, 15 * MINUTE_MS);

  const staff = await env.DB.prepare(
    `SELECT id, email, role, password_hash, disabled, auth_version FROM staff
     WHERE email = ? OR username = ? LIMIT 1`,
  )
    .bind(identity, identity)
    .first<StaffLogin>();
  // Unknown accounts still pay for a full scrypt derivation, so timing doesn't reveal which exist.
  const valid = await verifyPassword(credentials.password, staff?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!staff || !valid || staff.disabled) throw new HttpError(401);

  const token = randomToken();
  const ttl = sessionTtlSeconds(env);
  // Signing in again ends the session this browser presented, in the same transaction.
  const presented = request.headers.get("Cookie")?.match(PRESENTED_SESSION)?.[1];
  const presentedHash = presented ? await sha256(presented) : "";
  const tokenHash = await sha256(token);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?").bind(presentedHash, now),
    env.DB.prepare(
      "INSERT INTO sessions(token_hash, staff_id, auth_version, expires_at) VALUES (?, ?, ?, ?)",
    ).bind(tokenHash, staff.id, staff.auth_version, now + ttl * 1000),
  ]);
  return json({ email: staff.email, role: staff.role }, 200, { "Set-Cookie": sessionCookie(token, ttl) });
}

export async function logout(request: Request, env: Env, session: StaffSession): Promise<Response> {
  requireSameOrigin(request, env);
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(session.token_hash).run();
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
}
