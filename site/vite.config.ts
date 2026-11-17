import fs from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { createServer, defineConfig, type Plugin, type ViteDevServer } from "vite";
import { snapshot, type Snapshot } from "./src/github.ts";

/**
 * phaethon.app: three React pages on the app's own components (src/routes.tsx),
 * prerendered (`pnpm site:build` → site/dist, served by Cloudflare, see
 * wrangler.jsonc). The build reads the project's state from GitHub once and
 * renders each page with it, so it's complete before any script runs;
 * src/entry-client.tsx hydrates it and refreshes that state in the browser.
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

type Server = typeof import("./src/entry-server.tsx");

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Everything in a page's <head>: the shared tags, then its own title, description and links. */
function head({ title, description, path: at }: { title: string; description: string; path: string }, home: boolean): string {
  const url = `https://phaethon.app${at}`;
  return [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${escape(title)}</title>`,
    `<meta name="description" content="${escape(description)}" />`,
    `<meta name="color-scheme" content="light dark" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />`,
    `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1c1c1c" />`,
    `<link rel="icon" href="/icon.png" type="image/png" />`,
    `<link rel="apple-touch-icon" href="/icon.png" />`,
    `<link rel="canonical" href="${url}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:url" content="${url}" />`,
    `<meta property="og:title" content="${escape(title)}" />`,
    `<meta property="og:description" content="${escape(description)}" />`,
    `<meta property="og:image" content="https://phaethon.app/og.jpg" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...(home
      ? [
          `<link rel="preload" as="image" href="/shots/chat-light.webp" media="(prefers-color-scheme: light)" />`,
          `<link rel="preload" as="image" href="/shots/chat-dark.webp" media="(prefers-color-scheme: dark)" />`,
        ]
      : []),
    `<!-- Before first paint, so a dark-mode visitor never sees the light page. -->`,
    `<script src="/theme.js"></script>`,
  ].join("\n    ");
}

function prerender(): Plugin {
  let dev: ViteDevServer | undefined;
  let snap: Snapshot | undefined;
  return {
    name: "phaethon-prerender",
    configureServer(server) {
      dev = server;
    },
    async transformIndexHtml(html, ctx) {
      snap ??= await readSnapshot();
      // In dev the page's own server loads the app; a build starts a short-lived one just for this.
      const server = dev ?? (await createServer({ configFile: false, root, resolve: { alias }, plugins: [react()], logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom" }));
      try {
        const { render, routeFor, routes } = (await server.ssrLoadModule("/src/entry-server.tsx")) as Server;
        const route = routeFor(path.basename(ctx.filename));
        return html
          .replace("<!--head-->", () => head(routes[route], route === "home"))
          .replace(`<div id="root">`, `<div id="root" data-route="${route}">`)
          // Callbacks, so a "$" in a commit message is text, not a replacement pattern.
          .replace("<!--app-->", () => render(route, snap!))
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
    rollupOptions: { input: ["index.html", "download.html", "status.html"].map((f) => path.resolve(root, f)) },
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
  server: { port: 5180 },
  clearScreen: false,
});
