// Regression checks for the flat shell, aligned settings, and image previews.
import { readFileSync } from "node:fs";
import { attachmentFixtures } from "./chat.mjs";

const savedImagePath = "attachments/2026-10-09/whiteboard.png";
const check = (ok, message, detail) => {
  if (!ok) throw new Error(`${message}: ${JSON.stringify(detail)}`);
  console.log(`     check: ${message}`);
};

export default [
  {
    name: "layout-saved-image",
    mock: {
      threads: { school: [
        { role: "user", text: "Keep these drawings.", attachments: [
          { name: "whiteboard.png", path: savedImagePath, mediaType: "image/png" },
          { name: "missing.png", path: "attachments/2026-10-09/missing.png", mediaType: "image/png" },
        ] },
        { role: "assistant", text: "Saved.", attachments: [] },
      ] },
      files: { [savedImagePath]: { kind: "image", mediaType: "image/png", b64: readFileSync(attachmentFixtures.image).toString("base64") } },
    },
    async run(page, h) {
      await h.waitText("Saved.");
      await page.waitForFunction(() => document.querySelector('[aria-label="Files sent"] img')?.naturalWidth === 48);
      const restored = await page.evaluate((path) => {
        const image = document.querySelector('[aria-label="Files sent"] img');
        return {
          fit: getComputedStyle(image).objectFit,
          width: image.getBoundingClientRect().width,
          scopedRead: window.__calls.some(([command, args]) => command === "file_bytes" && args.space === "school" && args.path === path),
          files: document.querySelectorAll('[aria-label="Files sent"] li').length,
          images: document.querySelectorAll('[aria-label="Files sent"] img').length,
          fallbackHeight: document.querySelectorAll('[aria-label="Files sent"] li')[1].getBoundingClientRect().height,
        };
      }, savedImagePath);
      check(restored.scopedRead && restored.fit === "contain" && restored.width >= 96, "saved attachments restore a proportional preview through the space-scoped file API", restored);
      check(restored.files === 2 && restored.images === 1 && restored.fallbackHeight <= 64, "a missing saved image retains a compact file card without a broken image or empty preview frame", restored);
    },
  },
  {
    name: "workspace-learning-shortcuts",
    mock: { threads: {} },
    async run(page, h) {
      await page.waitForSelector('[data-workspace-shortcut="study"]');
      const idle = await page.$eval("[data-composer-hint]", (hint) => hint.textContent.trim());
      check(idle === "", "routine keyboard instructions do not compete with the composer controls");
      check(await page.$eval('[data-tutor-mode="school"]', (button) => button.textContent.includes("Tutor")), "the tutoring control has a visible label");
      await page.click('[data-workspace-shortcut="study"]');
      await page.waitForFunction(() => document.querySelector('[data-space-view="study"][data-view-shown] [data-view-focus]') === document.activeElement);
      check(true, "the learning shortcut opens Study and places focus in the view");
      await h.click('[data-view-tab="chat"]');
      await page.waitForSelector('[data-space-view="chat"][data-view-shown] [data-workspace-shortcut="plan"]');
      await page.click('[data-workspace-shortcut="plan"]');
      await page.waitForFunction(() => !!document.querySelector('[data-space-view="plan"][data-view-shown] [data-plan-view]'));
      check(true, "the planning shortcut opens the existing study plan");
    },
  },
  {
    name: "layout-flat-shell",
    mock: { threads: {} },
    async run(page, h) {
      await h.idle();
      const shell = await page.evaluate(() => {
        const main = document.getElementById("main");
        const rect = main.getBoundingClientRect();
        const style = getComputedStyle(main);
        const icons = [...document.querySelectorAll("svg[data-icon]")];
        return {
          right: innerWidth - rect.right,
          bottom: innerHeight - rect.bottom,
          radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius],
          borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
          shadow: style.boxShadow,
          icons: icons.length,
          lucide: icons.every((icon) => icon.classList.contains("lucide")),
        };
      });
      check(Math.abs(shell.right) < 1 && Math.abs(shell.bottom) < 1, "the main canvas reaches the window edges", shell);
      check(shell.radii.every((v) => parseFloat(v) === 0) && shell.borders.every((v) => parseFloat(v) === 0) && shell.shadow === "none", "the main canvas has no rounded frame, border, or shadow", shell);
      check(shell.icons > 0 && shell.lucide, "application icons all use the Lucide family", shell);
    },
  },
  {
    name: "layout-settings-left",
    mock: {},
    async run(page, h) {
      await h.idle();
      await h.click('#spaces-sidebar:not([hidden]) [data-testid="open-settings"], header [data-testid="titlebar-settings"]');
      await page.waitForSelector('[role="tabpanel"][data-state="active"] [data-section-header]');
      const position = await page.evaluate(() => {
        const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
        const header = panel.querySelector("[data-section-header]");
        const dialog = panel.closest('[role="dialog"]').getBoundingClientRect();
        return {
          inset: header.getBoundingClientRect().left - panel.getBoundingClientRect().left,
          align: getComputedStyle(header).textAlign,
          marginX: Math.min(dialog.left, innerWidth - dialog.right),
          marginY: Math.min(dialog.top, innerHeight - dialog.bottom),
        };
      });
      check(position.marginX >= 12 && position.marginY >= 12, "settings stays in a bounded panel with room around it", position);
      check(position.inset >= 12 && position.inset <= 40 && position.align !== "center", "settings content begins at a consistent left inset", position);
    },
  },
  {
    name: "layout-image-preview",
    mock: { threads: {} },
    async run(page, h) {
      await page.waitForSelector('input[type="file"]');
      await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 240;
        canvas.height = 120;
        const context = canvas.getContext("2d");
        context.fillStyle = "navy";
        context.fillRect(0, 0, 240, 120);
        context.fillStyle = "gold";
        context.fillRect(12, 12, 216, 96);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const file = new File([blob], "wide-preview.png", { type: "image/png" });
        const input = document.querySelector('input[type="file"]');
        Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(() => document.querySelector('[aria-label="Attached files"] img')?.naturalWidth === 240);
      const folded = await page.$('[data-attachment-fold][aria-expanded="false"]');
      if (folded && await folded.isVisible()) await folded.click();
      const preview = await page.$eval('[aria-label="Attached files"] img', (img) => ({
        fit: getComputedStyle(img).objectFit,
        width: img.getBoundingClientRect().width,
      }));
      check(preview.fit === "contain" && preview.width >= 64, "attached images have a useful preview that preserves the whole image", preview);
      await page.click('[data-remove-attachment]');
      await page.waitForFunction(() => !document.querySelector('[aria-label="Attached files"] img'));
      check(true, "the redesigned image preview can be removed");
    },
  },
];
