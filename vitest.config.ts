import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "#shared": path.resolve(import.meta.dirname, "src/shared") } },
  test: {
    include: ["src/server/**/*.test.ts", "src/shared/**/*.test.ts", "src/web/src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    env: { PHAETHON_TEST: "1" },
    testTimeout: 20000,
    pool: "forks",
  },
});
