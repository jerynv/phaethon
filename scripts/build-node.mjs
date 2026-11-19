// Bundles the Node core (ESM) and the desktop shell (CommonJS, as Electron's
// main and sandboxed preload require). npm packages stay external: native
// modules and packages that load their own workers must resolve from
// node_modules at run time, and electron-builder ships production dependencies.
import { build } from "esbuild";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const watch = process.argv.includes("--watch");
// The release builder may embed the chosen public collector address. Normal
// builds have none; installed desktop apps need no per-user environment setup.
const telemetryEndpoint = process.env.PHAETHON_TELEMETRY_BUILD_ENDPOINT ?? "";
if (telemetryEndpoint) {
  const url = new URL(telemetryEndpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("The built-in telemetry collector must be an HTTPS address without credentials, query, or fragment.");
}
const common = {
  absWorkingDir: root,
  bundle: true,
  platform: "node",
  target: "node22",
  sourcemap: true,
  packages: "external",
  alias: { "#shared": path.join(root, "src/shared") },
  define: { __PHAETHON_TELEMETRY_ENDPOINT__: JSON.stringify(telemetryEndpoint) },
  // Prompt fragments (src/server/agent/prompts/*.md) and the LaTeX house style
  // (src/server/latex/phaethon.sty) are bundled as text.
  loader: { ".md": "text", ".sty": "text" },
  logLevel: "info",
};

const jobs = [
  { ...common, entryPoints: ["src/server/main.ts"], outfile: "dist/server/main.mjs", format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  // Reads PDFs and recognises text in a separate process (src/server/lms/text/child-process.ts finds it beside the core).
  { ...common, entryPoints: ["src/server/lms/text/child.ts"], outfile: "dist/server/text-child.mjs", format: "esm",
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } },
  { ...common, entryPoints: ["src/desktop/main.ts"], outfile: "dist/desktop/main.cjs", format: "cjs", external: ["electron"] },
  { ...common, entryPoints: ["src/desktop/preload.ts"], outfile: "dist/desktop/preload.cjs", format: "cjs", external: ["electron"] },
];

if (watch) {
  const { context } = await import("esbuild");
  for (const job of jobs) await (await context(job)).watch();
} else {
  await Promise.all(jobs.map((job) => build(job)));
}
