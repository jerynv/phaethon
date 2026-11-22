/**
 * Which Phaethon this build is. A release is what people install from GitHub
 * releases; a dev build (`pnpm dist:dev`) is a copy made on a developer's own
 * machine that installs beside the release without touching it: its own app
 * name, identifier, app data, vault and keychain entries, no in-app updates and
 * no telemetry collector. scripts/build-node.mjs sets it from PHAETHON_CHANNEL;
 * anything unbundled (tests, `pnpm dev`) is a release.
 */

declare const __PHAETHON_CHANNEL__: string | undefined;

export type BuildChannel = "release" | "dev";

export type ChannelIdentity = {
  /** The app's name: Electron's userData folder, window and menu titles. */
  productName: string;
  /** Names the OS folders for app data and caches. */
  appIdentifier: string;
  /** The vault's folder in the home folder. */
  vaultFolder: string;
  /** The keychain service secrets are saved under. */
  keychainService: string;
};

export function identityOf(channel: BuildChannel): ChannelIdentity {
  return channel === "dev"
    ? { productName: "Phaethon Dev", appIdentifier: "io.github.jerynv.phaethon.dev", vaultFolder: "Phaethon Dev", keychainService: "phaethon-dev" }
    : { productName: "Phaethon", appIdentifier: "io.github.jerynv.phaethon", vaultFolder: "Phaethon", keychainService: "phaethon" };
}

export const CHANNEL: BuildChannel = typeof __PHAETHON_CHANNEL__ !== "undefined" && __PHAETHON_CHANNEL__ === "dev" ? "dev" : "release";
export const IDENTITY: ChannelIdentity = identityOf(CHANNEL);
