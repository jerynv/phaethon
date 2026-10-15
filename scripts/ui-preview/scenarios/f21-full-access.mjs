// Full access for a space (src/lib/full-access.ts, src-tauri/src/full_access.rs): off by default,
// turned on only through the core's own warning, shown while on, and turned off in one press.
//   f21-settings-on      Settings › Spaces › Edit: Give full access… asks the core; on, the row says so
//                        folded and open, the status says it, focus stays on the button
//   f21-declined         the system's warning cancelled: still off, said so, no banner
//   f21-banner           a space with full access: the banner above the message box, only in that space;
//                        Turn off ends it, says so, and puts focus in the message box
//   f21-settings-off     Turn off full access in Settings, and the banner goes
//   f21-cli-empty        on a CLI backend with full access, the empty conversation promises no walls
import { SETTINGS, check, park, openSettings, openSpaceDetails } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page) => page.evaluate(() => window.__MOCK__.fullAccessCalls ?? []);

export default [
  {
    name: "f21-settings-on",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      const btn = '[data-full-access="school"] [data-full-access-toggle]';
      await page.waitForSelector(btn, { timeout: 4000 });
      check((await page.$eval(btn, (b) => b.textContent.trim())) === "Give full access…", "off by default");
      await page.focus(btn);
      await page.keyboard.press("Enter");
      check(await waitFor(page, (s) => document.querySelector(s)?.getAttribute("data-full-access-toggle") === "off", btn), "on after the core's warning");
      check(JSON.stringify(await calls(page)) === JSON.stringify([{ id: "school", on: true }]), "asked the core for that space only");
      check(await page.evaluate((s) => document.activeElement === document.querySelector(s), btn), "focus stays on the button");
      check(
        await waitFor(page, () => [...document.querySelectorAll('[role="dialog"] [role="status"]')].some((e) => e.textContent.includes("Full access is on for School"))),
        "said in the status region",
      );
      check(!!(await page.$('[data-space-row="school"] [data-space-full-access]')), "the row says so");
      check(!(await page.$('[data-space-row="work"] [data-space-full-access]')), "and only that row");
      await page.evaluate(() => document.querySelector('[data-full-access="school"]').scrollIntoView({ block: "center" }));
      await park(page);
    },
  },
  {
    name: "f21-declined",
    mock: { settings: SETTINGS, threads: {}, fullAccessDeclined: true },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      const btn = '[data-full-access="school"] [data-full-access-toggle]';
      await page.waitForSelector(btn, { timeout: 4000 });
      await page.click(btn);
      check(await waitFor(page, () => [...document.querySelectorAll('[role="dialog"] [role="status"]')].some((e) => e.textContent.includes("stays off"))), "said it stays off");
      check((await page.$eval(btn, (b) => b.getAttribute("data-full-access-toggle"))) === "on", "still off");
      await page.keyboard.press("Escape");
      check(!(await page.$("[data-full-access-banner]")), "no banner");
    },
  },
  {
    name: "f21-banner",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page) {
      check(await waitFor(page, (s) => !!document.querySelector(`${s} [data-full-access-banner]`), SHOWN), "the banner shows in the space");
      const b = await page.$eval(`${SHOWN} [data-full-access-banner]`, (e) => ({ text: e.textContent, label: e.getAttribute("aria-label") }));
      check(b.label === "Full access" && b.text.includes("Full access is on.") && b.text.includes("without asking"), "in words", JSON.stringify(b));
      const inWork = await page.evaluate(() => [...document.querySelectorAll("[data-space-pane]")].filter((p) => p.getAttribute("data-space-pane") === "work").some((p) => p.querySelector("[data-full-access-banner]")));
      check(!inWork, "not in another space");
      await park(page);
    },
  },
  {
    name: "f21-banner-off",
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-full-access-off]`, { timeout: 4000 });
      await h.focusVia(`${SHOWN} [data-full-access-off]`);
      await page.keyboard.press("Enter");
      check(await waitFor(page, (s) => !document.querySelector(`${s} [data-full-access-banner]`), SHOWN), "the banner goes");
      check(JSON.stringify(await calls(page)) === JSON.stringify([{ id: "school", on: false }]), "turned off in the core");
      check(await page.evaluate(() => !!document.activeElement?.matches("[data-composer-input]")), "focus in the message box");
      check(await waitFor(page, () => document.body.textContent.includes("Full access is off")), "said so");
    },
  },
  {
    name: "f21-settings-off",
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      const btn = '[data-full-access="school"] [data-full-access-toggle]';
      await page.waitForSelector(btn, { timeout: 4000 });
      check((await page.$eval(btn, (b) => b.textContent.trim())) === "Turn off full access", "on, with Turn off");
      await page.click(btn);
      check(await waitFor(page, (s) => document.querySelector(s)?.getAttribute("data-full-access-toggle") === "on", btn), "off");
      check(!(await page.$('[data-space-row="school"] [data-space-full-access]')), "the row no longer says so");
      await page.keyboard.press("Escape");
      check(await waitFor(page, (s) => !document.querySelector(`${s} [data-full-access-banner]`), SHOWN), "and no banner");
    },
  },
  {
    name: "f21-cli-empty",
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, fullAccess: ["school"] },
    async run(page) {
      check(await waitFor(page, () => document.querySelector("[data-space-pane][data-shown] [data-empty-reach]")?.textContent.includes("full access")), "says it has full access");
      const t = await page.$eval("[data-space-pane][data-shown] [data-empty-reach]", (e) => e.textContent.replace(/\s+/g, " ").trim());
      check(t === "Codex answers here, with full access: it can read and change anything on this Mac and use the internet, without asking.", "and no walls are promised", t);
    },
  },
];
