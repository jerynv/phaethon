import path from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "console"),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "../src/web/src") } },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 650 },
  server: { host: "127.0.0.1", port: 5190, strictPort: true, proxy: { "/api": "http://127.0.0.1:8790" } },
});
