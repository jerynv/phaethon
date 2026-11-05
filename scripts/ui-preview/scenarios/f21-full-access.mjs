// Permissions persist through Settings and the compact composer control.
import { SETTINGS, check, park, openSettings, openSpaceDetails } from "../audit-fixtures.mjs";

const SHOWN = "[data-space-pane][data-shown]";
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page) => page.evaluate(() => window.__MOCK__.fullAccessCalls ?? []);
const model = `${SHOWN} [data-model-picker]`;
async function permissions(page, h) { await h.click(model); await page.waitForSelector('[data-model-menu] [data-access-picker]'); }
const selectAccess = '[data-full-access="school"]';

export default [
  {
    name: "f21-settings-on",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      await page.waitForSelector(selectAccess);
      check(await page.$eval(selectAccess, (select) => select.value === "workspace"), "workspace access is reflected in the setting");
      await page.select(selectAccess, "full");
      check(await waitFor(page, (selector) => document.querySelector(selector)?.value === "full", selectAccess), "full access persists after the core accepts it");
      check(JSON.stringify(await calls(page)) === JSON.stringify([{ id: "school", on: true }]), "the core receives the selected space only");
      check(await waitFor(page, () => [...document.querySelectorAll('[role="dialog"] [role="status"]')].some((element) => element.textContent.includes("School: full access"))), "permission changes are announced");
      await park(page);
    },
  },
  {
    name: "f21-settings-error",
    mock: { settings: SETTINGS, threads: {}, fail: { full_access_set: "Permission settings could not be saved." } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      await page.select(selectAccess, "full");
      check(await waitFor(page, () => [...document.querySelectorAll('[role="dialog"] [role="alert"]')].some((element) => element.textContent.includes("Permission settings could not be saved"))), "a persistence failure is visible");
      check(await page.$eval(selectAccess, (select) => select.value === "workspace"), "a failed permission change preserves workspace access");
      check(await page.evaluate(() => window.__calls.filter(([command]) => command === "full_access_set").length === 1), "a failed permission request is made once");
    },
  },
  {
    name: "f21-composer-access",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await permissions(page, h);
      check(await page.$eval(`[data-model-menu] [data-access-picker]`, (button) => button.getAttribute("aria-label") === "Access: Full access"), "the model menu shows one compact permissions control");
      const height = await page.$eval(`[data-model-menu] [data-access-picker]`, (button) => button.getBoundingClientRect().height);
      check(height <= 36, "permissions use a compact menu row", String(height));
      await park(page);
    },
  },
  {
    name: "f21-composer-access-off",
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await permissions(page, h);
      await h.click(`[data-model-menu] [data-access-picker]`);
      await h.click('[data-access-menu] [role="menuitemradio"]:first-child');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'));
      await permissions(page, h);
      check(await waitFor(page, (selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Access: Space access", `[data-model-menu] [data-access-picker]`), "the model menu reflects workspace access immediately");
      check(JSON.stringify(await calls(page)) === JSON.stringify([{ id: "school", on: false }]), "the core receives the permission change once");
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => !!document.activeElement?.matches("[data-model-picker]")), "focus returns to the model trigger");
    },
  },
  {
    name: "f21-settings-off",
    mock: { settings: SETTINGS, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      await openSpaceDetails(page, ["school"]);
      check(await page.$eval(selectAccess, (select) => select.value === "full"), "Settings reflects saved full access");
      await page.select(selectAccess, "workspace");
      check(await waitFor(page, (selector) => document.querySelector(selector)?.value === "workspace", selectAccess), "Settings persists workspace access");
      await page.keyboard.press("Escape");
      await permissions(page, h);
      check(await waitFor(page, (selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Access: Space access", `[data-model-menu] [data-access-picker]`), "the composer stays synchronized with Settings");
    },
  },
  {
    name: "f21-cli-empty",
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, fullAccess: ["school"] },
    async run(page, h) {
      await page.waitForSelector(`${SHOWN} [data-empty-state]`);
      check(await page.$eval(`${SHOWN} [data-empty-state]`, (empty) => !empty.textContent.includes("anything on this Mac")), "the empty conversation contains no permissions essay");
      await permissions(page, h);
      check(await page.$eval(`[data-model-menu] [data-access-picker]`, (button) => button.getAttribute("aria-label") === "Access: Full access"), "permissions remain available inside the model menu");
    },
  },
];
