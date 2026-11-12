import { expect, startCore, test, type Core } from "./core";

/** A space with study tools gets its view tabs, and each view opens on a fresh vault without failing. */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test("study tools: tabs appear and every view loads its empty state", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await page.getByRole("button", { name: "New space" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Fall term");
  await dialog.getByRole("switch").click();
  await dialog.getByRole("button", { name: "Create space" }).click();
  const tabs = page.getByRole("tablist", { name: "Views" });
  await expect(tabs).toBeVisible();
  for (const view of ["Study", "Grades", "Plan", "Courses"]) {
    await tabs.getByRole("tab", { name: view }).click();
    await expect(page.locator("main header")).toContainText(view);
    // Nothing failed to load: no surface error with a Retry.
    await expect(page.getByRole("main").getByRole("button", { name: "Retry" })).toHaveCount(0);
  }
  await expect(page.getByRole("main").getByRole("button", { name: /Connect a course site/ }).first()).toBeVisible();
});
