import { anotherActiveOwner, isStaffEmail, isStaffUsername, type StaffRole } from "./accounts.ts";
import { authenticate, countRequest, type StaffSession } from "./auth.ts";
import type { Env, Statement } from "./bindings.ts";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "./crypto.ts";
import { hasOnlyKeys, HttpError, isRecord, json, readJSON, requireSameOrigin } from "./http.ts";
import { MINUTE_MS } from "./settings.ts";

type StaffAction = "created" | "updated" | "sessions_revoked";

interface StaffFields {
  email: string;
  username: string;
  role: StaffRole;
  disabled: 0 | 1;
  password?: string;
}

const CREATE_FIELDS = ["email", "username", "role", "password"];
const UPDATE_FIELDS = [...CREATE_FIELDS, "disabled"];

// Permission can change while a password hash waits in the scrypt queue, so every write
// rechecks that the actor's own session is still a live owner session inside the statement.
const ACTOR_IS_OWNER = `EXISTS (SELECT 1 FROM staff actor JOIN sessions auth ON auth.staff_id = actor.id
  WHERE actor.id = ? AND actor.role = 'owner' AND actor.disabled = 0 AND auth.token_hash = ?
    AND auth.auth_version = actor.auth_version AND auth.expires_at > ?)`;

function isValidPassword(value: unknown): value is string {
  return (
    typeof value === "string" && value.length >= MIN_PASSWORD_LENGTH && value.length <= MAX_PASSWORD_LENGTH
  );
}

function parseStaffFields(value: unknown, creating: boolean): StaffFields | null {
  if (!isRecord(value) || !hasOnlyKeys(value, creating ? CREATE_FIELDS : UPDATE_FIELDS)) return null;
  const { role, disabled, password } = value;
  if (typeof value.email !== "string" || typeof value.username !== "string") return null;
  const email = value.email.trim().toLowerCase();
  const username = value.username.trim().toLowerCase();
  if (!isStaffEmail(email) || !isStaffUsername(username)) return null;
  if (role !== "owner" && role !== "viewer") return null;
  if (!creating && typeof disabled !== "boolean") return null;
  if (creating && password === undefined) return null;
  if (password !== undefined && !isValidPassword(password)) return null;
  return { email, username, role, disabled: !creating && disabled ? 1 : 0, password };
}

interface StaffRow {
  id: string;
  email: string;
  username: string;
  role: StaffRole;
  disabled: number;
}

async function listStaff(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, email, username, role, disabled FROM staff ORDER BY email",
  ).all<StaffRow>();
  return json({ items: results.map(row => ({ ...row, disabled: row.disabled === 1 })) });
}

async function listAudit(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, actor_email AS actorEmail, target_email AS targetEmail, action, created_at AS createdAt
     FROM staff_audit ORDER BY created_at DESC, id DESC LIMIT 100`,
  ).all();
  return json({ items: results });
}

function revokeSessions(env: Env, actor: StaffSession, id: string, version: string): Statement {
  return env.DB.prepare(`UPDATE staff SET auth_version = ? WHERE id = ? AND ${ACTOR_IS_OWNER}`)
    .bind(version, id, actor.id, actor.token_hash, Date.now());
}

function createStaff(
  env: Env,
  actor: StaffSession,
  id: string,
  version: string,
  fields: StaffFields,
  passwordHash: string | null,
): Statement {
  return env.DB.prepare(
    `INSERT INTO staff(id, email, username, role, password_hash, auth_version, disabled)
     SELECT ?, ?, ?, ?, ?, ?, 0 WHERE ${ACTOR_IS_OWNER}`,
  ).bind(
    ...[id, fields.email, fields.username, fields.role, passwordHash, version],
    ...[actor.id, actor.token_hash, Date.now()],
  );
}

function updateStaff(
  env: Env,
  actor: StaffSession,
  id: string,
  version: string,
  fields: StaffFields,
  passwordHash: string | null,
): Statement {
  // The last-owner check lives in the same statement as the update, so concurrent demotions
  // or disables can never remove the final active owner.
  return env.DB.prepare(
    `UPDATE staff SET email = ?, username = ?, role = ?, disabled = ?,
       password_hash = COALESCE(?, password_hash), auth_version = ?
     WHERE id = ? AND ${ACTOR_IS_OWNER}
       AND (role <> 'owner' OR disabled = 1 OR (? = 'owner' AND ? = 0) OR ${anotherActiveOwner("?")})`,
  ).bind(
    fields.email,
    fields.username,
    fields.role,
    fields.disabled,
    passwordHash,
    version,
    id,
    actor.id,
    actor.token_hash,
    Date.now(),
    fields.role,
    fields.disabled,
    id,
  );
}

/** A guarded write changed nothing: say whether the actor, the target or the last-owner rule stopped it. */
async function rejectedChange(request: Request, env: Env, id: string): Promise<Response> {
  const current = await authenticate(request, env);
  if (current.role !== "owner") throw new HttpError(403);
  const target = await env.DB.prepare("SELECT id FROM staff WHERE id = ?").bind(id).first();
  if (!target) throw new HttpError(404);
  return json({ error: "Keep at least one active super admin." }, 409);
}

/** Owner-only account administration under /api/staff. */
export async function staffRoute(request: Request, env: Env, actor: StaffSession): Promise<Response> {
  if (actor.role !== "owner") throw new HttpError(403);
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname === "/api/staff") return listStaff(env);
  if (request.method === "GET" && pathname === "/api/staff/audit") return listAudit(env);

  const target = /^\/api\/staff\/([0-9a-z-]+)(\/revoke)?$/.exec(pathname);
  const creating = pathname === "/api/staff" && request.method === "POST";
  const updating = !!target && !target[2] && request.method === "PATCH";
  const revoking = !!target?.[2] && request.method === "POST";
  if (!creating && !updating && !revoking) throw new HttpError(405);

  requireSameOrigin(request, env);
  await countRequest(env, "staff:actor", actor.id, 30, 15 * MINUTE_MS);
  const body = await readJSON(request, 8192);
  const id = creating ? crypto.randomUUID() : target![1];
  const version = crypto.randomUUID();

  let mutation: Statement;
  let action: StaffAction;
  if (revoking) {
    if (!isRecord(body) || Object.keys(body).length > 0) throw new HttpError(400);
    mutation = revokeSessions(env, actor, id, version);
    action = "sessions_revoked";
  } else {
    const fields = parseStaffFields(body, creating);
    if (!fields) {
      return json({ error: "Check the account fields. Passwords must contain 14–256 characters." }, 400);
    }
    const passwordHash = fields.password === undefined ? null : await hashPassword(fields.password);
    mutation = creating
      ? createStaff(env, actor, id, version, fields, passwordHash)
      : updateStaff(env, actor, id, version, fields, passwordHash);
    action = creating ? "created" : "updated";
  }

  // Selecting the target by its new auth_version writes the audit row only if the mutation applied.
  const audit = env.DB.prepare(
    `INSERT INTO staff_audit(id, actor_id, target_id, actor_email, target_email, action, created_at)
     SELECT ?, ?, id, ?, email, ?, ? FROM staff WHERE id = ? AND auth_version = ?`,
  ).bind(crypto.randomUUID(), actor.id, actor.email, action, new Date().toISOString(), id, version);

  let results: unknown[];
  try {
    results = await env.DB.batch([mutation, audit]);
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return json({ error: "That email or username is already in use." }, 409);
    }
    throw error;
  }
  const changes = (results[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  if (!changes) return rejectedChange(request, env, id);
  return json({ ok: true }, creating ? 201 : 200);
}
