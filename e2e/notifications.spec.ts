import fs from "node:fs";
import path from "node:path";
import { expect, openSettings, startCore, test, type Core } from "./core";
import { seedLife } from "./fixtures/life";

/**
 * Notifications against the real core (standalone, so they land in
 * $PHAETHON_NOTIFY_LOG instead of the system): Settings › Notifications saves,
 * the test button, and real triggers (a reminder shortly before an event, a
 * sent email). The desktop shell's side (tray, system banners) is tested in
 * tests/tray.test.ts and on the packaged app.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const logged = (home: string) => {
  const f = path.join(home, "notify.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("Settings › Notifications saves what you choose, and the test button sends one", async ({ page }) => {
  core = await startCore({ env: { PHAETHON_NOTIFY_LOG: "__HOME__/notify.jsonl" } });
  await core.open(page);
  await openSettings(page, "Notifications");
  await page.getByRole("switch", { name: "Mail" }).click();
  await page.getByRole("switch", { name: "Quiet hours" }).click();
  await page.getByRole("switch", { name: "Open at login" }).click();
  const settings = path.join(core.home, "Phaethon/default/.phaethon/settings.json");
  await expect.poll(() => JSON.parse(fs.readFileSync(settings, "utf8"))).toMatchObject({
    notifications: { kinds: { mail: false }, quiet: { from: "22:00", to: "07:00" } },
    background: { openAtLogin: true, keepRunning: true },
  });
  await page.getByRole("button", { name: "Send a test" }).click();
  await expect(page.getByText("Notifications appear in the desktop app")).toBeVisible();
  await expect.poll(() => logged(core!.home).map((n) => n.title)).toContain("Notifications are on");
  await page.getByRole("button", { name: "Pause for 1 hour" }).click();
  await expect(page.getByText(/^Paused until/)).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(page.getByText("Running on their schedules.")).toBeVisible();
});

test("a reminder comes shortly before an event, and a sent email says so", async ({ page }) => {
  core = await startCore({
    setup: (home) => {
      seedLife(home);
      const f = path.join(home, "Phaethon/default/.phaethon/memories.json");
      const doc = JSON.parse(fs.readFileSync(f, "utf8"));
      doc.items.push({ id: "m_soon", kind: "event", text: "Call with Ebony", space: "work", scope: "space", created: 1, updated: 1, when: Date.now() + 8 * 60_000, status: "active", keywords: [], people: [], origin: "agent" });
      fs.writeFileSync(f, JSON.stringify(doc));
    },
    env: { PHAETHON_FAKE_MAIL: "__HOME__/fake-mail.json", PHAETHON_NOTIFY_LOG: "__HOME__/notify.jsonl" },
    script: { claude: true, steps: [{ tools: [{ name: "draft_email", id: "d1", input: { to: ["dana@acme.com"], subject: "Running late", body: "Hi Dana", intent: "draft" } }] }, { text: "Ready." }] },
  });
  await core.open(page);
  // The reminders job, run now (it runs every minute on its own in the app).
  await openSettings(page, "Automations");
  await page.locator("li, div").filter({ hasText: /^Reminders/ }).getByRole("button", { name: "Run now" }).first().click();
  await expect.poll(() => logged(core!.home).map((n) => n.title)).toContain("In 8 min: Call with Ebony");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /^Space: / }).click();
  await page.getByRole("menuitem", { name: /^Work/ }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("tell Dana I'm late");
  await page.keyboard.press("Enter");
  await page.locator('[data-slot="mail-draft"]').getByRole("button", { name: /^Send to/ }).click();
  await expect(page.locator('[data-slot="draft-status"]')).toHaveText(/^Sent/, { timeout: 15_000 });
  await expect.poll(() => logged(core!.home).find((n) => n.kind === "mail")).toMatchObject({ title: "Sent: Running late", whenAway: true, target: { kind: "thread", space: "work" } });
});
