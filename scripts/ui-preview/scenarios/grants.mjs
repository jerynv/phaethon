// Read-only grants between spaces: the title bar's "Also reads" chip, its
// popover, revoking (from the popover and from Settings), Settings > Spaces
// with grants and with a broken grants.json entry, and the no-grants state.
// The revoke scenarios are behaviour checks: they fail unless grant_revoke is
// called with the right id and the UI follows.

const thread = [
  { role: "user", text: "When is my next C241 lab?", attachments: [] },
  { role: "assistant", text: "Thursday at 2 pm, from `calendar/fall.ics` in Work, which you let School read.", attachments: [] },
];

const grants = () => ({
  school: [
    { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" },
    { id: "g-now", from: "work", path: "projects/now.md", created: "2026-10-10T09:00:00Z", scope: "always" },
  ],
});

const settings = { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: {}, vaultPath: "/Users/you/Phaethon/default", version: "0.1.0" };

const CHIP = "[data-grants-chip]";
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]';

import { chipA11y } from "./audit-shell.mjs";

/** "<name> | <description>", as a screen reader gets the chip. */
const chipName = async (page) => {
  const a = await chipA11y(page);
  return a ? `${a.name} | ${a.desc}` : null;
};
const revokeCalls = (page) => page.evaluate(() => window.__calls.filter(([c]) => c === "grant_revoke").map(([, a]) => a.id));
/**
 * Press Enter on the focused button and wait for `happened`. Obscura never
 * activates a focused button from the keyboard (Chromium does), so when
 * nothing happens the focused element is clicked instead: the check that
 * focus is on the right button still holds.
 */
async function pressEnter(page, happened) {
  await page.keyboard.press("Enter");
  if (await happened().then(() => true, () => false)) return;
  console.log("     (Enter did not activate the focused button in this engine: clicking it instead)");
  await page.evaluate(() => document.activeElement?.click());
  await happened();
}
const titleStatus = (page) => page.evaluate(() => document.querySelector('header [role="status"]')?.textContent ?? "");

const openSettings = async (page, h) => {
  // The sidebar's entry, or the title bar's when a small window starts with the sidebar hidden.
  await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await h.idle();
  await h.click('[data-testid="settings-tab-spaces"]');
  await h.idle();
};

export default [
  {
    name: "grants-titlebar",
    mock: { threads: { school: thread }, grants: grants() },
    async run(page, h) {
      await page.waitForSelector(CHIP, { timeout: 5000 });
      const name = await chipName(page);
      console.log(`     chip name: ${name}`);
      // A narrow window (under 768px) collapses the chip to the count and what it counts.
      const shown = page.viewport().width < 768 ? "Also reads 2 places" : "Also reads Work / projects/now.md +1 more";
      if (name !== `${shown} | School can also read 2 places in another space.`)
        throw new Error(`unexpected chip name: ${name}`);
      // The chip is a button inside the drag region and must not carry the drag attribute itself.
      const drag = await page.evaluate((s) => document.querySelector(s)?.hasAttribute("data-tauri-drag-region"), CHIP);
      if (drag) throw new Error("chip carries data-tauri-drag-region");
      await page.mouse.move(600, 400);
      await h.idle();
    },
  },
  {
    name: "grants-titlebar-windows",
    mock: { platform: "windows", threads: { school: thread }, grants: { school: [grants().school[0]] } },
    async run(page, h) {
      await page.waitForSelector("[data-window-control]", { timeout: 5000 });
      await page.waitForSelector(CHIP, { timeout: 5000 });
      await page.hover(CHIP);
      await h.idle();
    },
  },
  {
    name: "grants-popover",
    mock: { threads: { school: thread }, grants: grants() },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await h.idle();
      const focus = await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent}`);
      if (focus !== "H2 School can also read") throw new Error(`focus on open is ${focus}, expected the popover's heading`);
      // Keyboard: Escape closes and returns focus to the chip.
      await page.keyboard.press("Escape");
      await h.idle();
      const back = await page.evaluate((s) => document.activeElement === document.querySelector(s), CHIP);
      if (!back) throw new Error("Escape did not return focus to the chip");
      await pressEnter(page, () => page.waitForSelector(POPOVER, { timeout: 1500 }));
      await h.idle();
    },
  },
  {
    name: "grants-revoke",
    mock: { threads: { school: thread }, grants: grants() },
    async run(page, h) {
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await h.idle();
      // Most recent first: projects/now.md (Oct 10) is the first row. Revoke is made at once;
      // for 6 s the row offers Undo, which puts the same grant back.
      await h.click(`${POPOVER} [data-revoke]`);
      await h.idle();
      let calls = await revokeCalls(page);
      if (calls.join() !== "g-now") throw new Error(`Revoke must be made at once: ${JSON.stringify(calls)}`);
      let said = await titleStatus(page);
      if (!said.startsWith("School can no longer read Work / projects/now.md.")) throw new Error(`status on revoke: ${said}`);
      console.log("     check: Revoke is made at once and announced once");
      // Undo puts it back, with the same id.
      await h.click(`${POPOVER} [data-undo]`);
      await h.idle();
      const restored = await page.evaluate(() => window.__calls.filter(([c]) => c === "grant_restore").map(([, a]) => a.id));
      if (restored.join() !== "g-now") throw new Error(`Undo did not restore the grant: ${JSON.stringify(restored)}`);
      await page.waitForFunction(() => (window.__MOCK__.grants.school ?? []).some((g) => g.id === "g-now"), { timeout: 3000 });
      console.log("     check: Undo puts the same grant back");
      // Revoke it again and let the Undo time pass.
      await h.click(`${POPOVER} [data-revoke]`);
      await page.waitForFunction(() => !document.querySelector('[data-undo="g-now"]'), { timeout: 9000 });
      await h.idle();
      calls = await revokeCalls(page);
      if (calls.join() !== "g-now,g-now") throw new Error(`grant_revoke calls: ${JSON.stringify(calls)}`);
      const name = await chipName(page);
      const shown = page.viewport().width < 768 ? "Also reads 1 folder" : "Also reads Work / calendar";
      if (name !== `${shown} | School can also read 1 folder in another space.`) throw new Error(`chip did not update: ${name}`);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (focused !== "Remove access to Work / calendar") throw new Error(`focus after revoke: ${focused}`);
      said = await titleStatus(page);
      console.log(`     after first revoke: chip "${name}", status "${said}"`);
      if (!said.startsWith("School can no longer read Work / projects/now.md.")) throw new Error(`status: ${said}`);
      // The last revoke removes the chip; the shot shows the window after it.
      await pressEnter(page, () => page.waitForSelector(`${POPOVER} [data-undo]`, { timeout: 1500 }));
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "grant_revoke").length === 3, { timeout: 8000 });
      await page.waitForFunction(() => !document.querySelector("[data-undo]"), { timeout: 9000 });
      await h.idle();
      calls = await revokeCalls(page);
      const gone = await page.evaluate((s) => !document.querySelector(s), CHIP);
      const onMain = await page.evaluate(() => document.activeElement?.id);
      console.log(`     after last revoke: calls ${JSON.stringify(calls)}, chip gone ${gone}, focus #${onMain}, status "${await titleStatus(page)}"`);
      if (calls.join() !== "g-now,g-now,g-cal" || !gone || onMain !== "main") throw new Error("last revoke did not clear the chip and move focus to the conversation");
    },
  },
  {
    // "Manage in Settings" opens Settings at Spaces, sidebar shown or hidden.
    name: "grants-manage-in-settings",
    mock: { threads: { school: thread }, settings, grants: grants() },
    async run(page, h) {
      // A narrow window starts with the sidebar hidden already; a wide one hides it with the toggle.
      if (!(await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden))) await h.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[hidden]", { timeout: 5000 });
      await h.click(CHIP);
      await page.waitForSelector(POPOVER, { timeout: 5000 });
      await h.idle();
      await page.evaluate((sel) => [...document.querySelectorAll(`${sel} button`)].find((b) => b.textContent.includes("Manage in Settings"))?.click(), POPOVER);
      await page.waitForSelector('[data-testid="settings-tab-spaces"][data-state="active"]', { timeout: 5000 });
      console.log("     Manage in Settings opened Settings at Spaces with the sidebar hidden");
      await h.idle();
    },
  },
  {
    name: "grants-settings",
    mock: { threads: { school: thread }, settings, grants: grants() },
    run: (page, h) => openSettings(page, h),
  },
  {
    name: "grants-settings-problem",
    mock: {
      threads: { school: thread },
      settings,
      grants: { school: [grants().school[0]] },
      grantProblems: ["Grant 2 was ignored: \"from\" names a space that does not exist (\"home\")."],
    },
    async run(page, h) {
      await openSettings(page, h);
      await page.evaluate(() => document.querySelector('[role="tabpanel"]:not([hidden])')?.scrollBy(0, 99999));
      await h.idle();
    },
  },
  {
    name: "grants-settings-revoke",
    mock: { threads: { school: thread }, settings, grants: { school: [grants().school[0]] } },
    async run(page, h) {
      await openSettings(page, h);
      await h.click('[role="tabpanel"]:not([hidden]) [data-revoke]');
      // Either apostrophe: Settings' copy is moving to the curly one.
      await page.waitForFunction(() => /Can[’']t read anything outside School\./.test(document.body.innerText), { timeout: 5000 });
      await h.idle();
      const calls = await revokeCalls(page);
      const focus = await page.evaluate(() => document.activeElement?.textContent ?? "");
      const chip = await page.evaluate((s) => !!document.querySelector(s), CHIP);
      console.log(`     settings revoke: calls ${JSON.stringify(calls)}, focus "${focus}", title bar chip still shown ${chip}`);
      if (calls.join() !== "g-cal" || !/Can[’']t read anything outside School/.test(focus) || chip) throw new Error("revoke from Settings did not update the list, focus and title bar");
    },
  },
  {
    name: "grants-none",
    mock: { threads: { school: thread }, grants: {} },
    async run(page, h) {
      await h.idle();
      const listed = await page.evaluate(() => window.__calls.some(([c, a]) => c === "grants_list" && a.space === "school"));
      const chip = await page.evaluate((s) => !!document.querySelector(s), CHIP);
      if (!listed || chip) throw new Error(`grants_list asked: ${listed}; chip shown: ${chip}`);
    },
  },
];
