import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "../../e2e/core";

/**
 * The site's product screenshots: the real app (built UI, real core, the
 * scripted provider) in light and dark at 2x, written to site/public/shots as
 * WebP. Run `pnpm build` first, then `pnpm site:shots` (needs `cwebp`).
 */

const out = path.resolve(import.meta.dirname, "../public/shots");

const reply = [
  "Ordinary induction only lets you lean on the step right before: to prove $P(n)$ you get $P(n-1)$ and nothing else. This bound needs **two** earlier steps, because",
  "$$F(n) = F(n-1) + F(n-2).$$",
  "Strong induction hands you every earlier case at once. Assume $F(k) < 2^k$ for all $k < n$. Then",
  "$$F(n) < 2^{n-1} + 2^{n-2} = \\tfrac{3}{4}\\cdot 2^n < 2^n.$$",
  "That's also why you need **two base cases**, $n = 1$ and $n = 2$: the step reaches back two places, so it has to land on solid ground twice.",
  "Try it yourself: would one base case be enough if the recurrence were $F(n) = 2F(n-1)$?",
].join("\n\n");

const earlier = [
  ["Plan my week around C241 Test 1", "Here's a plan that front-loads the proofs you marked as shaky."],
  ["Draft a reply to Dana about the slides", "Here's a short, friendly draft you can edit."],
  ["Summarize this week's M301 notes", "Three ideas carried the week: span, independence and bases."],
];

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

for (const theme of ["light", "dark"] as const) {
  test(`chat (${theme})`, async ({ browser }) => {
    core = await startCore({ script: { claude: true, steps: [...earlier.map(([, text]) => ({ text })), { text: reply }] } });
    const context = await browser.newContext({ viewport: { width: 1320, height: 740 }, deviceScaleFactor: 2, colorScheme: theme });
    const page = await context.newPage();
    await core.open(page);
    const composer = page.getByRole("textbox", { name: "Message" });
    for (const [ask, answer] of earlier) {
      await composer.fill(ask!);
      await page.keyboard.press("Enter");
      await expect(page.getByText(answer!)).toBeVisible();
      await page.getByRole("button", { name: "New chat", exact: true }).first().click();
    }
    await composer.fill("Why does strong induction work here when ordinary induction gets stuck?");
    await page.keyboard.press("Enter");
    await expect(page.getByText("Try it yourself")).toBeVisible();
    await page.mouse.move(0, 0);
    await page.locator("textarea, [contenteditable]").first().blur();
    // The throwaway core has no provider key, so the composer asks for one; someone set up never sees that line or the picker's dot.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>("p.text-warning-foreground, span.bg-warning[aria-label]")) el.style.visibility = "hidden";
    });
    await page.waitForTimeout(600);
    const png = path.join(out, `chat-${theme}.png`);
    await page.screenshot({ path: png });
    const webp = spawnSync("cwebp", ["-quiet", "-q", "86", "-m", "6", png, "-o", png.replace(/\.png$/, ".webp")]);
    expect(webp.status, String(webp.stderr)).toBe(0);
    fs.rmSync(png);
    await context.close();
  });
}
