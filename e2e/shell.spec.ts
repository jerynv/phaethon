import { expect, startCore, test, type Core } from "./core";

/** The frame around everything: spaces and conversations in the sidebar, search, new spaces, the theme. */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

test("the sidebar groups conversations under their spaces", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  const nav = page.getByRole("navigation", { name: "Spaces and conversations" });
  await expect(nav.getByRole("button", { name: "Go to School" })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Go to Work" })).toBeVisible();
  await nav.getByRole("button", { name: "Go to Work" }).click();
  await expect(page.locator("main header")).toContainText("Work");
  // Spaces without study tools have no view tabs.
  await expect(page.getByRole("tablist", { name: "Views" })).toHaveCount(0);
  await nav.getByRole("button", { name: "Go to School" }).click();
  await expect(page.locator("main header")).toContainText("School");
});

test("a new space appears, selected, with a field error for an empty name", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await page.getByRole("button", { name: "New space" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Create space" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Give the space a name.");
  await dialog.getByLabel("Name").fill("A very long space name that will certainly not fit in the sidebar row");
  await dialog.getByRole("button", { name: "Create space" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("navigation").getByRole("button", { name: /Go to A very long space name/ })).toBeVisible();
  const row = await page.getByRole("navigation").getByRole("button", { name: /Go to A very long/ }).evaluate((b) => b.parentElement!.getBoundingClientRect().width);
  expect(row).toBeLessThan(250);
});

test("search finds a conversation in any space", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: "Sure." }] } });
  await core.open(page);
  await page.getByRole("textbox", { name: "Message" }).fill("tangent lines and derivatives");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sure.")).toBeVisible();
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await page.keyboard.press("Control+K");
  await page.getByPlaceholder("Search conversations, spaces and actions").fill("derivatives");
  const hit = page.getByRole("option", { name: /tangent lines and derivatives/ });
  await expect(hit).toBeVisible();
  await hit.click();
  await expect(page.getByText("Sure.")).toBeVisible();
});

test("first run asks for a heading and can be finished", async ({ page }) => {
  core = await startCore();
  await core.open(page, { onboarding: true });
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
});
