import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, startCore, test, type Core } from "./core";

/**
 * The sidebar with 1500 conversations in one space (and 300 in another),
 * against the real core: only the rows on screen exist, older pages load as
 * the list scrolls, the filter finds conversations that aren't loaded, and
 * one opened from search beyond the loaded pages scrolls into view.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const SCHOOL = 1500;
const WORK = 300;
const HOUR = 3_600_000;

/** `count` conversations, the newest a few minutes ago and each one 7 hours older than the next. */
function seed(home: string, space: string, name: string, count: number, tag: string) {
  const state = path.join(home, "Phaethon", "default", "spaces", space, ".phaethon");
  const dir = path.join(state, "threads");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(state, "space.json"), JSON.stringify({ name }));
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const file = path.join(dir, `${1_600_000_000_000 + i}.json`);
    // A unique word per conversation, so search and the filter can find exactly one.
    fs.writeFileSync(file, JSON.stringify([{ role: "user", content: [{ type: "text", text: `${tag} chat ${i} ${tag}q${i}x` }] }]));
    const t = new Date(now - 5 * 60_000 - (count - 1 - i) * 7 * HOUR);
    fs.utimesSync(file, t, t);
  }
}

const nav = (page: Page) => page.getByRole("navigation", { name: "Spaces and conversations" });
const scroller = (page: Page) => nav(page).locator("[data-slot=scroll-area-viewport]").filter({ has: page.locator("[data-slot=sidebar-spaces]") });
const domRows = (page: Page) => nav(page).locator("[data-slot=sidebar-spaces] li[data-item-key]");
const row = (page: Page, i: number) => nav(page).getByRole("button", { name: new RegExp(`^Placeholder chat ${i} `) });

async function inView(page: Page, target: Locator) {
  const box = (await target.count()) ? await target.boundingBox().catch(() => null) : null;
  const view = await scroller(page).boundingBox();
  if (!box || !view) return false;
  return box.y >= view.y && box.y + box.height <= view.y + view.height + 1;
}

test("1500 conversations: windowed rows, pages on scroll, a filter, and search that scrolls to an old one", async ({ page }) => {
  core = await startCore({
    setup: (home) => {
      seed(home, "school", "School", SCHOOL, "Placeholder");
      seed(home, "work", "Work", WORK, "Other");
    },
  });
  await core.open(page);
  const sidebar = nav(page);

  // The newest is open; the first page is grouped by recency under sticky labels.
  await expect(page.locator("[data-slot=app-header]")).toContainText(`Placeholder chat ${SCHOOL - 1}`);
  await expect(sidebar.getByText("Today", { exact: true }).first()).toBeVisible();
  await expect(sidebar.getByText("Previous 7 days", { exact: true }).first()).toBeAttached();
  const first = await domRows(page).count();
  expect(first).toBeGreaterThan(10);
  expect(first).toBeLessThan(80);

  // Scrolling down reaches the end of School's loaded run, which loads the next pages: no "Show more" to press.
  await expect(sidebar.getByRole("button", { name: /^Show \d+ more/ })).toHaveCount(0);
  const deep = SCHOOL - 1 - 160;
  for (let i = 0; i < 120 && !(await row(page, deep).count()); i++) {
    await scroller(page).evaluate((el) => el.scrollBy(0, 300));
    await page.waitForTimeout(60);
  }
  await expect(row(page, deep)).toBeAttached();
  const loaded = await page.evaluate(() => document.querySelector("[data-slot=sidebar-spaces]")!.getBoundingClientRect().height);
  expect(loaded).toBeGreaterThan(160 * 29);
  expect(await domRows(page).count()).toBeLessThan(80);

  // Scrolling through everything loaded keeps the DOM bounded and each frame's work small.
  const perf = await scroller(page).evaluate(async (el) => {
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(r));
    const frames: number[] = [];
    let maxRows = 0;
    let long = 0;
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) long += e.duration;
    });
    obs.observe({ type: "longtask", buffered: false });
    let last = performance.now();
    const steps = Math.ceil((el.scrollHeight - el.clientHeight) / 140);
    for (let i = 0; i < steps; i++) {
      el.scrollTop += 140;
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frames.push(now - last);
      last = now;
      maxRows = Math.max(maxRows, el.querySelectorAll("[data-slot=sidebar-spaces] li[data-item-key]").length);
    }
    obs.disconnect();
    frames.sort((a, b) => a - b);
    return { steps, median: frames[Math.floor(frames.length / 2)]!, p95: frames[Math.floor(frames.length * 0.95)]!, max: frames[frames.length - 1]!, maxRows, long };
  });
  console.log(`sidebar scroll: ${JSON.stringify(perf)}`);
  expect(perf.steps).toBeGreaterThan(30);
  expect(perf.maxRows).toBeLessThan(80);
  // No frame near a long task: under four frames at the 95th percentile, and hardly any main-thread task over 50 ms.
  expect(perf.p95).toBeLessThan(66);
  expect(perf.long).toBeLessThan(150);

  // The filter narrows to matching titles, loaded or not (the core finds the rest), and Escape clears it.
  const filter = sidebar.getByRole("searchbox", { name: "Filter chats" });
  await filter.fill("Placeholderq3x");
  await expect(row(page, 3)).toBeVisible();
  await expect(row(page, SCHOOL - 1)).toHaveCount(0);
  await expect(sidebar.getByRole("button", { name: "Go to Work" })).toHaveCount(0);
  await filter.press("Escape");
  await expect(filter).toHaveValue("");
  await expect(row(page, 3)).toHaveCount(0);
  await expect.poll(() => domRows(page).count()).toBeGreaterThan(10);

  // Search opens one far older than the loaded pages: it is read on its own, selected and scrolled into view.
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByPlaceholder("Search conversations, spaces and actions").fill("Placeholderq7x");
  await page.getByRole("option", { name: /Placeholder chat 7 / }).click();
  await expect(page.locator("[data-slot=app-header]")).toContainText("Placeholder chat 7");
  const opened = row(page, 7);
  await expect(opened).toHaveAttribute("aria-current", "page");
  await expect.poll(() => inView(page, opened)).toBe(true);
  expect(await domRows(page).count()).toBeLessThan(80);

  // Keyboard: arrows move through the rows, scrolling the list, and focus never falls out of it.
  await opened.focus();
  await page.keyboard.press("ArrowUp");
  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("data-nav-row", "");
  await expect(focused).not.toHaveAccessibleName(/^Placeholder chat 7 /);
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowUp");
  await expect(focused).toHaveAccessibleName(/^Placeholder chat \d+ /);
  expect(await inView(page, focused)).toBe(true);
  await page.keyboard.press("Home");
  await expect(focused).toHaveAccessibleName(/^Go to /);
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(focused).toHaveAccessibleName(/ chat \d+ /);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(sidebar.getByRole("searchbox", { name: "Filter chats" })).toBeFocused();

  // It stays open after a reload, though it isn't on the first page.
  await page.reload();
  await expect(page.locator("[data-slot=app-header]")).toContainText("Placeholder chat 7");
  await expect(row(page, 7)).toHaveAttribute("aria-current", "page");
  await expect.poll(() => inView(page, row(page, 7))).toBe(true);
});

test("1500 conversations: a first click opens a cut title, the next space is reachable, the view holds still, a delete keeps focus", async ({ page }) => {
  core = await startCore({
    setup: (home) => {
      seed(home, "school", "School", SCHOOL, "Placeholder");
      seed(home, "work", "Work", WORK, "Other");
    },
  });
  await core.open(page);
  const sidebar = nav(page);
  await expect(page.locator("[data-slot=app-header]")).toContainText(`Placeholder chat ${SCHOOL - 1}`);

  // A title cut off by the sidebar's width opens on the first click, with no hover first.
  const cut = row(page, SCHOOL - 3);
  expect(await cut.locator("span").first().evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await cut.click();
  await expect(page.locator("[data-slot=app-header]")).toContainText(`Placeholder chat ${SCHOOL - 3}`);

  // School loads a share of pages on its own, then offers "Show older", so scrolling on reaches Work.
  const older = sidebar.getByRole("button", { name: "Show older" });
  const work = sidebar.getByRole("button", { name: "Go to Work" });
  // About 250 rows of 29 px: some 20 steps of 400 px (paging through all 1500 would take over a hundred).
  let steps = 0;
  for (; steps < 40 && !(await inView(page, work)); steps++) {
    await scroller(page).evaluate((el) => el.scrollBy(0, 400));
    await page.waitForTimeout(60);
  }
  expect(await inView(page, work)).toBe(true);
  expect(steps).toBeLessThan(30);
  await expect.poll(() => inView(page, older)).toBe(true);
  const listed = () => page.evaluate(() => document.querySelectorAll("[data-slot=sidebar-spaces] li[data-item-key^='row:school/']").length);
  const shareEnd = await sidebar.locator("li[data-item-key^='row:school/']").last().getAttribute("data-item-key");
  await older.click();
  await expect(sidebar.locator(`li[data-item-key='${shareEnd}']`)).toBeAttached();
  // The next page arrives under it (ids count down with age), and the button is gone until School's next share is in.
  const nextOlder = `row:school/${Number(shareEnd!.split("/")[1]) - 1}`;
  await expect(sidebar.locator(`li[data-item-key='${nextOlder}']`)).toBeAttached();
  await expect(older).toHaveCount(0);
  // A page arriving in view doesn't fade its rows in over the others.
  expect(await sidebar.locator("li[data-item-key].animate-in").count()).toBe(0);
  expect(await listed()).toBeLessThan(80);

  // Pinning a conversation below the one being read adds a Pinned group above the view; what is on screen doesn't move.
  await scroller(page).evaluate((el) => (el.scrollTop = 1500));
  await page.waitForTimeout(200);
  const onScreen = await sidebar.locator("li[data-item-key^='row:school/'] [data-nav-row]").evaluateAll((els) => {
    const v = els[0]!.closest("[data-slot=scroll-area-viewport]")!.getBoundingClientRect();
    return els
      .map((b) => ({ name: b.getAttribute("aria-label")!, y: b.getBoundingClientRect().top }))
      .filter((r) => r.y > v.top + 80 && r.y < v.bottom - 40)
      .sort((a, b) => a.y - b.y);
  });
  const watched = onScreen[1]!;
  const victim = onScreen[onScreen.length - 1]!;
  await sidebar.getByRole("button", { name: victim.name, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  // It moves up into Pinned, above the view (its name now says it is pinned).
  await expect(sidebar.getByRole("button", { name: victim.name, exact: true })).toHaveCount(0);
  const y = await sidebar.getByRole("button", { name: watched.name, exact: true }).evaluate((b) => b.getBoundingClientRect().top);
  expect(Math.abs(y - watched.y)).toBeLessThan(2);

  // Deleting from the keyboard leaves focus on the row that took the deleted one's place.
  const doomed = sidebar.getByRole("button", { name: watched.name, exact: true });
  await doomed.focus();
  await page.keyboard.press("Delete");
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  const focused = page.locator(":focus");
  await expect(focused).toHaveAttribute("data-nav-row", "");
  await expect(focused).toHaveAccessibleName(onScreen[2]!.name);
});
