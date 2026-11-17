import { defineConfig } from "@playwright/test";

/** `pnpm site:shots`: regenerates site/public/shots from the real app (see shots.spec.ts). */
export default defineConfig({
  testDir: ".",
  testMatch: "shots.spec.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [["list"]],
});
