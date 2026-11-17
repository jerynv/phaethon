import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createServer, defineConfig, type Plugin, type ViteDevServer } from "vite";
import { snapshot, type Snapshot } from "./src/github.ts";

/**
 * phaethon.app: one React page on the app's own components, prerendered
 * (`pnpm site:build` → site/dist, served by Cloudflare, see wrangler.jsonc).
 * The build reads the project's state from GitHub once and renders the page
 * with it, so it's complete before any script runs; src/entry-client.tsx
 * hydrates it and refreshes that state in the browser.
 */

const root = import.meta.dirname;
const app = path.resolve(root, "../src/web/src");
const alias = { "@": app };
const fallback = path.resolve(root, "snapshot.json");

/** GitHub's state now, or the last one this build saw if GitHub can't be reached. */
async function readSnapshot(): Promise<Snapshot> {
  const live = await snapshot();
  if (live.release) {
    fs.writeFileSync(fallback, `${JSON.stringify(live, null, 2)}\n`);
    return live;
  }
  if (fs.existsSync(fallback)) return JSON.parse(fs.readFileSync(fallback, "utf8")) as Snapshot;
  return live;
}

type Render = (snap: Snapshot) => string;

function prerender(): Plugin {
  let dev: ViteDevServer | undefined;
  let snap: Snapshot | undefined;
  return {
    name: "phaethon-prerender",
    configureServer(server) {
      dev = server;
    },
    async transformIndexHtml(html) {
      snap ??= await readSnapshot();
      // In dev the page's own server loads the app; a build starts a short-lived one just for this.
      const server = dev ?? (await createServer({ configFile: false, root, resolve: { alias }, plugins: [react()], logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" }));
      try {
        const { render } = (await server.ssrLoadModule("/src/entry-server.tsx")) as { render: Render };
        return html
          // Callbacks, so a "$" in a commit message is text, not a replacement pattern.
          .replace("<!--app-->", () => render(snap!))
          // Safe inside <script type="application/json">: no "</" can close it early.
          .replace("<!--snapshot-->", () => JSON.stringify(snap).replace(/</g, "\\u003c"));
      } finally {
        if (!dev) await server.close();
      }
    },
  };
}

export default defineConfig({
  root,
  plugins: [react(), tailwindcss(), prerender()],
  resolve: { alias },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: { port: 5180 },
  clearScreen: false,
});
