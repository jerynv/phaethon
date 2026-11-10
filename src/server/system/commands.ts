import { commands } from "../rpc/registry.ts";
import { host } from "../host.ts";

/** Commands about the core itself. */
commands({
  core_info: () => ({
    version: process.env.PHAETHON_VERSION ?? "0.0.0-dev",
    platform: process.platform,
    desktop: host().available,
  }),
});
