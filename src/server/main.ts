import { randomBytes } from "node:crypto";
import { connectHost, parentPort } from "./host.ts";
import { log } from "./log.ts";
import { runStart, runStop } from "./lifecycle.ts";
import { serve } from "./rpc/server.ts";
import "./commands.ts";

/**
 * The Node core.
 *
 * Under the desktop shell it runs as an Electron utility process: the shell
 * says hello over the parent port, and each renderer connection arrives as a
 * MessagePort. No TCP port is opened.
 *
 * Standalone (tests, development in a browser, later the phone) it serves a
 * WebSocket, configured with PHAETHON_TOKEN / PHAETHON_PORT / PHAETHON_BIND /
 * PHAETHON_ORIGINS / PHAETHON_WEB_ROOT, and prints one JSON line
 * `{"t":"ready","port":…,"token":…}` on stdout.
 */
async function main(): Promise<void> {
  const parent = parentPort();
  let stopServer: () => Promise<void> = async () => {};

  if (parent) {
    const { hello, ready } = await connectHost(parent);
    process.env.PHAETHON_VERSION = hello.appVersion;
    await runStart();
    ready();
  } else {
    const token = process.env.PHAETHON_TOKEN || randomBytes(32).toString("hex");
    await runStart();
    const server = await serve({
      host: process.env.PHAETHON_BIND || "127.0.0.1",
      port: Number(process.env.PHAETHON_PORT || 0),
      token,
      origins: (process.env.PHAETHON_ORIGINS ?? "").split(",").filter(Boolean),
      webRoot: process.env.PHAETHON_WEB_ROOT || undefined,
    });
    stopServer = server.close;
    process.stdout.write(JSON.stringify({ t: "ready", port: server.port, token }) + "\n");
    log.info("core ready", { port: server.port });
  }

  const stop = async (signal: string) => {
    log.info(`stopping (${signal})`);
    await runStop();
    await stopServer();
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stop(signal));
}

main().catch((e) => {
  log.error("core failed to start", e);
  process.exit(1);
});
