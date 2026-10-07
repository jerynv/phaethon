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
            { name: "react", test: /node_modules[\\/](?:\.pnpm[\\/])?(?:react|react-dom|scheduler)[@\\/]/ },
            { name: "assistant-ui", test: /node_modules[\\/].*@assistant-ui/ },
            { name: "radix", test: /node_modules[\\/].*(?:@radix-ui|radix-ui)/ },
            { name: "markdown", test: /node_modules[\\/].*(?:remark|rehype|micromark|mdast|hast|unified|unist|vfile|markdown|decode-named|character-entities|property-information|space-separated|comma-separated|ccount|devlop|bail|trough|zwitch|longest-streak|is-plain-obj|html-url-attributes|estree)/ },
            { name: "vendor", test: /node_modules[\\/]/ },
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
