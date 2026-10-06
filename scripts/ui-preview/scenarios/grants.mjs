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

const settings = { backend: "steward", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: {}, vaultPath: "/Users/you/Steward/default", version: "0.1.0" };

const CHIP = "[data-grants-chip]";
const POPOVER = '[data-radix-popper-content-wrapper] [role="dialog"]';

const chipName = (page) => page.evaluate((s) => document.querySelector(s)?.getAttribute("aria-label") ?? null, CHIP);
const revokeCalls = (page) => page.evaluate(() => window.__calls.filter(([c]) => c === "grant_revoke").map(([, a]) => a.id));
const titleStatus = (page) => page.evaluate(() => document.querySelector('header [role="status"]')?.textContent ?? "");

const openSettings = async (page, h) => {
  await h.click('[data-testid="open-settings"]');
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
      if (!name?.startsWith("Also reads Work / calendar +1 more. School can also read 2 places in another space"))
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
      await page.keyboard.press("Enter");
      await page.waitForSelector(POPOVER, { timeout: 5000 });
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
      await h.click(`${POPOVER} [data-revoke]`);
      await h.idle();
      let calls = await revokeCalls(page);
      if (calls.join() !== "g-cal") throw new Error(`grant_revoke calls: ${JSON.stringify(calls)}`);
      const name = await chipName(page);
      if (!name?.startsWith("Also reads Work / projects/now.md.")) throw new Error(`chip did not update: ${name}`);
      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      if (focused !== "Revoke access to Work / projects/now.md") throw new Error(`focus after revoke: ${focused}`);
      const said = await titleStatus(page);
      console.log(`     after first revoke: chip "${name}", status "${said}"`);
      if (said !== "School can no longer read Work / calendar.") throw new Error(`status: ${said}`);
      // The last revoke removes the chip; the shot shows the window after it.
      await page.keyboard.press("Enter");
      await h.idle();
      calls = await revokeCalls(page);
      const gone = await page.evaluate((s) => !document.querySelector(s), CHIP);
      const onMain = await page.evaluate(() => document.activeElement?.id);
      console.log(`     after last revoke: calls ${JSON.stringify(calls)}, chip gone ${gone}, focus #${onMain}, status "${await titleStatus(page)}"`);
      if (calls.join() !== "g-cal,g-now" || !gone || onMain !== "main") throw new Error("last revoke did not clear the chip and move focus to the conversation");
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
      await h.waitText("Can't read anything outside School.");
      await h.idle();
      const calls = await revokeCalls(page);
      const focus = await page.evaluate(() => document.activeElement?.textContent ?? "");
      const chip = await page.evaluate((s) => !!document.querySelector(s), CHIP);
      console.log(`     settings revoke: calls ${JSON.stringify(calls)}, focus "${focus}", title bar chip still shown ${chip}`);
      if (calls.join() !== "g-cal" || !focus.includes("Can't read anything outside School") || chip) throw new Error("revoke from Settings did not update the list, focus and title bar");
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
