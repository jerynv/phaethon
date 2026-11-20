/** Closed provisioning: passwords enter only through a hidden terminal prompt or stdin. */
import spawn from "cross-spawn";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { anotherActiveOwner, isStaffEmail, isStaffUsername } from "../worker/accounts.ts";
import { hashPassword, MAX_PASSWORD_LENGTH } from "../worker/crypto.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER = "wrangler@4.165.0";
const MAX_PIPED_PASSWORD_BYTES = 4096;
const ACTIONS = ["provision", "revoke", "disable"];
const VALUE_FLAGS = ["--email", "--username", "--role", "--config", "--persist-to"];
const USAGE = "Use provision|revoke|disable --email EMAIL [--username NAME] [--role owner|viewer] [--remote]";

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const DELETE = "\u007f";

async function readPipedPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > MAX_PIPED_PASSWORD_BYTES) throw new Error("Password input too long");
    chunks.push(bytes);
  }
  const password = Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "");
  if (/[\r\n]/.test(password)) throw new Error("Provide exactly one password line");
  return password;
}

async function promptPassword(): Promise<string> {
  process.stderr.write("Staff password (14–256 characters, hidden): ");
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let password = "";
      const finish = (error?: Error): void => {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
        if (error) reject(error);
        else resolve(password);
      };
      const onEnd = (): void => finish(new Error("Password input ended"));
      const onData = (chunk: Buffer): void => {
        for (const character of chunk.toString("utf8")) {
          if (character === CTRL_C || character === CTRL_D) return finish(new Error("Cancelled"));
          if (character === "\r" || character === "\n") return finish();
          if (character === DELETE || character === "\b") {
            password = Array.from(password).slice(0, -1).join("");
          } else if (character >= " " && password.length <= MAX_PASSWORD_LENGTH) {
            // One character past the limit is kept so hashPassword reports the overlong password.
            password += character;
          }
        }
      };
      process.stdin.on("data", onData);
      process.stdin.on("end", onEnd);
    });
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
    process.stderr.write("\n");
  }
}

export async function readPassword(): Promise<string> {
  return process.stdin.isTTY ? promptPassword() : readPipedPassword();
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

interface StaffCommand {
  action: string;
  options: Map<string, string>;
  remote: boolean;
}

function parseArgs(args: string[]): StaffCommand {
  const [action, ...flags] = args;
  if (!ACTIONS.includes(action ?? "")) throw new Error(USAGE);
  const options = new Map<string, string>();
  let remote = false;
  let local = false;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--remote") {
      remote = true;
      continue;
    }
    if (flag === "--local") {
      local = true;
      continue;
    }
    if (!VALUE_FLAGS.includes(flag)) {
      throw new Error("Unknown flag; passwords are accepted only via stdin/prompt");
    }
    const value = flags[++index];
    if (!value || value.startsWith("--") || options.has(flag)) throw new Error("Missing/duplicate option");
    options.set(flag, flag === "--email" || flag === "--username" ? value.toLowerCase() : value);
  }
  if (remote && (local || options.has("--persist-to"))) {
    throw new Error("Remote and local options cannot be combined");
  }
  return { action, options, remote };
}

/**
 * Creates the account, or replaces an existing account's username and password. A new
 * auth_version revokes existing sessions in the same statement, and the last-owner guard sits
 * in the conflict update's WHERE clause so it can't race another write.
 */
function provisionSql(account: {
  email: string;
  username: string;
  role: string;
  roleGiven: boolean;
  hash: string;
  version: string;
}): string {
  const { email, username, role, roleGiven, hash, version } = account;
  const resultingRole = roleGiven ? "excluded.role" : "staff.role";
  const values = [crypto.randomUUID(), email, username, hash, version, role].map(quote).join(", ");
  return `INSERT INTO staff(id, email, username, password_hash, auth_version, role) VALUES (${values})
  ON CONFLICT(email) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash,
    auth_version = excluded.auth_version, role = ${resultingRole}, disabled = 0
  WHERE staff.role <> 'owner' OR staff.disabled = 1 OR ${resultingRole} = 'owner'
    OR ${anotherActiveOwner("staff.id")}
  RETURNING id;`;
}

function revokeSql(email: string, version: string, disable: boolean): string {
  if (!disable) {
    return `UPDATE staff SET auth_version = ${quote(version)} WHERE email = ${quote(email)} RETURNING id;`;
  }
  return `UPDATE staff SET auth_version = ${quote(version)}, disabled = 1 WHERE email = ${quote(email)}
  AND (role <> 'owner' OR disabled = 1 OR ${anotherActiveOwner("staff.id")})
  RETURNING id;`;
}

function runWrangler(command: StaffCommand, config: string, state: string, cwd: string, query: string[]) {
  const target = command.remote ? ["--remote"] : ["--local", "--persist-to", path.resolve(state)];
  const args = ["dlx", WRANGLER, "d1", "execute", "DB", "--config", config, ...target, ...query, "--json"];
  return new Promise<string>((resolve, reject) => {
    let output = "";
    const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", chunk => {
      output += String(chunk);
    });
    // Database diagnostics can include query text, so stderr is drained but never forwarded.
    child.stderr!.resume();
    child.once("error", reject);
    child.once("close", exitCode => {
      if (exitCode === 0) resolve(output);
      else reject(new Error("Staff database operation failed"));
    });
  });
}

function confirmedOneRow(output: string): boolean {
  const result = JSON.parse(output) as Array<{ results?: Array<{ id?: unknown }> }>;
  return (
    Array.isArray(result) &&
    result.length === 1 &&
    result[0]?.results?.length === 1 &&
    typeof result[0].results[0]?.id === "string"
  );
}

export async function staffCLI(args: string[]): Promise<void> {
  const command = parseArgs(args);
  const { action, options } = command;
  const role = options.get("--role") ?? "viewer";
  if (role !== "owner" && role !== "viewer") throw new Error("Role must be owner or viewer");
  if (action !== "provision" && options.has("--role")) throw new Error("Role applies only to provision");
  const email = options.get("--email") ?? "";
  if (!isStaffEmail(email)) throw new Error("A valid email is required");

  const version = crypto.randomUUID();
  let sql: string;
  if (action === "provision") {
    const username = options.get("--username") ?? "";
    if (!isStaffUsername(username)) {
      throw new Error("A 3–64 character username is required (letters, numbers, dots, underscores, hyphens)");
    }
    const hash = await hashPassword(await readPassword());
    sql = provisionSql({ email, username, role, roleGiven: options.has("--role"), hash, version });
  } else {
    sql = revokeSql(email, version, action === "disable");
  }

  const directory = await mkdtemp(path.join(tmpdir(), "phaethon-staff-"));
  const file = path.join(directory, "staff.sql");
  const config = path.resolve(options.get("--config") ?? path.join(root, "wrangler.jsonc"));
  const state = options.get("--persist-to") ?? path.join(path.dirname(config), ".wrangler/state");
  try {
    await writeFile(file, sql, { mode: 0o600 });
    await runWrangler(command, config, state, directory, ["--file", file]);
    // Remote --file goes through D1's import API, which returns an import summary rather than
    // RETURNING rows, so a read-only query confirms the new version instead. Only that random
    // version goes in argv; password hashes stay in the private SQL file.
    const check = `SELECT id FROM staff WHERE auth_version=${quote(version)};`;
    const output = await runWrangler(command, config, state, directory, ["--command", check]);
    if (!confirmedOneRow(output)) {
      throw new Error(
        "Staff update rejected. Account must exist and at least one active super admin must remain.",
      );
    }
    process.stdout.write(`Staff ${action} complete (${command.remote ? "remote" : "local"}).\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  staffCLI(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : "Staff update failed"}\n`);
    process.exitCode = 1;
  });
}
