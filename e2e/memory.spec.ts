import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, openSettings, startCore, test, type Core } from "./core";
import { seedLife } from "./fixtures/life";

/**
 * Settings › Memory, People, Mail & connectors and Automations against the
 * real core: each change lands in the vault's plain files.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function start(page: Page, section: "memory" | "people" | "mail" | "automations") {
  core = await startCore({ setup: (home) => void seedLife(home), env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json", PHAETHON_FAKE_SHORTCUTS: "Log hours,Text Mom" } });
  await core.open(page);
  await openSettings(page, { memory: "Memory", people: "People", mail: "Mail & connectors", automations: "Automations" }[section]);
  return path.join(core.home, "Phaethon", "default");
}

const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("memory: 'hi' brings nothing, adding, closing with an outcome, and the profile", async ({ page }) => {
  const vault = await start(page, "memory");
  const tryBox = page.getByRole("textbox", { name: "Message to try" });
  await tryBox.fill("hi");
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(page.getByText("Nothing would come up for this message.")).toBeVisible();
  await tryBox.fill("what's my Saturday morning look like");
  await page.getByRole("button", { name: "Try", exact: true }).click();
  await expect(page.getByText("Nothing would come up for this message.")).toBeHidden();

  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("What to remember").fill("Dinner with Priya");
  await page.locator("#memory-time").fill("2026-11-20T19:30");
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await expect.poll(() => json(path.join(vault, ".phaethon/memories.json")).items.find((i: { text: string }) => i.text === "Dinner with Priya")?.when).toBe(new Date(2026, 10, 20, 19, 30).getTime());

  await page.getByRole("button", { name: "Done" }).nth(1).click();
  await page.getByLabel("How did it go?").fill("Went well");
  await page.getByRole("button", { name: "Done", exact: true }).last().click();
  await expect.poll(() => json(path.join(vault, ".phaethon/memories.json")).items.some((i: { status: string; outcome?: string }) => i.status === "done" && i.outcome === "Went well")).toBe(true);

  const about = page.getByRole("textbox", { name: "About you" });
  await about.click();
  await about.press("End");
  await page.keyboard.type("\n- Edited from Settings");
  await expect(page.getByText("Unsaved changes").first()).toBeVisible();
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect.poll(() => fs.readFileSync(path.join(vault, "memory/profile.md"), "utf8")).toContain("Edited from Settings");
  await page.getByRole("button", { name: /Remove “Usually replies/ }).click();
  await expect.poll(() => fs.readFileSync(path.join(vault, "memory/profile.md"), "utf8")).not.toContain("Usually replies");
});

test("people: editing a card and adding someone", async ({ page }) => {
  const vault = await start(page, "people");
  await page.getByRole("button", { name: /Dana Reyes/ }).click();
  await expect(page.getByText("Vacation approved")).toBeVisible();
  const rel = page.locator("#person-f-relation");
  await rel.fill("Boss");
  await rel.press("Enter");
  await page.getByLabel("Add a name they go by").fill("the lead");
  await page.getByLabel("Add a name they go by").press("Enter");
  await expect.poll(() => json(path.join(vault, "memory/people/dana-reyes.json"))).toMatchObject({ relation: "Boss", aliases: expect.arrayContaining(["my boss", "the lead"]) });
  await page.getByRole("button", { name: "People", exact: true }).last().click();
  await page.getByRole("button", { name: "Add person" }).click();
  await page.getByLabel("Name").fill("Alex Kim");
  await page.getByRole("button", { name: "Add person" }).last().click();
  await expect(page.locator("#person-f-name")).toHaveValue("Alex Kim");
  expect(fs.existsSync(path.join(vault, "memory/people/alex-kim.json"))).toBe(true);
});

test("mail: which space uses an account, turning a mail app off and on, and allowed shortcuts", async ({ page }) => {
  const vault = await start(page, "mail");
  await page.getByLabel("Spaces that may use iCloud").click();
  await page.getByRole("option", { name: /Personal/ }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => json(path.join(vault, ".phaethon/mail.json")).access["fake:icloud"]).toEqual(["personal"]);
  await page.getByRole("switch", { name: "Test mail" }).click();
  await expect(page.getByText("Turn on a mail app to see its accounts.")).toBeVisible();
  await page.getByRole("switch", { name: "Test mail" }).click();
  await expect(page.getByText("jeryn@gmail.com")).toBeVisible();
  // Test mode lists the fake shortcuts, never this computer's.
  await expect(page.getByText("Log hours")).toBeVisible();
  await expect(page.getByText("Text Mom")).toBeVisible();
});

test("automations: a schedule from friendly words, with its live hint and an error", async ({ page }) => {
  const vault = await start(page, "automations");
  await expect(page.getByText("Suggested by Phaethon")).toBeVisible();
  await page.getByRole("button", { name: "New schedule" }).click();
  await page.getByLabel("Name").fill("Evening review");
  await page.getByLabel("What to do").fill("List what I did today.");
  await page.getByRole("button", { name: "Weekdays" }).click();
  await expect(page.getByText("Weekdays at 8:00 AM")).toBeVisible();
  await page.locator("#schedule-when").fill("every 2 minutes");
  await expect(page.getByText(/5 to 59/)).toBeVisible();
  await page.locator("#schedule-when").fill("daily 21:15");
  await expect(page.getByText("Every day at 9:15 PM")).toBeVisible();
  await page.getByRole("button", { name: "Create schedule" }).click();
  await expect.poll(() => json(path.join(vault, ".phaethon/schedules.json")).schedules.find((s: { title: string }) => s.title === "Evening review")?.cron).toBe("15 21 * * *");
});

test("a section you come back to shows at once, with no loading state", async ({ page }) => {
  await start(page, "memory");
  await expect(page.getByText("Let agents remember things")).toBeVisible();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "People", exact: true }).click();
  await expect(page.getByRole("button", { name: /Dana Reyes/ })).toBeVisible();
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Memory", exact: true }).click();
  // The very first frame after switching back already has the content: no skeleton, no busy region.
  const first = await page.evaluate(() => ({ busy: !!document.querySelector('[aria-busy="true"]'), shown: document.body.innerText.includes("Let agents remember things") }));
  expect(first).toEqual({ busy: false, shown: true });
});

test("what the agent remembers in chat shows in Settings › Memory on return, not the cached list", async ({ page }) => {
  core = await startCore({
    setup: (home) => void seedLife(home),
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: { claude: true, steps: [{ tools: [{ name: "remember", id: "r1", input: { kind: "task", text: "Book the dentist", when: new Date(Date.now() + 3 * 86_400_000).toISOString() } }] }, { text: "Noted." }] },
  });
  await core.open(page);
  await openSettings(page, "Memory");
  const settings = page.locator('[data-page="settings"]');
  await expect(settings.getByText("Team meeting with Dana about the Q4 roadmap")).toBeVisible();
  await expect(settings.getByText("Book the dentist")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill("remind me to book the dentist this week");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Noted.")).toBeVisible();
  // Back within the cache's freshness window: the agent's record invalidated it, so the new item is there.
  await openSettings(page, "Memory");
  await expect(page.locator('[data-page="settings"]').getByText("Book the dentist")).toBeVisible({ timeout: 3000 });
});
