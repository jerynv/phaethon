// Builds the SetupCard test page: pnpm exec vite build --config scripts/ui-preview/setup-card/vite.config.mjs --outDir <out>
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repo = path.resolve(import.meta.dirname, "../../..");

export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.join(repo, "src") } },
  build: { emptyOutDir: true },
});
