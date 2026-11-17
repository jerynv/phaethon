import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/** Settings against the real core: the theme is saved in the vault, a bad key gets a field error, Esc goes back. */

let core: Core | undefined;

/**
 * ⌘, opens Settings. On a slow runner the first press can land before the shell's shortcuts listen, and ⌘, toggles,
 * so press again only while Settings is still closed (its title slot shows as soon as it opens, before its page loads).
 */
async function openSettings(page: import("@playwright/test").Page) {
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expect(async () => {
    if (await page.locator('[data-slot="settings-title"]').isHidden()) await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
}
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test("the theme is saved in the vault and applied", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openSettings(page);
  await page.getByRole("button", { name: "Appearance" }).click();
  await page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: /Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  const settings = JSON.parse(fs.readFileSync(path.join(core.home, "Phaethon", "default", ".phaethon", "settings.json"), "utf8"));
  expect(settings.appearance.theme).toBe("dark");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
});

test("a key in the wrong format is refused under the field and never saved", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openSettings(page);
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: /^Providers/ }).click();
  // Nothing is set up yet, so Anthropic is added from the menu; its row opens on its key field.
  await page.getByRole("button", { name: "Add provider" }).click();
  await page.getByRole("menuitem", { name: "Anthropic" }).click();
  const key = page.getByPlaceholder("sk-ant-…");
  await key.fill("not-a-key");
  await page.getByRole("button", { name: "Check and save" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(page.getByText("Saved", { exact: true })).toHaveCount(0);
});
