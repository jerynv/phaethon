/**
 * Whether this core runs inside a packaged release. The desktop shell sets
 * PHAETHON_PACKAGED=1 for a packaged app; anything else (development, tests,
 * a core started by hand) counts as a development build, as a Rust debug build did.
 */
export function isDevBuild(): boolean {
  return process.env.PHAETHON_PACKAGED !== "1";
}

/**
 * Whether this app can install an update over itself: a packaged release whose
 * installer left electron-updater its app-update.yml. The shell sets
 * PHAETHON_SELF_UPDATE=0 for a dev build and for a release packaged on someone's
 * own machine without an updatable target (`electron-builder --dir`).
 */
export function canSelfUpdate(): boolean {
  return !isDevBuild() && process.env.PHAETHON_SELF_UPDATE !== "0";
}
