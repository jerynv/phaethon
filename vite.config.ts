import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/web"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/web/src"),
      "#shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/web"),
    emptyOutDir: true,
    // KaTeX's fonts are files, so font-src stays 'self'.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    chunkSizeWarningLimit: 1200,
  },
  server: { port: 5173, strictPort: true },
  clearScreen: false,
});
