import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["telemetry/worker/**/*.test.ts"], environment: "node", testTimeout: 20_000, pool: "forks" } });
