import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test } from "./core.ts";

/**
 * Every main screen against the real core on an education space, in light and
 * dark, desktop and phone width, with no console errors. Screenshots land in
 * test-results/tour-*.png for review.
 */
const setup = (home: string) => {
  const dir = path.join(home, "Phaethon/default/spaces/school");
  fs.mkdirSync(path.join(dir, ".phaethon"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".phaethon/space.json"), JSON.stringify({ name: "School", educationEnabled: true }, null, 2) + "\n");
  fs.mkdirSync(path.join(dir, "study/decks"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "study/decks/sets.md"),
    "---\ntitle: Sets and functions\ncourse: C241\n---\n\n## What does it mean for f to be injective?\n\nf(a) = f(b) implies a = b.\n\n## What is the power set of {1, 2}?\n\n{∅, {1}, {2}, {1, 2}}\n",
  );
};

for (const scheme of ["light", "dark"] as const) {
  test(`tour of the main screens (${scheme})`, async ({ page }) => {
    const core = await startCore({ setup });
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.emulateMedia({ colorScheme: scheme });
    try {
      await core.open(page);
      await page.screenshot({ path: `test-results/tour-${scheme}-chat.png` });
      for (const view of ["Study", "Grades", "Plan", "Courses"]) {
        await page.getByRole("link", { name: view, exact: true }).or(page.getByRole("button", { name: view, exact: true })).first().click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `test-results/tour-${scheme}-${view.toLowerCase()}.png` });
      }
      await page.keyboard.press("ControlOrMeta+,");
      for (const section of ["Assistant", "Coding agents", "Spaces", "About"]) {
        await page.getByRole("dialog").getByText(section, { exact: true }).first().click();
        await page.waitForTimeout(500);
        await page.screenshot({ path: `test-results/tour-${scheme}-settings-${section.toLowerCase().replace(/ /g, "-")}.png` });
      }
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/tour-${scheme}-phone.png` });
      expect(errors.filter((e) => !/favicon/.test(e))).toEqual([]);
    } finally {
      await core.stop();
    }
  });
}
