import fs from "node:fs";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/**
 * Memory and mail in a conversation, against the real core, a scripted model
 * and a scripted mail app: the agent remembers something (Undo forgets it),
 * an email it was asked to send counts down on its card (Stop stops it, Edit
 * changes it, Send sends it after the undo window), and a draft never sends.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const composer = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: "Message" });

function setupMail(home: string): string {
  const vault = path.join(home, "Phaethon", "default");
  const file = path.join(home, "fake-mail.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      accounts: [{ id: "school", name: "IU", emails: ["me@iu.edu"], fullName: "Jeryn V", type: "exchange" }],
      messages: [{ account: "school", mailbox: "INBOX", id: 1, from: "Dana Reyes <dana@iu.edu>", to: ["me@iu.edu"], subject: "Vacation approved", date: "2026-10-01T15:00:00Z", body: "Enjoy." }],
    }),
  );
  fs.mkdirSync(path.join(vault, ".phaethon"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, ".phaethon", "mail.json"),
    JSON.stringify({
      connectors: { fake: true },
      known: [{ key: "fake:school", app: "fake", name: "IU", emails: ["me@iu.edu"], fullName: "Jeryn V", provider: "school", enabled: true }],
      access: { "fake:school": ["school"] },
      allowSend: true,
      sendDelaySeconds: 60,
    }),
  );
  fs.mkdirSync(path.join(vault, "memory", "people"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "memory", "people", "dana-reyes.json"),
    JSON.stringify({ id: "dana-reyes", name: "Dana Reyes", aliases: [], relation: "manager", emails: ["dana@iu.edu"], phones: [], links: [], spaces: ["*"], notes: [], interactions: [], created: 1, updated: 1, source: "user" }),
  );
  return file;
}

const sentLines = (file: string) => (fs.existsSync(`${file}.sent.jsonl`) ? fs.readFileSync(`${file}.sent.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("an email the agent was asked to send counts down; Stop, Edit and Send work, and it lands on the person's card", async ({ page }) => {
  let mailFile = "";
  core = await startCore({
    setup: (home) => {
      mailFile = setupMail(home);
    },
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: {
      claude: true,
      steps: [
        { tools: [{ name: "draft_email", id: "d1", input: { to: ["dana@iu.edu"], subject: "Out sick today", body: "Hi Dana,\n\nI'm out sick today and will catch up tomorrow.\n\nJeryn", intent: "send" } }] },
        { text: "It's on its way to Dana unless you stop it." },
      ],
    },
  });
  await core.open(page);
  await composer(page).fill("Email my boss that I'm out sick");
  await page.keyboard.press("Enter");

  const card = page.locator('[data-slot="mail-draft"]');
  await expect(card).toBeVisible();
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText(/Sending in 0:5\d|Sending in 1:00/);
  await expect(card.getByText("me@iu.edu")).toBeVisible();
  await expect(card.getByText("Dana Reyes")).toBeVisible();
  await expect(card.getByText("Out sick today", { exact: true })).toBeVisible();
  await expect(page.getByText("It's on its way to Dana unless you stop it.")).toBeVisible();

  // Stop: nothing goes out.
  await card.getByRole("button", { name: "Stop" }).click();
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText("Ready to send");
  await expect(card.locator("p", { hasText: "Stopped. Nothing was sent." })).toBeVisible();
  expect(sentLines(mailFile)).toEqual([]);

  // Edit in place: the subject saves when you leave it.
  await card.getByRole("textbox", { name: "Subject" }).fill("Out sick today (back tomorrow)");
  await card.getByRole("textbox", { name: "Message" }).click();
  await expect.poll(() => JSON.parse(fs.readFileSync(fs.readdirSync(path.join(core!.home, "Phaethon/default/spaces/school/.phaethon/outbox")).map((f) => path.join(core!.home, "Phaethon/default/spaces/school/.phaethon/outbox", f))[0]!, "utf8")).subject).toBe("Out sick today (back tomorrow)");

  // Send: a short undo window, then it is sent with the edit.
  await card.getByRole("button", { name: "Send to Dana Reyes" }).click();
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText(/Sending in 0:0\d/);
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText(/^Sent/, { timeout: 15_000 });
  const sent = sentLines(mailFile);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ to: ["dana@iu.edu"], subject: "Out sick today (back tomorrow)", sender: "Jeryn V <me@iu.edu>" });
  const dana = JSON.parse(fs.readFileSync(path.join(core.home, "Phaethon/default/memory/people/dana-reyes.json"), "utf8"));
  expect(dana.interactions.at(-1)).toMatchObject({ channel: "email", direction: "out", summary: "Sent “Out sick today (back tomorrow)”" });
});

test("a draft never sends by itself; the agent's memory shows under the reply with Undo", async ({ page }) => {
  let mailFile = "";
  const sat = new Date();
  sat.setDate(sat.getDate() + ((6 - sat.getDay() + 7) % 7 || 7));
  sat.setHours(6, 0, 0, 0);
  core = await startCore({
    setup: (home) => {
      mailFile = setupMail(home);
    },
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: {
      claude: true,
      steps: [
        {
          tools: [
            { name: "remember", id: "r1", input: { kind: "event", text: "Meeting with Dana", when: sat.toISOString(), people: ["Dana Reyes"] } },
            { name: "draft_email", id: "d2", input: { to: ["dana@iu.edu"], subject: "Saturday", body: "Hi Dana,\n\nSee you Saturday at 6.\n\nJeryn", intent: "draft" } },
          ],
        },
        { text: "Noted, and here's a draft." },
      ],
    },
  });
  await core.open(page);
  await composer(page).fill("I have a meeting with my boss at 6 am Saturday; draft a confirmation");
  await page.keyboard.press("Enter");
  const card = page.locator('[data-slot="mail-draft"]');
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText("Draft");
  await expect(card.getByRole("button", { name: "Send to Dana Reyes" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Open in Mail" })).toBeVisible();
  const memory = page.getByText("Remembered");
  await expect(memory).toBeVisible();
  await expect(page.getByText("Meeting with Dana")).toBeVisible();
  await page.getByRole("button", { name: "Undo: forget Meeting with Dana" }).click();
  await expect(page.getByText("Forgot")).toBeVisible();
  const items = JSON.parse(fs.readFileSync(path.join(core.home, "Phaethon/default/.phaethon/memories.json"), "utf8")).items;
  expect(items[0]).toMatchObject({ text: "Meeting with Dana", status: "dismissed" });
  // Open in Mail hands it to the mail app instead of sending.
  await card.getByRole("button", { name: "Open in Mail" }).click();
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText("Opened in Mail");
  await page.waitForTimeout(1500);
  expect(sentLines(mailFile)).toEqual([]);
  expect(fs.existsSync(`${mailFile}.opened.jsonl`)).toBe(true);
});

test("an email written as a block (any backend) becomes the card; a name without an address is asked for, then it sends", async ({ page }) => {
  let mailFile = "";
  const block = JSON.stringify({ to: ["Ebony Woodward", "Dana Reyes"], subject: "My addresses", body: "Hi Ebony,\n\nHere are my addresses.\n\nJeryn" });
  core = await startCore({
    setup: (home) => {
      mailFile = setupMail(home);
    },
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: { claude: true, steps: [{ text: `Here's the email:\n\n\`\`\`phaethon-email\n${block}\n\`\`\`` }] },
  });
  await core.open(page);
  await composer(page).fill("draft an email to ebony woodward with my addresses");
  await page.keyboard.press("Enter");
  const card = page.locator('[data-slot="mail-draft"]');
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText("Draft");
  await expect(card.getByText("School")).toBeVisible();
  await expect(card.getByText("Ebony Woodward")).toBeVisible();
  await expect(card.getByText("add their address")).toBeVisible();
  await card.getByRole("textbox", { name: "Add a recipient" }).fill("ebony@iu.edu");
  await page.keyboard.press("Enter");
  await expect(card.getByText("ebony@iu.edu")).toBeVisible();
  await expect(card.getByText("add their address")).toBeHidden();
  // Reloading shows the same draft, not a second one.
  await page.reload();
  await expect(page.locator('[data-slot="mail-draft"]').getByText("ebony@iu.edu")).toBeVisible();
  expect(fs.readdirSync(path.join(core.home, "Phaethon/default/spaces/school/.phaethon/outbox"))).toHaveLength(1);
  await page.locator('[data-slot="mail-draft"]').getByRole("button", { name: /^Send to/ }).click();
  await expect(page.locator('[data-slot="draft-status"]')).toHaveText(/Sent/, { timeout: 15_000 });
  expect(sentLines(mailFile)[0]).toMatchObject({ to: ["dana@iu.edu", "ebony@iu.edu"], subject: "My addresses" });
});

test("without a mail account the email still shows, with Set up mail and Copy", async ({ page }) => {
  const block = JSON.stringify({ to: ["Ebony Woodward"], subject: "My addresses", body: "Hi Ebony" });
  core = await startCore({ script: { claude: true, steps: [{ text: `\`\`\`phaethon-email\n${block}\n\`\`\`` }] } });
  await core.open(page);
  await composer(page).fill("draft an email");
  await page.keyboard.press("Enter");
  const card = page.locator('[data-slot="mail-draft"][data-status="unavailable"]');
  await expect(card.getByText("No mail account is set up for this space yet.")).toBeVisible();
  await expect(card.getByText("My addresses")).toBeVisible();
  await card.getByRole("button", { name: "Set up mail" }).click();
  await expect(page.getByText("Mail apps")).toBeVisible();
});

test("the countdown's digits are monospaced, so the line never shifts as they tick", async ({ page }) => {
  core = await startCore({
    setup: (home) => void setupMail(home),
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: { claude: true, steps: [{ tools: [{ name: "draft_email", id: "d9", input: { to: ["dana@iu.edu"], subject: "Out", body: "Out today.", intent: "send" } }] }, { text: "On its way unless you stop it." }] },
  });
  await core.open(page);
  await composer(page).fill("tell Dana I'm out");
  await page.keyboard.press("Enter");
  const status = page.locator('[data-slot="draft-status"]');
  await expect(status).toHaveText(/Sending in/);
  const digits = status.locator(".type-live");
  expect(await digits.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("JetBrains Mono");
  const seen = new Map<string, number>();
  for (let i = 0; i < 12; i++) {
    const [text, width] = await status.evaluate((el) => [el.textContent ?? "", el.getBoundingClientRect().width] as const);
    seen.set(text, width);
    await page.waitForTimeout(350);
  }
  // Several different readings, one width.
  expect(seen.size).toBeGreaterThan(2);
  expect(new Set([...seen.values()].map((w) => w.toFixed(2))).size).toBe(1);
});

test("an email can carry files from the space: each opens in the viewer before it goes, and can be taken off", async ({ page }) => {
  let mailFile = "";
  core = await startCore({
    setup: (home) => {
      mailFile = setupMail(home);
      const files = path.join(home, "Phaethon", "default", "spaces", "school", "files");
      fs.mkdirSync(files, { recursive: true });
      fs.writeFileSync(path.join(files, "essay-notes.md"), "# Essay notes\n\nThe thesis, in one line.\n");
      fs.writeFileSync(path.join(files, "draft-old.txt"), "an older draft");
    },
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json" },
    script: {
      claude: true,
      steps: [
        { tools: [{ name: "draft_email", id: "d1", input: { to: ["dana@iu.edu"], subject: "My essay notes", body: "Hi Dana,\n\nNotes attached.\n\nJeryn", attachments: ["files/essay-notes.md", "files/draft-old.txt"], intent: "draft" } }] },
        { text: "It's ready for you to send." },
      ],
    },
  });
  await core.open(page);
  await composer(page).fill("Email Dana my essay notes");
  await page.keyboard.press("Enter");

  const card = page.locator('[data-slot="mail-draft"]');
  const attached = card.getByRole("group", { name: "Attachments" });
  await expect(attached.getByRole("button", { name: /^essay-notes\.md/ })).toBeVisible();
  await expect(attached.getByRole("button", { name: /^draft-old\.txt/ })).toBeVisible();

  // The file opens in Phaethon's own viewer.
  await attached.getByRole("button", { name: /^essay-notes\.md/ }).click();
  await expect(page.getByRole("heading", { name: "Essay notes" })).toBeVisible();
  await expect(page.getByText("The thesis, in one line.")).toBeVisible();
  await page.keyboard.press("Escape");

  // Taken off the card, it's off the email.
  await attached.getByRole("button", { name: "Remove draft-old.txt" }).click();
  await expect(attached.getByRole("button", { name: /^draft-old\.txt/ })).toHaveCount(0);

  await card.getByRole("button", { name: "Send to Dana Reyes" }).click();
  await expect(card.locator('[data-slot="draft-status"]')).toHaveText(/^Sent/, { timeout: 15_000 });
  const sent = sentLines(mailFile);
  expect(sent).toHaveLength(1);
  expect(sent[0].attachments).toHaveLength(1);
  expect(sent[0].attachments[0]).toMatch(/essay-notes\.md$/);
});
