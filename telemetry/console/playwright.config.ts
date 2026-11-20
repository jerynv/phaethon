import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  outputDir: "../../test-results/telemetry-console",
  fullyParallel: true,
  use: { baseURL: "http://127.0.0.1:5191", viewport: { width: 1280, height: 900 }, trace: "retain-on-failure" },
  webServer: { command: "pnpm exec vite --config telemetry/vite.config.ts --port 5191", cwd: "../..", url: "http://127.0.0.1:5191", reuseExistingServer: false },
});
