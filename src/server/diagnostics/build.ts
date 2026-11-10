/**
 * Whether this core runs inside a packaged release. The desktop shell sets
 * PHAETHON_PACKAGED=1 for a packaged app; anything else (development, tests,
 * a core started by hand) counts as a development build, as a Rust debug build did.
 */
export function isDevBuild(): boolean {
  return process.env.PHAETHON_PACKAGED !== "1";
}
