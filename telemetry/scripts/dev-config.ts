/** Generates a LOCAL ONLY config and receipt key in an explicitly selected private directory. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = process.argv[2];
if (!directory || process.argv.length !== 3) throw new Error("Usage: tsx telemetry/scripts/dev-config.ts /absolute/private/local-directory");
if (!path.isAbsolute(directory)) throw new Error("Choose an absolute path outside the repository");
const root = fileURLToPath(new URL("../../", import.meta.url));
const resolved = path.resolve(directory);
if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) throw new Error("Local state must be outside the repository");
await mkdir(resolved, { recursive: true, mode: 0o700 });
const assets = path.join(resolved, "assets");
await mkdir(assets, { recursive: true, mode: 0o700 });
await writeFile(path.join(assets, "index.html"), "<!doctype html><title>Phaethon telemetry local backend</title><p>Local backend running. Build the console to preview its interface.</p>\n", { mode: 0o600, flag: "wx" });
const config = {
  name: "phaethon-telemetry-local", main: path.join(root, "telemetry/worker/index.ts"),
  compatibility_date: "2026-11-01", compatibility_flags: ["nodejs_compat"],
  assets: { directory: assets, binding: "ASSETS", not_found_handling: "single-page-application", run_worker_first: true },
  d1_databases: [{ binding: "DB", database_name: "phaethon-telemetry-local", database_id: "00000000-0000-0000-0000-000000000001", migrations_dir: path.join(root, "telemetry/migrations") }],
  r2_buckets: [{ binding: "RAW", bucket_name: "phaethon-telemetry-local" }],
  vars: { CONSOLE_ORIGIN: "http://localhost:8787", CONTENT_RETENTION_DAYS: "90", METADATA_RETENTION_DAYS: "365" },
  triggers: { crons: ["*/10 * * * *"] }, observability: { enabled: false },
};
await writeFile(path.join(resolved, "wrangler.json"), JSON.stringify(config, null, 2), { mode: 0o600, flag: "wx" });
await writeFile(path.join(resolved, ".dev.vars"), `ARCHIVE_RECEIPT_KEY=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`Local configuration created at ${path.join(resolved, "wrangler.json")} (secret not printed).\n`);
