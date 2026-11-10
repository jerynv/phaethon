import { randomBytes } from "node:crypto";
import { connectHost } from "./host.ts";
import { log } from "./log.ts";
import { runStart, runStop } from "./lifecycle.ts";
import { serve } from "./rpc/server.ts";
import "./commands.ts";

/**
 * The Node core. Under the desktop shell it is started with
 * `PHAETHON_HOST_FD=3`, receives its token over that pipe and reports its port
 * back. Standalone (tests, development in a browser) it takes
 * PHAETHON_TOKEN / PHAETHON_PORT / PHAETHON_ORIGINS / PHAETHON_WEB_ROOT and
 * prints one JSON line `{"t":"ready","port":…,"token":…}` on stdout.
 */
async function main(): Promise<void> {
  const hostFd = process.env.PHAETHON_HOST_FD ? Number(process.env.PHAETHON_HOST_FD) : undefined;
  let token: string;
  let origins: string[];
  let ready: (port: number) => void;

  if (hostFd !== undefined) {
    const connected = await connectHost(hostFd);
    token = connected.hello.token;
    origins = connected.hello.origins;
    process.env.PHAETHON_VERSION = connected.hello.appVersion;
    ready = connected.ready;
  } else {
    token = process.env.PHAETHON_TOKEN || randomBytes(32).toString("hex");
    origins = (process.env.PHAETHON_ORIGINS ?? "").split(",").filter(Boolean);
    ready = (port) => process.stdout.write(JSON.stringify({ t: "ready", port, token }) + "\n");
  }

  await runStart();

  const server = await serve({
    host: process.env.PHAETHON_BIND || "127.0.0.1",
    port: Number(process.env.PHAETHON_PORT || 0),
    token,
    origins,
    webRoot: process.env.PHAETHON_WEB_ROOT || undefined,
  });

  const stop = async (signal: string) => {
    log.info(`stopping (${signal})`);
    await runStop();
    await server.close();
    process.exit(0);
  };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void stop(signal));

  ready(server.port);
  log.info("core ready", { port: server.port });
}

main().catch((e) => {
  log.error("core failed to start", e);
  process.exit(1);
});
