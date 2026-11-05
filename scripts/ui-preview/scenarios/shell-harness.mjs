// T3-shaped shell behavior: retained workspaces, independent space trees,
// native Vic search, unobtrusive message actions and genuinely round Send.
import { check, SETTINGS } from "../audit-fixtures.mjs";

const shown = '[data-space-pane][data-shown]';
const thread = [
  { role: "user", text: "Review my implementation", attachments: [] },
  { role: "assistant", text: "The implementation keeps each workspace mounted.", attachments: [] },
];
const mock = {
  settings: SETTINGS,
  threads: { school: thread, work: [{ role: "user", text: "Work conversation", attachments: [] }] },
  threadArchive: { work: [{ id: "1770000000000", updated: 1770000000000, messages: [{ role: "user", text: "Archived work thread", attachments: [] }] }] },
};

export default [
  {
    name: "shell-harness-tree-and-retained-views",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock,
    async run(page, h) {
      await h.waitText("keeps each workspace mounted");
      await page.type(`${shown} [data-composer-input]`, "Keep my draft");
      await h.click('[data-space-expand="work"]');
      await page.waitForSelector('[data-sidebar-conversations="work"] [data-sidebar-thread="1770000000000"]');
      check(await page.$$eval('[data-space-expand][aria-expanded="true"]', (items) => items.length === 2), "spaces expand independently");
      check(!(await page.$('[data-sidebar-conversations="work"] [data-view-tab="study"]')), "non-education spaces expose no learning destinations");
      await h.click('[data-space-expand="work"]');
      check(!!(await page.$('[data-sidebar-conversations="school"]')), "collapsing Work leaves School open");
      await page.evaluate(() => {
        window.__studyNode = document.querySelector('[data-space-view="study"]');
        window.__chatNode = document.querySelector('[data-space-view="chat"] [data-composer-input]');
      });
      const before = await page.evaluate(() => window.__calls.filter(([command]) => command === "study_overview").length);
      await h.click('[data-sidebar-conversations="school"] [data-view-tab="study"]');
      await page.waitForSelector('[data-space-view="study"][data-view-shown]');
      await h.click('[data-sidebar-conversations="school"] [data-view-tab="chat"]');
      check(await page.evaluate(() => window.__studyNode === document.querySelector('[data-space-view="study"]') && window.__chatNode === document.querySelector('[data-space-view="chat"] [data-composer-input]')), "switching views retains their actual DOM nodes");
      check(await page.$eval(`${shown} [data-composer-input]`, (input) => input.value === "Keep my draft"), "switching views retains the composer draft");
      check(await page.evaluate((before) => window.__calls.filter(([command]) => command === "study_overview").length === before, before), "switching views does not reload Study");
      await h.click('[data-space-expand="work"]');
      await h.click('[data-sidebar-conversations="work"] [data-sidebar-thread="1770000000000"]');
      await h.waitText("Archived work thread");
      const calls = await page.evaluate(() => window.__calls.filter(([command]) => command === "thread_open"));
      check(calls.length === 1 && calls[0][1].space === "work" && calls[0][1].id === "1770000000000", "a thread in an unvisited space opens through the guarded conversation flow");
    },
  },
  {
    name: "shell-harness-palette-density",
    sizes: [[1100, 720], [640, 480]],
    mock,
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-composer-input]`);
      await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta");
      await page.waitForSelector('[data-command-palette] dialog[open] input');
      const metrics = () => page.$eval('[data-command-palette] dialog[open]', (dialog) => {
        const list = dialog.querySelector('.ui-palette-list');
        const style = getComputedStyle(list);
        return { rows: list.querySelectorAll('[role=option]').length, height: list.getBoundingClientRect().height,
          maximum: Number.parseFloat(style.maxHeight), gutter: style.scrollbarGutter, dialog: dialog.getBoundingClientRect().height,
          input: document.activeElement === dialog.querySelector('input') };
      });
      const many = await metrics();
      check(many.rows > 5 && many.height <= many.maximum + 1 && many.gutter === "stable", "multiple results stay within the scrolling cap with stable gutter", JSON.stringify(many));
      await h.shot("many-results");
      await page.keyboard.type("new conversation");
      await page.waitForFunction(() => document.querySelectorAll('[data-command-palette] [role=option]').length === 1);
      const one = await metrics();
      check(one.height < 100 && one.dialog < many.dialog && one.input, "one result uses one compact row and retains input focus", JSON.stringify(one));
      await h.shot("one-result");
      await page.click('[data-command-palette] input', { clickCount: 3 });
      await page.keyboard.type("no command matches zxqvw");
      await page.waitForFunction(() => document.querySelectorAll('[data-command-palette] [role=option]').length === 0);
      const zero = await metrics();
      check(zero.height < 140 && zero.dialog < many.dialog && zero.input, "zero results use a concise empty state with no reserved list area", JSON.stringify(zero));
      await page.keyboard.press("Enter");
      check(!!(await page.$('[data-command-palette] dialog[open]')), "Enter without a result keeps the palette open");
      await h.shot("no-results");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-command-palette]'));
    },
  },

  {
    name: "shell-harness-controls-and-palette",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light", "dark"],
    mock,
    async run(page, h) {
      await h.waitText("keeps each workspace mounted");
      await page.mouse.move(page.viewport().width - 5, 60);
      check(await page.$eval('[data-role="assistant"] [data-reply-actions]', (actions) => Number(getComputedStyle(actions).opacity) === 0), "reply actions rest quietly until their message is hovered");
      await page.hover('[data-role="assistant"]');
      await new Promise((resolve) => setTimeout(resolve, 200));
      check(await page.$eval('[data-role="assistant"] [data-reply-actions]', (actions) => Number(getComputedStyle(actions).opacity) === 1), "hover reveals reply actions");
      await page.hover('[data-copy-reply]');
      check(await page.$eval('[data-copy-reply]', (button) => getComputedStyle(button).textDecorationLine === "none"), "shared ghost controls never gain a hover underline");
      await page.type(`${shown} [data-composer-input]`, "A new message");
      const circle = await page.$eval(`${shown} button[aria-label="Send message"]`, (button) => {
        const face = button.querySelector('.ui-button-face');
        const outer = button.getBoundingClientRect();
        const inner = face.getBoundingClientRect();
        return { round: button.classList.contains('ui-button-round'), outer: [outer.width, outer.height], inner: [inner.width, inner.height], radius: getComputedStyle(face).borderRadius };
      });
      check(circle.round && (circle.radius === "50%" || Number.parseFloat(circle.radius) >= circle.inner[0] / 2) && Math.abs(circle.outer[0] - circle.outer[1]) < 1 && Math.abs(circle.inner[0] - circle.inner[1]) < 1, "Send has matching circular rim and face", JSON.stringify(circle));
      await h.shot("chat-controls");
      await page.keyboard.down("Meta"); await page.keyboard.press("k"); await page.keyboard.up("Meta");
      await page.waitForSelector('[data-command-palette] dialog[open] .ui-palette-head input');
      await page.keyboard.type("new conversation");
      await h.shot("palette");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector('[data-command-palette]'));
      await page.waitForFunction(() => window.__calls.some(([command]) => command === "thread_new"));
      check(await page.evaluate(() => window.__calls.filter(([command]) => command === "thread_new").length === 1), "Vic's native command palette executes the existing New conversation command once");
    },
  },
];
