import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import tauriConf from "./src-tauri/tauri.conf.json" with { type: "json" };

const host = process.env.TAURI_DEV_HOST;

/**
 * On desktop, `tauri dev` loads the Vite server directly, so Tauri never injects
 * `devCsp` (it only proxies the dev server on mobile). Serve the same policy as a
 * header from Vite so dev runs under the CSP too. Single source: tauri.conf.json.
 */
const devCsp = Object.entries(tauriConf.app.security.devCsp)
  .map(([directive, sources]) => `${directive} ${sources}`)
  .join("; ");

/**
 * The installed packages (their folders in pnpm's store) that `roots` need,
 * all the way down. pnpm puts a package's own dependencies beside it.
 */
function packagesOf(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const visit = (dir: string) => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    // Its dependencies sit in the node_modules folder that holds it (two up for a scoped name).
    const parent = path.dirname(real);
    const store = path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
    if (path.basename(store) !== "node_modules") return;
    for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const at = path.join(store, entry.name);
      if (entry.name.startsWith("@")) for (const sub of fs.readdirSync(at)) visit(path.join(at, sub));
      else visit(at);
    }
  };
  for (const r of roots) visit(path.join(import.meta.dirname, "node_modules", r));
  return seen;
}

/**
 * Code only a lazily loaded library needs (mermaid for diagrams, pdf.js for
 * PDFs) is left out of the groups below, so Rolldown's own chunking splits it
 * the way the library's dynamic imports do, loaded on first use, instead of
 * folding it into an eager chunk. Anything the rest of the app uses too
 * (KaTeX, say) stays in its group.
 */
const deps = Object.keys((JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "package.json"), "utf8")) as { dependencies: Record<string, string> }).dependencies);
const LAZY = ["mermaid", "pdfjs-dist"];
const eager = packagesOf(deps.filter((d) => !LAZY.includes(d)));
const lazyOnly = (root: string) => [...packagesOf([root])].filter((dir) => !eager.has(dir));
const inPackages = (dirs: string[]) => (id: string) => dirs.some((d) => id.startsWith(d + path.sep));
const LAZY_ONLY = inPackages(LAZY.flatMap(lazyOnly));
/** A group's matcher, never taking code only a lazy library needs. */
const eagerly = (re: RegExp) => (id: string) => re.test(id) && !LAZY_ONLY(id);

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    // The largest chunk is assistant-ui itself (~660 kB, needed for first
    // paint, loaded from disk). The limit sits just above it so growth anywhere
    // else still warns.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        // Vendor code in its own chunks: smaller files, and they stay cached
        // across app updates that only touch Phaethon's own code.
        codeSplitting: {
          groups: [
            // Vite's preload helper in a chunk of its own: lazy code uses it too, and would otherwise take it along.
            { name: "preload-helper", test: /preload-helper/ },
            { name: "react", test: eagerly(/node_modules[\\/](?:\.pnpm[\\/])?(?:react|react-dom|scheduler)[@\\/]/) },
            { name: "assistant-ui", test: eagerly(/node_modules[\\/].*@assistant-ui/) },
            { name: "radix", test: eagerly(/node_modules[\\/].*(?:@radix-ui|radix-ui)/) },
            // Syntax colours load only when a reply first shows a code block (own chunk, before
            // "markdown" so its Markdown grammar doesn't land in the eager markdown chunk).
            { name: "syntax", test: eagerly(/node_modules[\\/].*(?:react-syntax-highlighter|refractor|prismjs|highlight\.js|lowlight|hastscript|hast-util-parse-selector)/) },
            { name: "markdown", test: eagerly(/node_modules[\\/].*(?:remark|rehype|micromark|mdast|hast|unified|unist|vfile|markdown|decode-named|character-entities|property-information|space-separated|comma-separated|ccount|devlop|bail|trough|zwitch|longest-streak|is-plain-obj|html-url-attributes|estree)/) },
            { name: "vendor", test: eagerly(/node_modules[\\/]/) },
          ],
        },
      },
    },
  },


  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    headers: { "Content-Security-Policy": devCsp },
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // src-tauri is rebuilt by Tauri; .claude holds other git worktrees.
      ignored: ["**/src-tauri/**", "**/.claude/**"],
    },
  },
}));
