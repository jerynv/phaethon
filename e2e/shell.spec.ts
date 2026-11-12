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

test("first run walks through to the app, keeping the vault's spaces", async ({ page }) => {
  core = await startCore();
  await core.open(page, { onboarding: true });
  await expect(page.getByRole("heading", { level: 1, name: "Welcome to Phaethon" })).toBeVisible();
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "How should Phaethon answer?" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  // A fresh vault already has School and Work, so the last step offers them.
  await expect(page.getByRole("heading", { level: 1, name: "Your spaces" })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("phaethon.onboarded"))).toBe("1");
});

test("conversations can be renamed, pinned to the top and deleted after a confirm", async ({ page }) => {
  core = await startCore({ script: { claude: true, repeatLast: true, steps: [{ text: "Okay." }] } });
  await core.open(page);
  const nav = page.getByRole("navigation", { name: "Spaces and conversations" });
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "Message" }).fill(text);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  };
  await send("older question");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await send("newer question");
  const rows = nav.getByRole("button", { name: /question|Exam prep/ });
  await expect(rows).toHaveText([/newer question/, /older question/]);

  // Rename the older one from its menu; the title survives a reload.
  await nav.getByRole("button", { name: "older question" }).hover();
  await nav.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await nav.getByRole("textbox", { name: "Conversation title" }).fill("Exam prep");
  await page.keyboard.press("Enter");
  await expect(nav.getByRole("button", { name: "Exam prep" })).toBeVisible();

  // Pin it: it moves above the newer one.
  await nav.getByRole("button", { name: "Exam prep" }).hover();
  await nav.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await expect(rows).toHaveText([/Exam prep/, /newer question/]);
  await page.reload();
  await expect(rows).toHaveText([/Exam prep/, /newer question/]);
  await expect(nav.getByLabel("Pinned")).toBeVisible();

  // Delete asks first; cancelling keeps it.
  await nav.getByRole("button", { name: "Exam prep" }).hover();
  await nav.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Delete “Exam prep”?");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(nav.getByRole("button", { name: "Exam prep" })).toBeVisible();
  await nav.getByRole("button", { name: "Exam prep" }).hover();
  await nav.getByRole("button", { name: "Conversation actions" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(rows).toHaveText([/newer question/]);
});

test("the sidebar resizes from its edge and keeps the width", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  const panel = page.locator("[data-slot=sidebar-container]");
  const before = (await panel.boundingBox())!.width;
  const rail = (await page.locator("[data-slot=sidebar-rail]").boundingBox())!;
  await page.mouse.move(rail.x + rail.width / 2, 300);
  await page.mouse.down();
  await page.mouse.move(rail.x + 100, 300, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(Math.round(before + 100 - rail.width / 2));
  await page.reload();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBeGreaterThan(before + 50);
  await page.locator("[data-slot=sidebar-rail]").dblclick();
  await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(Math.round(before));
});
