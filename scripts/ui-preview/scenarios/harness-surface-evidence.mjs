// Actual compact composer surfaces and metadata behavior, at desktop and narrow sizes.
import { check, FILES, SETTINGS } from "../audit-fixtures.mjs";

const at = Date.now() - 240000;
const shown = '[data-space-pane][data-shown]';

export default [{
  name: "harness-surface-evidence",
  sizes: [[1100, 720], [640, 480]],
  sizesRequired: true,
  mock: { settings: SETTINGS, threads: { school: [
    { role: "user", text: "Review these course notes", at, attachments: [] },
    { role: "assistant", text: "Here is the focused review.", at: at + 30000, attachments: [] },
  ] } },
  async run(page, h) {
    await h.waitText("Here is the focused review.");
    await page.waitForSelector('[data-message-time]');
    await page.mouse.move(page.viewport().width - 5, 55);
    await h.idle();
    check(await page.$eval('[data-role="user"] [data-message-meta]', (meta) => getComputedStyle(meta).opacity === "0"), "the sent timestamp and Edit stay quiet at rest");
    await page.hover('[data-role="user"]');
    await h.idle();
    const user = await page.$eval('[data-role="user"]', (message) => {
      const time = message.querySelector('[data-message-time]');
      const edit = message.querySelector('[data-edit-message]');
      return { visible: getComputedStyle(time.closest('[data-message-meta]')).opacity === "1", stamp: time.querySelector('time').title,
        gap: edit.getBoundingClientRect().left - time.getBoundingClientRect().right };
    });
    check(user.visible && user.stamp.length > 10 && user.gap >= 0 && user.gap <= 8, "hover reveals real time and Edit with compact spacing", JSON.stringify(user));
    await h.shot("user-time-hover");
    await page.hover('[data-role="assistant"]');
    await h.idle();
    check(await page.$eval('[data-role="assistant"] [data-message-time]', (time) => getComputedStyle(time.parentElement).opacity === "1"), "hover reveals the reply timestamp");
    await h.shot("reply-time-hover");

    const input = await page.$(`${shown} input[type="file"]`);
    await input.uploadFile(FILES.image, FILES.pdf, FILES.notes);
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="Attached files"] li').length === 3);
    const fold = await page.$('[data-attachment-fold][aria-expanded="false"]');
    if (fold && await fold.isVisible()) await fold.click();
    await h.shot("attachments");
    await h.click(`${shown} [aria-label="Add to message"]`);
    await page.waitForSelector('[data-add-to-space="folder"]');
    check(await page.$eval('[aria-label="Add to message"]', (button) => [button, button.querySelector('.ui-button-face')].every((part) => Number.parseFloat(getComputedStyle(part).borderRadius) >= part.getBoundingClientRect().width / 2)), "the compact Add hover outline respects Vic’s round-button contract");
    check(await page.$$eval('[role="menu"] [role="menuitem"]', (rows) => rows.length === 3 && rows.every((row) => getComputedStyle(row).alignItems === "center")), "attachment actions use three aligned compact rows");
    await h.shot("attachment-menu");
    await page.keyboard.press("Escape");
    await h.click(`${shown} [data-model-picker]`);
    await page.waitForSelector('[data-model-menu] [role="option"]');
    const models = await page.$$eval('[data-model-menu] [role="option"]', (rows) => rows.map((row) => ({ text: row.textContent, height: row.getBoundingClientRect().height })));
    check(models.length === 4 && Math.max(...models.map((row) => row.height)) - Math.min(...models.map((row) => row.height)) <= 1, "models share one consistent row height", JSON.stringify(models));
    check(models.every((row) => !/workhorse|previous generation|most capable|quickest/i.test(row.text)), "model rows contain names without marketing copy");
    await h.shot("model-menu");
  },
}];
