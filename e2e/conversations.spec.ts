import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, startCore, test, type Core } from "./core";

/**
 * Several conversations at once, against the real core and the scripted
 * model: two replies stream side by side in one space, switching between
 * them (and to another page) clears nothing, each ends with its own state in
 * the sidebar, and a write can be allowed for the rest of a conversation.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const nav = (page: Page) => page.getByRole("navigation", { name: "Spaces and conversations" });
const threadsDir = (c: Core) => path.join(c.home, "Phaethon", "default", "spaces", "school", ".phaethon", "threads");
const savedConversations = (c: Core) => (fs.existsSync(threadsDir(c)) ? fs.readdirSync(threadsDir(c)).filter((f) => f.endsWith(".json")) : []);

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

const words = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");

test("two conversations in one space reply at once, and switching clears nothing", async ({ page }) => {
  const first = words("alpha", 40);
  const second = words("beta", 40);
  core = await startCore({
    script: {
      claude: true,
      steps: [
        { text: first, wordDelayMs: 70 },
        { text: second, wordDelayMs: 70 },
      ],
    },
    // School with its study tools on, so there is another page (Grades) to go to and come back from.
    setup: (home) => {
      const state = path.join(home, "Phaethon", "default", "spaces", "school", ".phaethon");
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(path.join(state, "space.json"), JSON.stringify({ name: "School", educationEnabled: true }));
    },
  });
  await core.open(page);
  const sidebar = nav(page);

  await send(page, "first question");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("alpha3");
  await expect(sidebar.getByRole("button", { name: "first question, replying" })).toBeVisible();

  // A second conversation in the same space, while the first is still replying.
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Where should we begin?" })).toBeVisible();
  await send(page, "second question");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("beta3");
  await expect(sidebar.getByRole("button", { name: "second question, replying" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "first question, replying" })).toBeVisible();
  // The composer kept focus through the new chat becoming a conversation.
  await expect(composer(page)).toBeFocused();

  // Back to the first: it is all there, still streaming, under its own title, with no skeleton.
  await sidebar.getByRole("button", { name: /^first question/ }).click();
  await expect(page.locator("[data-slot=app-header]")).toContainText("first question");
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]')).toContainText("first question");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("alpha3");

  // To another page and back: still there.
  await page.getByRole("list", { name: "Views" }).getByRole("button", { name: /^Grades/ }).click();
  await page.getByRole("tablist", { name: "Open pages" }).getByRole("tab", { name: /^first question/ }).click();
  await expect(page.locator("[data-slot=app-header]")).not.toContainText("New chat");
  await expect(page.locator('[data-role="user"]')).toHaveCount(1);
  await expect(page.locator('[data-role="user"]')).toContainText("first question");

  // Both finish. The one on screen is simply done; the other one has a new reply.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("alpha39", { timeout: 15_000 });
  await expect(sidebar.getByRole("button", { name: "second question, new reply" })).toBeVisible({ timeout: 15_000 });
  await expect(sidebar.getByRole("button", { name: /^first question/ })).toHaveAccessibleName("first question");
  await sidebar.getByRole("button", { name: /^second question/ }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("beta39");
  await expect(sidebar.getByRole("button", { name: /^second question/ })).toHaveAccessibleName("second question");

  // Each reply went to its own conversation, and the model was asked once for each.
  expect(savedConversations(core)).toHaveLength(2);
  expect(core.requests()).toHaveLength(2);
  const byQuestion = Object.fromEntries(
    savedConversations(core).map((f) => {
      const saved = JSON.parse(fs.readFileSync(path.join(threadsDir(core!), f), "utf8")) as { content: { text?: string }[] }[];
      return [saved[0]!.content[0]!.text, saved[1]!.content[0]!.text];
    }),
  );
  expect(byQuestion).toEqual({ "first question": first, "second question": second });
});

test("stopping one conversation leaves the other replying", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: words("one", 60), wordDelayMs: 60 }, { text: words("two", 30), wordDelayMs: 40 }] } });
  await core.open(page);
  const sidebar = nav(page);
  await send(page, "keep going");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("one2");
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await send(page, "stop me");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("two2");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByText("Stopped")).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "keep going, replying" })).toBeVisible();
  await sidebar.getByRole("button", { name: /^keep going/ }).click();
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("one59", { timeout: 15_000 });
  await expect(page.getByText("Stopped")).toHaveCount(0);
});

test("New chat leaves nothing behind until something is sent", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: "Hi." }] } });
  await core.open(page);
  // The sidebar's New chat (the title bar's + after the tabs does the same, unpressed).
  const newChat = nav(page).getByRole("button", { name: "New chat", exact: true }).first();
  for (let i = 0; i < 3; i++) await newChat.click();
  await expect(page.getByRole("heading", { name: "Where should we begin?" })).toBeVisible();
  // No draft row under the space: the New chat button itself is pressed, and no conversation is saved.
  await expect(nav(page).getByRole("list", { name: "School conversations" }).getByRole("button", { name: "New chat", exact: true })).toHaveCount(0);
  await expect(newChat).toHaveAttribute("aria-pressed", "true");
  expect(savedConversations(core)).toEqual([]);
  await send(page, "now it counts");
  await expect(page.getByText("Hi.")).toBeVisible();
  await expect.poll(() => savedConversations(core!).length).toBe(1);
});

test("a write waits with the conversation marked, and “allow in this chat” stops the asking", async ({ page }) => {
  const write = (file: string, id: string) => ({ text: `Saving ${file}.`, tools: [{ name: "write_file", input: { path: file, contents: `# ${file}\n` }, id }] });
  core = await startCore({ script: { claude: true, steps: [write("a.md", "w1"), { text: "Saved a." }, write("b.md", "w2"), { text: "Saved b." }] } });
  await core.open(page);
  const school = path.join(core.home, "Phaethon", "default", "spaces", "school");
  await send(page, "save a");
  await expect(page.getByRole("button", { name: /Create file/ })).toBeVisible();
  await expect(nav(page).getByRole("button", { name: "save a, needs your answer" })).toBeVisible();
  expect(fs.existsSync(path.join(school, "a.md"))).toBe(false);

  // Answered from the keyboard once focus has left the message box.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("c");
  await expect(page.getByText("Saved a.")).toBeVisible();
  expect(fs.readFileSync(path.join(school, "a.md"), "utf8")).toBe("# a.md\n");

  // The next write in this conversation goes ahead without a card, and says why.
  await send(page, "save b");
  await expect(page.getByText("Saved b.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Create file/ })).toHaveCount(0);
  await expect(page.getByText("allowed in this chat")).toBeVisible();
  expect(fs.readFileSync(path.join(school, "b.md"), "utf8")).toBe("# b.md\n");
});

test("a conversation's menu opens on right-click", async ({ page }) => {
  core = await startCore({ script: { claude: true, steps: [{ text: "Okay." }] } });
  await core.open(page);
  await send(page, "right click me");
  await expect(page.getByText("Okay.")).toBeVisible();
  await nav(page).getByRole("button", { name: /^right click me/ }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin to top" }).click();
  await expect(nav(page).getByRole("button", { name: "right click me, pinned" })).toBeVisible();
  // F2 renames the focused conversation.
  await nav(page).getByRole("button", { name: /^right click me/ }).focus();
  await page.keyboard.press("F2");
  await nav(page).getByRole("textbox", { name: "Conversation title" }).fill("Renamed by key");
  await page.keyboard.press("Enter");
  await expect(nav(page).getByRole("button", { name: /^Renamed by key/ })).toBeVisible();
});
