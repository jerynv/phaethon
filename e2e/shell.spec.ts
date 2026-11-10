import { expect, startCore, test } from "./core.ts";

test("the shell lists the vault's spaces and opens settings against the real core", async ({ page }) => {
  const core = await startCore();
  try {
    await core.open(page);
    await expect(page.getByText("School").first()).toBeVisible();
    await page.keyboard.press("Control+,");
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("Appearance & accessibility").first()).toBeVisible();
    await page.screenshot({ path: "test-results/shell-real-core.png" });
  } finally {
    await core.stop();
  }
});
