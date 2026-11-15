import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/**
 * The conversation against the real core and the scripted provider: a reply
 * streams in with its markdown and math, the sidebar picks up the title, a
 * write waits for approval, and a failed call shows its error in place.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const composer = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Message" });

test("a reply streams in with markdown and math, and the conversation is listed", async ({ page }) => {
  core = await startCore({
    script: { claude: true, steps: [{ text: "Use **strong induction**: assume $F(k) < 2^k$ for every $k < n$.\n\n| n | F(n) |\n|---|---|\n| 1 | 1 |" }] },
  });
  await core.open(page);
  await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
  await composer(page).fill("Prove F(n) < 2^n");
  await page.keyboard.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.locator("strong", { hasText: "strong induction" })).toBeVisible();
  await expect(reply.locator(".katex").first()).toBeVisible();
  await expect(reply.locator(".md-table-wrap table")).toBeVisible();
  await expect(page.locator('[data-role="user"]').getByText("Prove F(n) < 2^n")).toBeVisible();
  // The sidebar lists it under its space, titled by the first message.
  await expect(page.getByRole("navigation").getByRole("button", { name: "Prove F(n) < 2^n" })).toBeVisible();
  // New chat empties the view; the old one reopens from the sidebar.
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "What are we working on?" })).toBeVisible();
  await page.getByRole("navigation").getByRole("button", { name: "Prove F(n) < 2^n" }).click();
  await expect(page.locator('[data-role="assistant"]').locator("strong", { hasText: "strong induction" })).toBeVisible();
});

test("a write waits for approval and happens only once allowed", async ({ page }) => {
  core = await startCore({
    script: {
      claude: true,
      steps: [{ text: "I'll save that.", tools: [{ name: "write_file", input: { path: "notes/plan.md", contents: "# Plan\n\nDay 1: induction\n" }, id: "w1" }] }, { text: "Saved your plan." }],
    },
  });
  await core.open(page);
  await composer(page).fill("Save a plan");
  await page.keyboard.press("Enter");
  const apply = page.getByRole("button", { name: "Create file" });
  await expect(apply).toBeVisible();
  const file = path.join(core.home, "Phaethon", "default", "spaces", "school", "notes", "plan.md");
  expect(fs.existsSync(file)).toBe(false);
  await expect(page.getByText("Day 1: induction")).toBeVisible();
  await apply.click();
  await expect(page.getByText("Saved your plan.")).toBeVisible();
  await expect(page.getByText("Created")).toBeVisible();
  const spaces = path.join(core.home, "Phaethon");
  const found = fs.readdirSync(spaces, { recursive: true }).map(String).find((p) => p.endsWith(path.join("notes", "plan.md")));
  expect(found, "the approved file was written in the space").toBeTruthy();
});

test("a failed call shows a sized error with its fix, and retry answers", async ({ page }) => {
  core = await startCore({
    script: { claude: true, steps: [{ error: { kind: "rateLimit", message: "Too many requests to the model. Slow down.", retryAfter: 5 } }, { text: "Here you go." }] },
  });
  await core.open(page);
  await composer(page).fill("Hello");
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: "Rate limited" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("try again in 5s");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Here you go.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Rate limited" })).toHaveCount(0);
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.getByText("Reconnecting to Phaethon’s core…")).toHaveCount(0);
});

test("long words and long messages never widen the page", async ({ page }) => {
  const long = "a".repeat(600);
  core = await startCore({ script: { claude: true, steps: [{ text: `Here: ${long}\n\n\`\`\`\n${"x".repeat(400)}\n\`\`\`` }] } });
  await core.open(page);
  await composer(page).fill(`${long}\n`.repeat(20));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Show more" }).first()).toBeVisible();
  await expect(page.locator(".md-code")).toBeVisible();
  const overflow = await page.evaluate(() => {
    const scroller = document.querySelector('[data-role="assistant"]')!.closest(".overflow-y-auto") as HTMLElement;
    return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, timeline: scroller.scrollWidth - scroller.clientWidth };
  });
  expect(overflow).toEqual({ page: 0, timeline: 0 });
});

test("math that fails or runs long stays inside the message", async ({ page }) => {
  const reply = String.raw`Broken: $\frac{1}{$ then text.

$$\sum_{i=1}^{n} \frac{i}{2 + \left( x$$

$$\begin{align} a &= b \\ c &= d \end{align}$$

Long: $\mathrm{${"averyveryverylongword".repeat(8)}}$ done.`;
  core = await startCore({ script: { claude: true, steps: [{ text: reply }] } });
  await core.open(page);
  await composer(page).fill("show me some math");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Couldn’t draw this formula").or(page.locator(".markdown > .katex-error"))).toBeVisible();
  const m = await page.evaluate(() => {
    const md = document.querySelector('[data-role="assistant"] .markdown') as HTMLElement;
    const scroller = md.closest(".overflow-y-auto") as HTMLElement;
    const displays = [...md.querySelectorAll<HTMLElement>(".katex-display")].map((d) => d.scrollWidth - d.clientWidth);
    return { message: md.scrollWidth - md.clientWidth, timeline: scroller.scrollWidth - scroller.clientWidth, displays, wide: md.querySelectorAll(".katex-wide").length };
  });
  // The fitting display (with equation numbers) is not a scroller; the long inline formula scrolls on its own.
  expect(m).toEqual({ message: 0, timeline: 0, displays: [0], wide: 1 });
});
