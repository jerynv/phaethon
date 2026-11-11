import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, startCore, test, type Core } from "./core";

/** The model belongs to the conversation: picked in the composer, kept with it, and the next new one starts with the last pick. */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

async function pick(page: Page, name: string) {
  await page.getByTestId("model-picker").click();
  await page.getByRole("listbox", { name: "Models" }).getByRole("option", { name }).click();
  await expect(page.getByTestId("model-picker")).toContainText(name);
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
}

test("each conversation keeps its own model and effort", async ({ page }) => {
  core = await startCore({ script: { claude: true, repeatLast: true, steps: [{ text: "Okay." }] } });
  await core.open(page);
  const state = path.join(core.home, "Phaethon", "default", "spaces", "school", ".phaethon");

  await pick(page, "Claude Haiku 5.5");
  await page.getByRole("button", { name: /^Reasoning:/ }).click();
  await page.getByRole("button", { name: "Low" }).click();
  await send(page, "first conversation");
  expect(JSON.parse(fs.readFileSync(path.join(state, "model"), "utf8"))).toEqual({ backend: "phaethon", model: "claude-haiku-5-5", effort: "low" });
  expect(core.requests().at(-1)?.effort).toBe("low");

  // A new conversation starts with the last pick; changing it there doesn't touch the first one.
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByTestId("model-picker")).toContainText("Claude Haiku 5.5");
  await pick(page, "Claude Opus 5.5");
  await send(page, "second conversation");

  await page.getByRole("navigation").getByRole("button", { name: "first conversation" }).click();
  await expect(page.locator('[data-role="user"]').getByText("first conversation")).toBeVisible();
  await expect(page.getByTestId("model-picker")).toContainText("Claude Haiku 5.5");
  await page.getByRole("navigation").getByRole("button", { name: "second conversation" }).click();
  await expect(page.getByTestId("model-picker")).toContainText("Claude Opus 5.5");

  // The archived first conversation carries its choice beside it.
  const archived = fs.readdirSync(path.join(state, "threads")).filter((f) => f.endsWith(".model"));
  expect(archived).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(state, "threads", archived[0]!), "utf8")).model).toBe("claude-haiku-5-5");
});

test("coding agents are in the same picker and say what they need", async ({ page }) => {
  core = await startCore();
  await core.open(page);
  await page.getByTestId("model-picker").click();
  const rail = page.getByRole("tablist", { name: "Providers" });
  await expect(rail.getByRole("tab", { name: /Claude Code · Not installed/ })).toBeVisible();
  await expect(rail.getByRole("tab", { name: /Codex · Not installed/ })).toBeVisible();
  await rail.getByRole("tab", { name: /Codex/ }).click();
  await expect(page.getByRole("button", { name: "Not installed · Set up" })).toBeVisible();
});
