import fs from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, startCore, switchSpace, test, type Core } from "./core";

/**
 * The sidebar with 1500 conversations in one space (and 300 in another),
 * against the real core: only the rows on screen exist, older pages load as
 * the list scrolls, the search finds conversations that aren't loaded, and
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
  const filter = sidebar.getByRole("searchbox", { name: "Search chats" });
  await filter.fill("Placeholderq3x");
  await expect(row(page, 3)).toBeVisible();
  await expect(row(page, SCHOOL - 1)).toHaveCount(0);
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
  await expect(focused).toHaveAccessibleName(new RegExp(`^Placeholder chat ${SCHOOL - 1} `));
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
  await expect(focused).toHaveAccessibleName(/ chat \d+ /);
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowUp");
  await expect(sidebar.getByRole("searchbox", { name: "Search chats" })).toBeFocused();

  // It stays open after a reload, though it isn't on the first page.
  await page.reload();
  await expect(page.locator("[data-slot=app-header]")).toContainText("Placeholder chat 7");
  await expect(row(page, 7)).toHaveAttribute("aria-current", "page");
  await expect.poll(() => inView(page, row(page, 7))).toBe(true);
});

test("1500 conversations: a first click opens a cut title, pages keep coming, another space is a switch away, the view holds still, a delete keeps focus", async ({ page }) => {
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

  // One space at a time: its pages keep loading as it scrolls, with no "Show older" to press.
  const older = sidebar.getByRole("button", { name: "Show older" });
  const height = () => page.evaluate(() => document.querySelector("[data-slot=sidebar-spaces]")!.getBoundingClientRect().height);
  const before = await height();
  for (let i = 0; i < 30; i++) {
    await scroller(page).evaluate((el) => el.scrollBy(0, 400));
    await page.waitForTimeout(60);
  }
  await expect.poll(height).toBeGreaterThan(before);
  await expect(older).toHaveCount(0);
  // A page arriving in view doesn't fade its rows in over the others.
  expect(await sidebar.locator("li[data-item-key].animate-in").count()).toBe(0);
  const listed = () => page.evaluate(() => document.querySelectorAll("[data-slot=sidebar-spaces] li[data-item-key^='row:school/']").length);
  expect(await listed()).toBeLessThan(80);

  // Work is a switch away: only its conversations are listed, and School's come back as they were.
  await switchSpace(page, "Work");
  await expect(sidebar.getByRole("button", { name: new RegExp(`^Other chat ${WORK - 1} `) })).toBeVisible();
  await expect(sidebar.locator("li[data-item-key^='row:school/']")).toHaveCount(0);
  await switchSpace(page, "School");
  await expect(row(page, SCHOOL - 3)).toHaveAttribute("aria-current", "page");
  // The rows' entrance is over before anything is measured.
  await expect(sidebar.locator("[data-entering]")).toHaveCount(0);

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

test("the selected fill glides between rows on screen, and never moves on its own while scrolling or filtering", async ({ page }) => {
  core = await startCore({ setup: (home) => seed(home, "school", "School", 300, "Placeholder") });
  await core.open(page);
  const sidebar = nav(page);
  const n = (i: number) => sidebar.getByRole("button", { name: new RegExp(`^Placeholder chat ${i} `) });
  await expect(n(299)).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator("[data-entering]")).toHaveCount(0);
  const fill = sidebar.locator("[data-slot=sidebar-spaces] > [data-slot=row-highlight]");
  // The fill's offset from its row, every time it is set, until `stop()`: a glide sets a non-zero offset that springs back to 0.
  const watch = () =>
    fill.evaluate((h) => {
      const seen: string[] = [];
      const mo = new MutationObserver(() => seen.push((h.firstElementChild as HTMLElement).style.transform));
      mo.observe(h.firstElementChild!, { attributes: true, attributeFilter: ["style"] });
      (window as unknown as { stopWatch: () => string[] }).stopWatch = () => (mo.disconnect(), seen);
    });
  const stop = () => page.evaluate(() => (window as unknown as { stopWatch: () => string[] }).stopWatch());
  const moved = (seen: string[]) => seen.some((t) => /translateY\(-?[1-9]/.test(t));
  const under = async (row: Locator) => {
    const [a, b] = await Promise.all([fill.locator("> *").boundingBox(), row.boundingBox()]);
    return !!a && !!b && Math.abs(a.y - b.y) < 1 && Math.abs(a.height - b.height) < 1;
  };
  await expect.poll(() => under(n(299))).toBe(true);
  // A glide has settled once its offset is cleared.
  const settled = () => expect.poll(() => fill.evaluate((h) => (h.firstElementChild as HTMLElement).style.transform)).toBe("none");

  // A row on screen: the fill glides over to it and settles under it.
  await watch();
  await n(295).click();
  await expect.poll(() => under(n(295))).toBe(true);
  expect(moved(await stop())).toBe(true);
  await expect(n(295)).toHaveAttribute("aria-current", "page");
  await expect(n(299)).not.toHaveAttribute("aria-current");
  await settled();

  // Scrolling: the fill rides in the content with its row and is never animated.
  await watch();
  for (let i = 0; i < 20; i++) {
    await scroller(page).evaluate((el) => el.scrollBy(0, 120));
    await page.waitForTimeout(30);
  }
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(100);
  expect(await stop()).toEqual([]);
  await expect.poll(() => under(n(295))).toBe(true);

  // The old row scrolled out of view: the next one is selected in place, no glide in from off screen.
  await scroller(page).evaluate((el) => (el.scrollTop = 1200));
  await page.waitForTimeout(200);
  const far = sidebar.locator("[data-nav-row][aria-label^='Placeholder chat']").filter({ hasNotText: /chat 29[0-9] / });
  const target = far.nth(Math.floor((await far.count()) / 2));
  await watch();
  await target.click();
  await expect(target).toHaveAttribute("aria-current", "page");
  await expect.poll(() => under(target)).toBe(true);
  expect(moved(await stop())).toBe(false);

  // Filtering swaps the list; the fill follows its row there without gliding.
  await scroller(page).evaluate((el) => (el.scrollTop = 0));
  await n(296).click();
  await expect.poll(() => under(n(296))).toBe(true);
  await watch();
  const filter = sidebar.getByRole("searchbox", { name: "Search chats" });
  await filter.fill("Placeholderq296x");
  await expect(n(295)).toHaveCount(0);
  await expect.poll(() => under(n(296))).toBe(true);
  await filter.press("Escape");
  await expect.poll(() => under(n(296))).toBe(true);
  expect(moved(await stop())).toBe(false);
});
