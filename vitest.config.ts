import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Prompt fragments and the LaTeX house style are imported as text, as the esbuild bundle does.
  plugins: [{ name: "text", transform: (code: string, id: string) => (/\.(md|sty)$/.test(id) ? { code: `export default ${JSON.stringify(code)};`, map: null } : undefined) }],
  resolve: { alias: { "#shared": path.resolve(import.meta.dirname, "src/shared"), "@": path.resolve(import.meta.dirname, "src/web/src") } },
  test: {
    include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts", "src/web/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    env: { PHAETHON_TEST: "1" },
    testTimeout: 20000,
    pool: "forks",
  },
});
