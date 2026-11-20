/** Closed provisioning: passwords enter only through a hidden terminal prompt or stdin. */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../worker/crypto.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      if (size > 4096) throw new Error("Password input too long");
      chunks.push(bytes);
    }
    const password = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (/[\r\n]/.test(password)) throw new Error("Provide exactly one password line");
    return password;
  }
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
        if (error) reject(error); else resolve(password);
      };
      const onEnd = (): void => finish(new Error("Password input ended"));
      const onData = (chunk: Buffer): void => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\u0003" || character === "\u0004") { finish(new Error("Cancelled")); return; }
          if (character === "\r" || character === "\n") { finish(); return; }
          if (character === "\u007f" || character === "\b") password = Array.from(password).slice(0, -1).join("");
          else if (character >= " " && password.length <= 256) password += character;
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
function quote(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
export async function staffCLI(args: string[]): Promise<void> {
  const action = args.shift();
  if (!["provision", "revoke", "disable"].includes(action ?? "")) throw new Error("Use provision|revoke|disable --email EMAIL [--username NAME] [--role owner|viewer] [--remote]");
  const options = new Map<string, string>();
  let remote = false;
  let local = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--remote") { remote = true; continue; }
    if (flag === "--local") { local = true; continue; }
    if (flag !== "--email" && flag !== "--username" && flag !== "--role" && flag !== "--config" && flag !== "--persist-to") throw new Error("Unknown flag; passwords are accepted only via stdin/prompt");
    const value = args.shift();
    if (!value || value.startsWith("--") || options.has(flag)) throw new Error("Missing/duplicate option");
    options.set(flag, flag === "--email" || flag === "--username" ? value.toLowerCase() : value);
  }
  if (remote && (local || options.has("--persist-to"))) throw new Error("Remote and local options cannot be combined");
  const role = options.get("--role") ?? "viewer";
  if (role !== "owner" && role !== "viewer") throw new Error("Role must be owner or viewer");
  if (action !== "provision" && options.has("--role")) throw new Error("Role applies only to provision");
  const email = options.get("--email") ?? "";
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) throw new Error("A valid email is required");
  const version = crypto.randomUUID();
  let sql: string;
  if (action === "provision") {
    const username = options.get("--username") ?? "";
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw new Error("A 3–64 character username is required (letters, numbers, dots, underscores, hyphens)");
    const hash = await hashPassword(await readPassword());
    // auth_version revokes existing sessions atomically with password replacement.
    // Keep the owner check inside the write, including conflict updates.
    sql = `INSERT INTO staff(id,email,username,password_hash,auth_version,role) VALUES (${quote(crypto.randomUUID())},${quote(email)},${quote(username)},${quote(hash)},${quote(version)},${quote(role)})
      ON CONFLICT(email) DO UPDATE SET username=excluded.username,password_hash=excluded.password_hash,auth_version=excluded.auth_version,role=${options.has("--role") ? "excluded.role" : "staff.role"},disabled=0
      WHERE staff.role<>'owner' OR staff.disabled=1 OR ${options.has("--role") ? "excluded.role" : "staff.role"}='owner'
        OR EXISTS (SELECT 1 FROM staff other WHERE other.role='owner' AND other.disabled=0 AND other.id<>staff.id)
      RETURNING id;`;
  } else {
    sql = `UPDATE staff SET auth_version=${quote(version)}${action === "disable" ? ",disabled=1" : ""} WHERE email=${quote(email)}
      ${action === "disable" ? "AND (role<>'owner' OR disabled=1 OR EXISTS (SELECT 1 FROM staff other WHERE other.role='owner' AND other.disabled=0 AND other.id<>staff.id))" : ""}
      RETURNING id;`;
  }
  const directory = await mkdtemp(path.join(tmpdir(), "phaethon-staff-"));
  const file = path.join(directory, "staff.sql");
  const config = path.resolve(options.get("--config") ?? path.join(root, "wrangler.jsonc"));
  const state = options.get("--persist-to") ?? path.join(path.dirname(config), ".wrangler/state");
  try {
    await writeFile(file, sql, { mode: 0o600 });
    const execute = async (query: string[]): Promise<string> => {
      let output = "";
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["dlx", "wrangler@4.165.0", "d1", "execute", "DB", "--config", config, remote ? "--remote" : "--local", ...(!remote ? ["--persist-to", path.resolve(state)] : []), ...query, "--json"],
          { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", chunk => { output += String(chunk); });
        // Database diagnostics can include query text; never forward credentials.
        child.stderr.resume();
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (exitCode !== 0) throw new Error("Staff database operation failed");
      return output;
    };
    await execute(["--file", file]);
    // Remote --file uses D1's import API and returns an import summary, not
    // RETURNING rows. Confirm the fresh version with a read-only query instead.
    // Only a random version goes in argv; hashes stay in the private SQL file.
    const result = JSON.parse(await execute(["--command", `SELECT id FROM staff WHERE auth_version=${quote(version)};`])) as Array<{ results?: Array<{ id?: unknown }> }>;
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.results?.length !== 1 || typeof result[0].results[0]?.id !== "string") {
      throw new Error("Staff update rejected. Account must exist and at least one active super admin must remain.");
    }
    process.stdout.write(`Staff ${action} complete (${remote ? "remote" : "local"}).\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  staffCLI(process.argv.slice(2)).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "Staff update failed"}\n`); process.exitCode = 1; });
}
