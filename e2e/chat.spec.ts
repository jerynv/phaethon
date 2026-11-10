import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test } from "./core.ts";

test("a reply streams in, renders math, and is still there after a reload", async ({ page }) => {
  const core = await startCore({
    script: {
      model: "fake-model",
      steps: [{ text: "Strong induction assumes **every** earlier case.\n\n$$a_n \\le 2^n$$\n\nThat is why it fits recurrences." }],
    },
  });
  try {
    await core.open(page);
    const box = page.getByRole("textbox", { name: /message/i });
    await box.fill("Why does strong induction fit recurrences?");
    await box.press("Enter");
    await expect(page.getByLabel("Phaethon replied").getByText("That is why it fits recurrences.")).toBeVisible();
    await expect(page.locator(".katex").first()).toBeVisible();
    await page.screenshot({ path: "test-results/chat-reply.png" });
    await page.reload();
    await expect(page.getByLabel("Phaethon replied").getByText("That is why it fits recurrences.")).toBeVisible();
    await expect(page.getByRole("main").getByText("Why does strong induction fit recurrences?").last()).toBeVisible();
    const req = core.requests()[0] as { system?: string };
    expect(String(req?.system ?? JSON.stringify(req))).toContain("Explaining something");
  } finally {
    await core.stop();
  }
});

test("a write waits for approval and lands in the space only when allowed", async ({ page }) => {
  const core = await startCore({
    script: {
      steps: [
        { text: "I'll save that summary.", tools: [{ name: "write_file", input: { path: "notes/summary.md", contents: "# Summary\n" } }] },
        { text: "Saved notes/summary.md." },
      ],
    },
  });
  try {
    await core.open(page);
    const box = page.getByRole("textbox", { name: /message/i });
    await box.fill("Save a summary of week 6.");
    await box.press("Enter");
    const allow = page.getByRole("button", { name: /^allow/i });
    await expect(allow).toBeVisible();
    const file = path.join(core.home, "Phaethon/default/spaces/school/notes/summary.md");
    expect(fs.existsSync(file)).toBe(false);
    await page.screenshot({ path: "test-results/chat-approval.png" });
    await allow.click();
    await expect(page.getByLabel("Phaethon replied").getByText("Saved notes/summary.md.")).toBeVisible();
    expect(fs.readFileSync(file, "utf8")).toBe("# Summary\n");
  } finally {
    await core.stop();
  }
});
