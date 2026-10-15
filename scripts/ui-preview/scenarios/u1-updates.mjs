// Updates in Settings › About (src-tauri/src/updater.rs, src/components/settings/updates.tsx).
// Behaviour checks: check(...) fails the run.
//   u1-not-set-up      as the repo ships (no feed, no key): says updates aren't set up, offers no check
//   u1-available       by keyboard: Check for updates finds 0.2.0, says so in the status line, keeps
//                      focus on the button, shows what's new (a scrollable tab stop) and Install and restart
//   u1-installing      Install and restart: progress with its words, focus kept on the (busy) button
//   u1-install-error   a release that fails the signature check: an alert in words, Try again, focus kept
//   u1-check-error     a check that fails: an alert in words; the button stays
//   u1-launch-error    the quiet check at launch failed: shown, not announced (no alert)
//   u1-up-to-date      up to date, with when it was checked
//   u1-dev-build       a development build: the update is shown, but never installed over itself
//   u1-small           available, at 640x480 with 200% text: nothing spills out of the window
import { SETTINGS, check, openSettings, park } from "../audit-fixtures.mjs";

const NOTES = `## What's new
- Updates from GitHub Releases, checked against Phaethon's signature
- Study decks remember the page a card came from
- Fixes: the course import no longer stops on an empty folder

${Array.from({ length: 12 }, (_, i) => `- Smaller fix ${i + 1}`).join("\n")}`;

const SOURCE = "someone/phaethon";
const view = (status, extra = {}) => ({ currentVersion: "0.1.0", source: SOURCE, canInstall: true, status, ...extra });
const AVAILABLE = { state: "available", version: "0.2.0", notes: NOTES, date: "2026-10-12" };
const SIG = "The update didn’t pass Phaethon’s signature check, so it wasn’t installed and nothing was changed. It may have been altered on the way. Try again later, or download Phaethon from its releases page yourself.";
const OFFLINE = "Phaethon couldn’t reach the place updates come from. Check your internet connection, then try again.";

const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const said = (page, text) => waitFor(page, (t) => [...document.querySelectorAll('[role="dialog"] [role="status"]')].some((e) => e.textContent.includes(t)), text);
const focused = (page, sel) => page.evaluate((s) => !!document.activeElement?.matches(s), sel);
const show = (page, sel) => page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sel);

async function about(page, h) {
  await openSettings(page, h, "about");
  await park(page);
}

export default [
  {
    name: "u1-not-set-up",
    mock: { settings: SETTINGS },
    async run(page, h) {
      await about(page, h);
      await h.waitText("Updates aren’t set up for this build");
      check(await page.$('[data-updates="not-set-up"]'), "says updates aren't set up");
      check(!(await page.$("[data-update-check]")), "and offers no check");
      await show(page, '[data-updates="not-set-up"]');
    },
  },
  {
    name: "u1-available",
    mock: { settings: SETTINGS, updates: { view: view({ state: "idle" }), check: view(AVAILABLE) } },
    async run(page, h) {
      await about(page, h);
      await h.focusVia("[data-update-check]");
      await page.keyboard.press("Enter");
      check(await said(page, "Checking for updates"), "says it is checking");
      check(await waitFor(page, () => !!document.querySelector("[data-update-available]")), "the update is shown");
      check(await said(page, "Phaethon 0.2.0 is available."), "and said in the status line");
      check(await focused(page, "[data-update-check]"), "focus stays on Check for updates");
      const text = await page.$eval("[data-update-available]", (e) => e.innerText);
      check(text.includes("Phaethon 0.2.0 is available") && text.includes("You have 0.1.0") && /Released (12 October|October 12,) 2026/.test(text), "names both versions and the date", text.slice(0, 120));
      check(text.includes("Study decks remember the page"), "shows what's new");
      await page.keyboard.press("Tab");
      check(await focused(page, "[data-update-notes]"), "what's new is a tab stop, so it scrolls by keyboard");
      await page.keyboard.press("Tab");
      check(await focused(page, "[data-update-install]"), "then Install and restart");
      const desc = await page.$eval("[data-update-install]", (b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent ?? "");
      check(desc.includes("closes and opens again"), "which says it restarts", desc);
      await show(page, "[data-update-available]");
    },
  },
  {
    name: "u1-installing",
    mock: {
      settings: SETTINGS,
      updates: {
        view: view(AVAILABLE),
        install: [
          { kind: "downloading", received: 1_200_000, total: 12_400_000 },
          { kind: "downloading", received: 5_300_000, total: 12_400_000 },
        ],
        holdInstall: true,
      },
    },
    async run(page, h) {
      await about(page, h);
      await h.focusVia("[data-update-install]");
      await page.keyboard.press("Enter");
      check(await said(page, "Downloading the update"), "says the download started");
      check(await waitFor(page, () => document.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow") === "43"), "progress shows 43%");
      const vt = await page.$eval('[role="progressbar"]', (e) => e.getAttribute("aria-valuetext"));
      check(vt === "Downloading: 5.3 MB of 12.4 MB", "and says it in words", vt);
      check(await focused(page, "[data-update-install]"), "focus stays on the button");
      const btn = await page.$eval("[data-update-install]", (b) => ({ dis: b.getAttribute("aria-disabled"), text: b.textContent }));
      check(btn.dis === "true" && btn.text.includes("Installing"), "which reads Installing… and is busy", JSON.stringify(btn));
      await page.keyboard.press("Enter");
      const installs = await page.evaluate(() => window.__calls.filter(([c]) => c === "update_install").length);
      check(installs === 1, "pressing it again starts nothing", String(installs));
      await show(page, "[data-update-progress]");
    },
  },
  {
    name: "u1-install-error",
    mock: {
      settings: SETTINGS,
      updates: { view: view(AVAILABLE), install: [{ kind: "downloading", received: 12_400_000, total: 12_400_000 }], installError: SIG },
    },
    async run(page, h) {
      await about(page, h);
      await h.focusVia("[data-update-install]");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => !!document.querySelector('[data-update-install-error][role="alert"]')), "the failure is an alert");
      const text = await page.$eval("[data-update-install-error]", (e) => e.textContent);
      check(text.includes("signature check") && text.includes("wasn’t installed"), "in words", text);
      check(await focused(page, "[data-update-install]"), "focus stays on the button");
      const label = await page.$eval("[data-update-install]", (b) => b.textContent.trim());
      check(label === "Try again", "which now reads Try again", label);
      check(!(await page.$('[role="progressbar"]')), "and the progress is gone");
      await show(page, "[data-update-available]");
    },
  },
  {
    name: "u1-check-error",
    mock: { settings: SETTINGS, updates: { view: view({ state: "idle" }), check: view({ state: "error", message: OFFLINE, during: "check" }) } },
    async run(page, h) {
      await about(page, h);
      await h.focusVia("[data-update-check]");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => !!document.querySelector('[data-update-error][role="alert"]')), "the failure is an alert");
      const text = await page.$eval("[data-update-error]", (e) => e.textContent);
      check(text.includes("Couldn’t check for updates") && text.includes("internet connection"), "in words", text);
      check(await focused(page, "[data-update-check]"), "focus stays on Check for updates");
      await show(page, "[data-update-error]");
    },
  },
  {
    name: "u1-launch-error",
    mock: { settings: SETTINGS, updates: { view: view({ state: "error", message: OFFLINE, during: "launch" }) } },
    async run(page, h) {
      await about(page, h);
      check(await waitFor(page, () => !!document.querySelector("[data-update-error]")), "the launch check's failure is shown");
      const el = await page.$eval("[data-update-error]", (e) => ({ role: e.getAttribute("role"), text: e.textContent }));
      check(el.role === null, "but not as an alert: nothing nags", JSON.stringify(el));
      check(el.text.startsWith("When Phaethon started"), "and says when it happened", el.text);
      await show(page, "[data-update-error]");
    },
  },
  {
    name: "u1-up-to-date",
    mock: { settings: SETTINGS, updates: { view: view({ state: "upToDate", checkedAt: Date.UTC(2026, 9, 12, 14, 5) }) } },
    async run(page, h) {
      await about(page, h);
      await h.waitText("Phaethon 0.1.0 is the newest version. Checked at");
      check(!(await page.$("[data-update-available]")), "nothing offered");
      await show(page, "[data-update-check]");
    },
  },
  {
    name: "u1-dev-build",
    mock: { settings: SETTINGS, updates: { view: view(AVAILABLE, { canInstall: false }) } },
    async run(page, h) {
      await about(page, h);
      check(await waitFor(page, () => !!document.querySelector("[data-update-dev]")), "says a development build doesn't install");
      check(!(await page.$("[data-update-install]")), "and offers no Install");
      await show(page, "[data-update-dev]");
    },
  },
  {
    name: "u1-small",
    sizes: [[640, 480]],
    sizesRequired: true,
    themes: ["light"],
    mock: { settings: { ...SETTINGS, appearance: { tokens: { "--ph-text-scale": 2 } } }, updates: { view: view(AVAILABLE) } },
    async run(page, h) {
      await about(page, h);
      check(await waitFor(page, () => !!document.querySelector("[data-update-install]")), "shown");
      await show(page, "[data-update-install]");
      const fit = await page.evaluate(() => {
        const panel = document.querySelector('[role="dialog"] [role="tabpanel"]:not([hidden])').getBoundingClientRect();
        const over = [...document.querySelectorAll("[data-update-available] *")].filter((e) => e.getBoundingClientRect().right > panel.right + 0.5);
        return { over: over.map((e) => e.tagName + (e.className ? "." + String(e.className).slice(0, 30) : "")).slice(0, 5), page: document.documentElement.scrollWidth <= innerWidth };
      });
      check(fit.over.length === 0 && fit.page, "nothing spills out of the window", JSON.stringify(fit));
    },
  },
];
