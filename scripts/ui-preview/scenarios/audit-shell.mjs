// Audit: the window shell. Title bars per platform, inactive window, sidebar
// states (hover, focus, pressed, active per space hue, collapsed), the sidebar
// toggle tooltip, the skip link, window controls (hover, pressed), and the
// grants chip with its popover (hover, focus, open, revoke, many, long paths).
import { CONVERSATION, GRANTS, SETTINGS, WORK_THREAD, activeDesc, blurWindow, check, park } from "../audit-fixtures.mjs";

const CHIP = "[data-grants-chip]";
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]';
const WIDE = [[1100, 720]];
const ctrl = (label) => `[data-window-control][aria-label="${label}"]`;

const platform = (p) => ({
  name: `audit-shell-${p}`,
  sizes: [[1100, 720], [640, 480]],
  mock: { platform: p, settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
  async run(page, h) {
    await h.idle();
    await park(page);
    if (p === "mac") return;
    await page.waitForSelector("[data-window-control]", { timeout: 5000 });
    await h.hover(ctrl("Minimize"));
    await h.idle();
    await h.shot("minimize-hover");
    await h.press(ctrl("Maximize"));
    await h.shot("maximize-pressed");
    await page.mouse.up();
    await h.hover(ctrl("Close"));
    await h.idle();
    await h.shot("close-hover");
    await h.press(ctrl("Close"));
    await h.shot("close-pressed");
    await page.mouse.up();
    await park(page);
    // Keyboard focus on Close (the ring is drawn inside the button).
    await page.focus(ctrl("Close"));
    await page.keyboard.press("Shift"); // marks keyboard modality for :focus-visible
    await h.idle();
  },
});

export default [
  platform("mac"),
  platform("windows"),
  platform("linux"),
  {
    name: "audit-shell-inactive",
    sizes: WIDE,
    mock: { platform: "windows", settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.idle();
      await park(page);
      await blurWindow(page);
      await h.idle();
      const dim = await page.evaluate(() => document.querySelector("header")?.hasAttribute("data-inactive"));
      check(dim, "the title bar is marked inactive after the window blurs");
    },
  },
  {
    name: "audit-shell-sidebar",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION, work: WORK_THREAD } },
    async run(page, h) {
      await h.idle();
      await h.hover("#spaces-sidebar li:nth-child(2) button");
      await h.idle();
      await h.shot("work-hovered");
      await h.press("#spaces-sidebar li:nth-child(2) button");
      await h.shot("work-pressed");
      await page.mouse.up();
      await h.idle();
      await park(page);
      await h.shot("work-active");
      // Keyboard: from the top of the page, Tab to the first space.
      await page.evaluate(() => document.activeElement?.blur());
      await h.focusVia("#spaces-sidebar li:nth-child(1) button");
      await h.idle();
      await h.shot("school-focused-keyboard");
      await h.focusVia('[data-testid="open-settings"]');
      await h.idle();
      await h.shot("settings-focused");
      await h.hover('[data-testid="open-settings"]');
      await h.idle();
    },
  },
  {
    name: "audit-shell-toggle-tooltip",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.hover('button[aria-controls="spaces-sidebar"]');
      await new Promise((r) => setTimeout(r, 900));
      await page.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 });
      await h.shot("open-sidebar-tooltip");
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[hidden]", { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("collapsed");
      await h.hover('button[aria-controls="spaces-sidebar"]');
      await new Promise((r) => setTimeout(r, 900));
      // Collapsed, keyboard focus on the toggle also shows the tooltip.
    },
  },
  {
    name: "audit-shell-skip-link",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await h.idle();
      await page.keyboard.press("Tab");
      await h.idle();
      const a = await activeDesc(page);
      check(a.includes("Skip to conversation"), "the first Tab lands on the skip link", a);
    },
  },
  {
    name: "audit-shell-chip-hover",
    sizes: WIDE,
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.hover(CHIP);
      await h.idle();
      await h.shot("hover");
      await h.press(CHIP);
      await h.shot("pressed");
      await page.mouse.up();
      await page.keyboard.press("Escape");
      await park(page);
      await h.idle();
      await page.evaluate(() => document.activeElement?.blur());
      await h.focusVia(CHIP);
      await h.idle();
    },
  },
  {
    name: "audit-shell-popover",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
      await h.shot("open");
      await page.keyboard.press("Tab");
      await h.idle();
      await h.shot("first-revoke-focused");
      await h.hover(`${POPOVER} [data-revoke]`);
      await h.idle();
      await h.shot("revoke-hover");
      await page.click(`${POPOVER} [data-revoke]`);
      await h.idle();
      await park(page);
      await h.idle();
      // After a revoke: one grant left, focus on its Revoke.
    },
  },
  {
    name: "audit-shell-popover-many",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.many }, grantProblems: ['Grant 7 was ignored: "from" names a space that does not exist ("garden").'] },
    async run(page, h) {
      await h.idle();
      await park(page);
      await h.shot("chip");
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-shell-popover-long",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.long } },
    async run(page, h) {
      await h.idle();
      await park(page);
      await h.shot("chip");
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await park(page);
      await h.idle();
    },
  },
  {
    name: "audit-shell-popover-revoke-error",
    sizes: WIDE,
    themes: ["light"],
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two }, fail: { grant_revoke: "grants.json is read-only (permission denied)" } },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await h.idle();
      await page.click(`${POPOVER} [data-revoke]`);
      await h.waitText("Could not revoke");
      await park(page);
      await h.idle();
    },
  },
];
