// App shell scenarios: title bar per platform, collapsed sidebar, keyboard focus.
//
// Two Obscura gaps are worked around here, in the harness only:
// - It does not move focus on Tab and never matches :focus-visible. The
//   keyboard scenarios check the tab order from the DOM, move focus with
//   element.focus() and arrow keys (which it does deliver), and draw the ring
//   with the same tokens as the global :focus-visible rule in index.css.
// - It drops any oklch() colour that has a calc() inside it (most dark-theme
//   tokens, and the light surfaces), so those render transparent or black.
//   resolveTokens() evaluates those calc()s and pins the results inline, so
//   the screenshot shows what a real webview shows.

const thread = [
  { role: "user", text: "What is on my plate at work this week?", attachments: [] },
  {
    role: "assistant",
    text: "Three things from `projects/now.md`:\n\n1. Review the onboarding doc by **Tuesday**.\n2. Send the Q4 numbers to Dana.\n3. Prep slides for Friday's sync.",
    attachments: [],
  },
];

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Obscura matches neither :focus-visible nor :focus when painting, so the
// focused element is tagged and drawn with the same tokens as index.css.
const RING = `[data-shot-focus] { outline: var(--st-focus-width) solid var(--st-focus) !important; outline-offset: var(--st-focus-offset) !important; }
a[data-shot-focus][href="#main"] { position: fixed; top: calc(var(--st-titlebar-height) + var(--st-space) * 3); left: 50%; transform: translateX(-50%); z-index: 50; width: auto; height: auto; margin: 0; clip: auto; clip-path: none; overflow: visible; white-space: nowrap; border-radius: var(--st-radius); background: var(--st-raised); color: var(--st-ink); padding: var(--st-space) calc(var(--st-space) * 3); font-weight: var(--st-weight-medium); box-shadow: var(--st-shadow); }`;
const tagFocus = (page) => page.evaluate(() => document.activeElement?.setAttribute("data-shot-focus", ""));

/** Append a stylesheet (page.addStyleTag can hang in Obscura). */
const addStyle = (page, css) =>
  page.evaluate((css) => {
    const s = document.createElement("style");
    s.textContent = css;
    document.head.append(s);
  }, css);

/** Every --st-* token name, read from the stylesheets on disk. */
const here = dirname(fileURLToPath(import.meta.url));
const TOKEN_NAMES = [
  ...new Set(
    ["../../../src/styles/tokens.css", "../../../src/components/shell/shell.css"].flatMap((f) =>
      readFileSync(join(here, f), "utf8").match(/--st-[a-z0-9-]+(?=\s*:)/g) ?? [],
    ),
  ),
];

/** Evaluate unitless calc()s inside every --st-* colour token and pin them inline. */
export async function resolveTokens(page) {
  await page.evaluate((names) => {
    const fix = (v) => {
      let prev;
      do {
        prev = v;
        v = v.replace(/calc\(([-\d.\s*/+]+)\)/g, (_, expr) => String(Function(`return (${expr})`)()));
      } while (v !== prev);
      return v;
    };
    const pin = (el) => {
      const cs = getComputedStyle(el);
      for (const p of names) {
        const v = cs.getPropertyValue(p).trim();
        if (v.includes("oklch") && v.includes("calc(")) el.style.setProperty(p, fix(v));
      }
    };
    pin(document.documentElement);
    document.querySelectorAll("[data-space-hue]").forEach(pin);
  }, TOKEN_NAMES);
}

/** Tabbable elements in DOM (= Tab) order, described briefly. */
const tabOrder = (page) =>
  page.evaluate(() => {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select, [tabindex]';
    return Array.from(document.querySelectorAll(sel))
      .filter((el) => !el.closest("[hidden]") && el.getAttribute("tabindex") !== "-1")
      .map((el) => {
        const where = el.closest("header") ? "header" : el.closest("nav") ? "nav" : el.closest("main") ? "main" : "root";
        const name = el.getAttribute("aria-label") || el.textContent.trim().slice(0, 24) || el.getAttribute("placeholder") || el.tagName;
        return `${where}:${name}${where === "root" && el.getAttribute("href") !== "#main" ? ` ${el.outerHTML.slice(0, 160)}` : ""}`;
      });
  });

const settle = async (page, h) => {
  await h.idle();
  await resolveTokens(page);
  await h.idle();
};

export default [
  {
    name: "shell-mac",
    mock: { threads: { school: thread } },
    async run(page, h) {
      await settle(page, h);
    },
  },
  {
    name: "shell-windows",
    mock: { platform: "windows", threads: { work: thread } },
    async run(page, h) {
      await page.waitForSelector("[data-window-control]", { timeout: 5000 });
      await h.click("#spaces-sidebar li:nth-child(2) button");
      await page.hover('[data-window-control][aria-label="Close"]');
      await settle(page, h);
    },
  },
  {
    name: "shell-collapsed",
    mock: { threads: { school: thread } },
    async run(page, h) {
      await h.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[hidden]", { timeout: 5000 });
      await page.mouse.move(600, 400); // leave the toggle, so no tooltip
      await settle(page, h);
    },
  },
  {
    name: "shell-focus",
    mock: { threads: { work: thread } },
    async run(page, h) {
      await addStyle(page, RING);
      await page.evaluate(() => document.querySelector("#spaces-sidebar li:first-child button")?.focus());
      await page.keyboard.press("ArrowDown");
      const label = await page.evaluate(() => document.activeElement?.textContent ?? "");
      if (!label.startsWith("Work")) throw new Error(`ArrowDown landed on "${label}", expected the Work space`);
      await tagFocus(page);
      await settle(page, h);
    },
  },
  {
    name: "shell-skip-link",
    mock: { threads: { school: thread } },
    async run(page, h) {
      const order = await tabOrder(page);
      console.log(`     tab order: ${order.join(" > ")}`);
      if (!(order[0] ?? "").includes("Skip to conversation")) throw new Error(`first Tab stop is "${order[0]}", not the skip link`);
      const zones = order.map((o) => o.split(":")[0]);
      const firsts = ["root", "header", "nav", "main"].map((z) => zones.indexOf(z));
      if (firsts.some((i, k) => i < 0 || (k > 0 && i < firsts[k - 1]))) throw new Error(`Tab order is not skip link > header > nav > main`);
      await addStyle(page, RING);
      await page.evaluate(() => document.querySelector('a[href="#main"]')?.focus());
      await tagFocus(page);
      await settle(page, h);
    },
  },
];
