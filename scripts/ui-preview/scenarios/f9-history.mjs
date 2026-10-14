// Conversation history with Claude Code answering: each turn is kept, so it is there after a
// reload, listed under Conversations, reopened from there, and found by Search conversations.
// Behaviour checks: check(...) fails the run.
//   f9-cli-history   send, reload (the conversation is still there), new conversation, reopen the
//                    old one from the menu, search finds it and opens it
//   f9-cli-replies   a kept Claude Code reply can be regenerated, and its question edited
import { SETTINGS, check, park } from "../audit-fixtures.mjs";

const COMPOSER = "[data-composer-input]";
const shown = "[data-space-pane][data-shown]";
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const chord = async (page, keys) => {
  for (const k of keys) await page.keyboard.down(k);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
};
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const texts = (page) =>
  page.evaluate(
    (S) => [...document.querySelectorAll(`${S} [data-role]`)].map((m) => `${m.dataset.role}: ${m.innerText.replace(/\s+/g, " ").trim()}`),
    shown,
  );
const idle = (page) => waitFor(page, (S) => !document.querySelector(`${S} [data-stop]`), shown);

async function send(page, text) {
  await page.waitForSelector(COMPOSER, { timeout: 5000 });
  await page.focus(COMPOSER);
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

const CLI = { settings: { ...SETTINGS, backend: "claude-cli" }, threads: {}, recordTurns: true };

export default [
  {
    name: "f9-cli-history",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { ...CLI, turn: [{ kind: "text", delta: "Test 1 for C241 is on Thursday at 10." }] },
    async run(page, h) {
      await send(page, "When is Test 1?");
      check(await waitFor(page, () => document.body.innerText.includes("Thursday at 10")), "Claude Code answers");
      await idle(page);
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "thread_load").length >= 2, { timeout: 4000 });

      // A reload (a restart of the app) shows the conversation again.
      await page.reload();
      check(await waitFor(page, () => document.body.innerText.includes("Thursday at 10"), undefined, 5000), "after a reload the reply is still there");
      const after = await texts(page);
      check(after.length === 2 && after[0].includes("When is Test 1?"), "and the question with it", JSON.stringify(after));

      // New conversation keeps it under Conversations.
      await h.click("[data-new-conversation]");
      await h.waitText("Start a conversation in School");
      await send(page, "Plan my week");
      check(await waitFor(page, () => document.body.innerText.includes("Plan my week")), "a second conversation starts");
      await idle(page);
      await h.click("[data-conversations-trigger]");
      await page.waitForSelector('[data-conversations-menu] [role="menuitemradio"]', { timeout: 5000 });
      const rows = await page.$$eval('[data-conversations-menu] [role="menuitemradio"]', (els) => els.map((e) => ({ id: e.dataset.threadId, text: e.textContent })));
      check(rows.length === 2 && rows[0].text.includes("Plan my week") && rows[1].text.includes("When is Test 1?"), "Conversations lists both, the current one first", JSON.stringify(rows));
      check(!(await page.$("[data-conversations-cli]")), "no note that Claude Code keeps its own history");
      await h.shot("menu");

      // Opening the old one from the menu, by keyboard.
      await page.keyboard.press("ArrowDown");
      await waitFor(page, (id) => document.activeElement?.getAttribute("data-thread-id") === id, rows[1].id);
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.body.innerText.includes("When is Test 1?") && !document.body.innerText.includes("Plan my week")), "the old conversation opens");
      check((await calls(page, "thread_open")).some((a) => a.id === rows[1].id), "through thread_open with its id");
      check(await waitFor(page, () => document.activeElement?.matches("[data-composer-input]")), "focus goes to the composer");

      // Search finds the other one, and opens it.
      await chord(page, ["Meta", "Shift", "f"]);
      await page.waitForSelector("[data-search-dialog]", { timeout: 3000 });
      await page.keyboard.type("plan my");
      check(await waitFor(page, () => document.querySelectorAll("[data-search-result]").length === 1), "Search conversations finds the Claude Code conversation");
      const status = await page.$eval("[data-search-status]", (e) => e.textContent);
      check(/1/.test(status), "and says how many", status);
      await h.shot("search");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.activeElement?.hasAttribute("data-found-message")), "choosing it opens the conversation at the message");
      check((await texts(page)).some((t) => t.includes("Plan my week")), "the found conversation is shown");
      await park(page);
    },
  },
  {
    name: "f9-cli-replies",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      ...CLI,
      threads: {
        school: [
          { role: "user", text: "Capital of France?", at: Date.now() - 60000 },
          { role: "assistant", text: "Paris.", at: Date.now() - 55000 },
        ],
      },
      turn: [{ kind: "text", delta: "Paris, on the Seine." }],
    },
    async run(page, h) {
      await h.waitText("Paris.");
      // A kept Claude Code reply: Regenerate and Edit are offered, as with Phaethon's own agent.
      check(await waitFor(page, () => !!document.querySelector('[data-reply-again="regenerate"]')), "Regenerate is offered on a kept Claude Code reply");
      check(!!(await page.$("[data-edit-message]")), "and Edit on its question");
      await h.click('[data-reply-again="regenerate"]');
      await h.click("[data-regenerate-replace]");
      check(await waitFor(page, () => document.body.innerText.includes("Paris, on the Seine.")), "regenerating answers again");
      const sent = (await calls(page, "agent_send")).at(-1);
      check(sent?.replaceFrom === 0 && sent.prompt === "Capital of France?", "the core is asked to replace from the question", JSON.stringify(sent));
      await idle(page);
      await h.shot("regenerated");
    },
  },
];
