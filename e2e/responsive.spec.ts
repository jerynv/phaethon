import type { Page } from "@playwright/test";
import { expect, openNewSpace, startCore, test, type Core } from "./core";

/**
 * The window at any size from its minimum (380 × 480, src/desktop/main.ts)
 * up: too narrow to dock the sidebar beside a page, the sidebar floats over
 * the page when asked for and goes away once something is chosen; Settings
 * trades its nav column for a section menu; and no page puts a control past
 * the window's right edge.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function studySpace(page: Page) {
  await openNewSpace(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("Fall term");
  await dialog.getByRole("switch").click();
  await dialog.getByRole("button", { name: "Create space" }).click();
  await expect(page.getByRole("list", { name: "Views" })).toBeVisible();
}

/** Controls on the visible page (and the title bar) whose box runs past the window's right edge, outside anything that scrolls sideways. */
function controlsPastEdge(page: Page) {
  return page.evaluate(() => {
    const W = window.innerWidth;
    const scrollsSideways = (el: Element) => {
      for (let a = el.parentElement; a; a = a.parentElement) if (/(auto|scroll)/.test(getComputedStyle(a).overflowX)) return true;
      return false;
    };
    const roots = [document.querySelector("[data-slot=app-header]"), document.querySelector("[data-page]:not([data-inactive])"), document.querySelector("[role=dialog]")].filter(Boolean) as Element[];
    const out: string[] = [];
    for (const root of roots)
      for (const el of root.querySelectorAll("button, a[href], input, [role=tab], [role=switch]")) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height || el.closest("[inert]")) continue;
        if (r.right > W + 1 && !scrollsSideways(el)) out.push(`${el.getAttribute("aria-label") ?? (el.textContent ?? "").trim().slice(0, 40)} (right ${Math.round(r.right)} > ${W})`);
      }
    return out;
  });
}

test("a narrow window floats the sidebar over the page, and choosing something puts it away", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await studySpace(page);
  const sidebar = page.locator("[data-slot=sidebar-container]");
  const main = page.locator("main");

  await page.setViewportSize({ width: 600, height: 600 });
  // Shut, and the page has the whole width.
  await expect(sidebar).not.toBeInViewport();
  expect((await main.boundingBox())!.width).toBe(600);
  const toggle = page.getByRole("button", { name: "Show sidebar" });
  await toggle.click();
  await expect(sidebar).toBeInViewport();
  // It lies over the page rather than pushing it.
  expect((await main.boundingBox())!.width).toBe(600);
  await page.keyboard.press("Escape");
  await expect(sidebar).not.toBeInViewport();
  await expect(toggle).toBeFocused();

  await toggle.click();
  await sidebar.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Grades/ }).click();
  await expect(page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { name: "Grades" })).toHaveAttribute("aria-selected", "true");
  await expect(sidebar).not.toBeInViewport();

  // Settings has no room for its nav column: a menu of its sections instead.
  await toggle.click();
  await sidebar.getByRole("button", { name: "Settings" }).click();
  await expect(sidebar).not.toBeInViewport();
  const bar = page.getByRole("navigation", { name: "Settings" }).filter({ visible: true });
  await bar.getByRole("button", { name: /General/ }).click();
  await page.getByRole("menuitem", { name: /Appearance/ }).click();
  await expect(page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");
  await expect(bar.getByRole("button", { name: /Appearance/ })).toBeVisible();

  // A wide window docks it again, where it was.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sidebar).toBeInViewport();
  expect((await main.boundingBox())!.width).toBeLessThan(1280);
});

/** Opens a Settings section through whichever nav Settings shows at this width: its column, or its section menu. */
async function settingsSection(page: Page, label: string) {
  const navs = page.getByRole("navigation", { name: "Settings" }).filter({ visible: true });
  await expect(navs).toHaveCount(1);
  const menu = navs.locator("[aria-haspopup=menu]");
  if (!(await menu.count())) return navs.getByRole("button", { name: new RegExp(`^${label}`) }).click();
  await menu.click();
  await page.getByRole("menuitem", { name: new RegExp(`^${label}`) }).click();
  await expect(menu).toContainText(label);
}

test("no page puts a control past the window's edge, from the smallest window up", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await studySpace(page);
  const views = ["Chat", "Study", "Grades", "Plan", "Courses"];
  for (const [width, height] of [
    [380, 480],
    [560, 600],
    [800, 600],
  ] as const) {
    await page.setViewportSize({ width, height });
    const check = async (name: string) => {
      await page.waitForTimeout(400);
      expect(await controlsPastEdge(page), `${name} at ${width}×${height}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${name} at ${width}×${height}`).toBeLessThanOrEqual(width);
    };
    for (const [i, view] of views.entries()) {
      await page.keyboard.press(`ControlOrMeta+Alt+Digit${i + 1}`);
      await expect(page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { selected: true })).toContainText(view === "Chat" ? /./ : view);
      await check(view);
    }
    await page.keyboard.press("ControlOrMeta+Comma");
    for (const section of ["General", "Providers", "Spaces", "Appearance"]) {
      await settingsSection(page, section);
      await check(`Settings › ${section}`);
    }
    await page.keyboard.press("Escape");
  }
});
