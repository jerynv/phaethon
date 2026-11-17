import fs from "node:fs";
import path from "node:path";
import { expect, openNewSpace, startCore, test, type Core } from "./core";

/**
 * The shell and chat interactions against the real core: the title bar never
 * moves between pages, the chat survives a page switch, a file named in a
 * reply opens in the viewer, the composer autocompletes `@` and `/`, and
 * right-click menus work on messages and files.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const composer = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Message" });
const spaceDir = (home: string) => path.join(home, "Phaethon", "default", "spaces", "school");

function withNotes(home: string) {
  const dir = path.join(spaceDir(home), "notes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plan.md"), "# Study plan\n\nDay 1: induction\n");
  fs.writeFileSync(path.join(dir, "week6.md"), "# Week 6\n");
}

test("the view tabs stay in one place on every page, and the chat survives a page switch", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await openNewSpace(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Fall term");
  await dialog.getByRole("switch").click();
  await dialog.getByRole("button", { name: "Create space" }).click();
  const views = page.getByRole("list", { name: "Views" });
  await expect(views).toBeVisible();
  await composer(page).fill("a draft I haven't sent");

  // Each page opens as its own tab; the tab strip never moves while pages come and go.
  const strip = page.getByRole("tablist", { name: "Open pages" });
  const boxes: Record<string, { x: number; y: number }> = {};
  const first = (await strip.boundingBox())!;
  for (const view of ["Study", "Grades", "Plan", "Courses"]) {
    await views.getByRole("button", { name: new RegExp(`^${view}`) }).click();
    await expect(views.getByRole("button", { name: new RegExp(`^${view}`) })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { name: view })).toHaveAttribute("aria-selected", "true");
    // Let page actions (Refresh, Save as note, …) arrive in the bar first.
    await page.waitForTimeout(400);
    const b = (await strip.boundingBox())!;
    boxes[view] = { x: Math.round(b.x), y: Math.round(b.y) };
  }
  for (const view of Object.keys(boxes)) expect(boxes[view], view).toEqual({ x: Math.round(first.x), y: Math.round(first.y) });

  await page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { name: "New chat" }).click();
  await expect(composer(page)).toHaveValue("a draft I haven't sent");
});

test("settings opens inside the shell and Esc goes back", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  // On a slow runner the first press can land before the shell's shortcuts listen. ⌘, toggles, so press again only
  // while Settings is still closed (the title slot shows as soon as it opens, before its page has loaded).
  await expect(composer(page)).toBeVisible();
  await expect(async () => {
    if (await page.locator('[data-slot="settings-title"]').isHidden()) await page.keyboard.press("ControlOrMeta+Comma");
    await expect(page.getByRole("navigation", { name: "Settings" })).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "Spaces and conversations" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Settings" })).toHaveCount(0);
  await expect(composer(page)).toBeVisible();
});

test("closing every tab leaves one new chat on the welcome, which has no close", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: "Sure." }] } });
  await core.open(page);
  await composer(page).fill("Hello");
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("Sure.");
  // Settings opens without a tab of its own, and Esc goes back to the tabs as they were.
  await page.keyboard.press("ControlOrMeta+Comma");
  await expect(page.locator('[data-slot="settings-title"]')).toContainText("Settings");
  await expect(page.getByRole("tablist", { name: "Open pages" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  const strip = page.getByRole("tablist", { name: "Open pages" });
  await expect(strip.getByRole("tab", { name: "Hello" })).toHaveAttribute("aria-selected", "true");

  const closes = strip.getByRole("button", { name: /^Close / });
  for (let i = 0; i < 10 && (await closes.count()) > 0; i++) await closes.first().click({ force: true });
  await expect(strip.getByRole("tab")).toHaveCount(1);
  await expect(strip.getByRole("tab", { name: "New chat" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Where should we begin?" })).toBeVisible();
  await expect(closes).toHaveCount(0);
  // ⌘W and a middle-click on it change nothing.
  await page.keyboard.press("ControlOrMeta+w");
  await strip.getByRole("tab", { name: "New chat" }).click({ button: "middle" });
  await expect(strip.getByRole("tab")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Where should we begin?" })).toBeVisible();
});

test("a file named in a reply opens in the viewer, a web link stays a link", async ({ page }) => {
  core = await startCore({
    setup: withNotes,
    script: { claude: true, steps: [{ text: "Your plan is in [the plan](notes/plan.md), and I noted it in `notes/week6.md`. See [the docs](https://example.com)." }] },
  });
  await core.open(page);
  await composer(page).fill("Where is my plan?");
  await page.keyboard.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.getByRole("link", { name: "the docs" })).toHaveAttribute("href", "https://example.com");
  await reply.locator('[data-slot="file-chip"][data-path="notes/plan.md"]').click();
  await expect(page.getByText("Day 1: induction")).toBeVisible();

  // A second file opens in its own tab beside the first; the first keeps its place.
  const files = page.getByRole("tablist", { name: "Open files" });
  await reply.locator('[data-slot="file-chip"][data-path="notes/week6.md"]').click();
  await expect(files.getByRole("tab")).toHaveCount(2);
  await expect(files.getByRole("tab", { name: "week6.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Week 6" })).toBeVisible();
  // Opening one already open shows its tab instead of adding another.
  await reply.locator('[data-slot="file-chip"][data-path="notes/plan.md"]').click();
  await expect(files.getByRole("tab")).toHaveCount(2);
  await expect(files.getByRole("tab", { name: "plan.md" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Day 1: induction")).toBeVisible();
  // Closing the one on show shows its neighbour; closing the last shuts the viewer.
  await files.getByRole("button", { name: "Close plan.md" }).click();
  await expect(files.getByRole("tab", { name: "week6.md" })).toHaveAttribute("aria-selected", "true");
  await files.getByRole("button", { name: "Close week6.md" }).click();
  await expect(page.getByRole("complementary", { name: "Files" })).toHaveCount(0);
});

test("the composer completes @ with the space's files and / with commands", async ({ page }) => {
  core = await startCore({ setup: withNotes });
  await core.open(page);
  const box = composer(page);
  await box.click();
  await box.pressSequentially("Summarise @pla");
  const menu = page.locator('[data-slot="composer-menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByText("plan.md")).toBeVisible();
  await box.press("Enter");
  await expect(box).toHaveValue("Summarise @notes/plan.md ");
  await expect(menu).toHaveCount(0);

  await box.fill("");
  await box.pressSequentially("/");
  await expect(menu.getByText("/new")).toBeVisible();
  await expect(menu.getByText("/attach")).toBeVisible();
  await box.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("right-click on a reply copies it as Markdown, and on a file offers its path", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  core = await startCore({ setup: withNotes, script: { claude: true, steps: [{ text: "The answer is **42**, from [the plan](notes/plan.md)." }] } });
  await core.open(page);
  await composer(page).fill("What is the answer?");
  await page.keyboard.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.locator("strong", { hasText: "42" })).toBeVisible();

  await reply.locator("strong", { hasText: "42" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("The answer is **42**, from [the plan](notes/plan.md).");

  await reply.locator('[data-slot="file-chip"]').click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Show in folder" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Copy path" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("notes/plan.md");
});

test("tool steps read in plain words; technical details are opt-in", async ({ page }) => {
  core = await startCore({
    setup: withNotes,
    script: { claude: true, steps: [{ text: "", tools: [{ name: "read_file", input: { path: "notes/plan.md" }, id: "r1" }] }, { text: "Day 1 is induction." }] },
  });
  await core.open(page);
  await composer(page).fill("What's on day 1?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Day 1 is induction.")).toBeVisible();
  const work = page.locator('[data-slot="work-group"]').first();
  await work.getByRole("button", { name: /Read 1 file/ }).click();
  await expect(work.locator('[data-slot="file-chip"][data-path="notes/plan.md"]')).toBeVisible();
  await expect(work.getByText("Reading file")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+Comma");
  await page.getByRole("switch", { name: "Show technical details" }).click();
  await page.keyboard.press("Escape");
  await expect(work.getByText("Reading file")).toBeVisible();
});

test("typing goes into the message box without clicking it first, and a card's keys never swallow it", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  const box = composer(page);
  await expect(box).toBeFocused();
  await page.keyboard.type("hello 3t");
  await expect(box).toHaveValue("hello 3t");

  // Focus elsewhere on the page (not a field): the next key still lands in the box.
  await box.fill("");
  await page.getByRole("button", { name: "New chat" }).first().focus();
  await page.keyboard.type("yes");
  await expect(box).toHaveValue("yes");
});

test("Esc leaves Settings even pressed the instant it opens, before Settings has loaded", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  // Opening Settings and pressing Esc in the same task: Settings' own code hasn't arrived yet.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: ",", code: "Comma", metaKey: true, ctrlKey: !navigator.platform.includes("Mac"), bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(300);
  await expect(page.locator('[data-page="settings"]')).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Open pages" })).toBeVisible();
});
