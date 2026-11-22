import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Electron/Chromium natively uses .woff2; drop KaTeX's redundant .woff/.ttf @font-face fallbacks (~1.1 MB). */
function stripLegacyKatexFonts(): Plugin {
  return {
    name: "strip-legacy-katex-fonts",
    generateBundle(_, bundle) {
      for (const [fileName, output] of Object.entries(bundle)) {
        if (/KaTeX_.*\.(?:woff|ttf)$/.test(fileName)) {
          delete bundle[fileName];
          continue;
        }
        if (output.type === "asset" && fileName.endsWith(".css") && typeof output.source === "string") {
          output.source = output.source.replace(
            /,\s*url\([^)]*KaTeX_[^)]+\.(?:woff|ttf)["']?\)\s*format\([^)]+\)/g,
            "",
          );
        }
      }
    },
  };
}

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/web"),
  base: "./",
  plugins: [stripLegacyKatexFonts(), react(), tailwindcss()],
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
