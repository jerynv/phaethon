// Access requests: the agent in School asks to read part of Work (read-only).
// Covers the card, each answer (once / always / deny), the receipt it leaves in
// the reply, focus, the status region, and the cross-space activity line.
// A check that fails throws, so shoot.mjs reports the scenario FAILED.

const check = (ok, what, detail) => {
  if (!ok) throw new Error(`check failed: ${what}${detail ? ` (${detail})` : ""}`);
  console.log(`     check: ${what}`);
};
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const status = (page) => page.evaluate(() => document.querySelector('[data-testid="reply-status"]').textContent);

const prior = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  { role: "assistant", text: "**Problem set 4** is due Wednesday at 11:59 pm, and **Test 1** is Thursday in class.", attachments: [] },
];

const request = {
  waitAccess: true,
  id: "acc_1",
  space: "work",
  path: "calendar",
  reason: "To plan study evenings, I need to see which evenings you already have work meetings.",
};

/** A turn that asks for Work's calendar, then (after the answer) reads it and replies. */
const turn = (hold = false) => [
  { kind: "text", delta: "I'll check your work calendar so the plan doesn't clash with your shifts." },
  { kind: "tool", label: "Waiting for you to answer: Asking for read access to work/calendar" },
  request,
  ...(hold
    ? []
    : [
        { kind: "tool", label: "Reading work/calendar/oct.md", delay: 120 },
        { kind: "text", delta: "\n\nYou have work on Tuesday evening, so I moved problem set 4 to Monday.", delay: 900 },
      ]),
];

const ask = async (page, h) => {
  await h.send("Plan my study evenings around work.");
  await page.waitForSelector("[data-access-request]", { timeout: 5000 });
  await h.idle();
};

/** Click an action in the card by its visible label. */
const choose = async (page, label) => {
  const btn = await page.evaluateHandle(
    (label) => [...document.querySelectorAll("[data-access-request] button")].find((b) => b.textContent.trim() === label),
    label,
  );
  check(!!(await btn.evaluate((b) => !!b)), `the card has a "${label}" button`);
  await btn.click();
  await page.waitForFunction(() => !document.querySelector("[data-access-request]"), { timeout: 5000 });
};

const answered = async (page, h, label, answer, receipt) => {
  await ask(page, h);
  await choose(page, label);
  const answers = await calls(page, "agent_access_answer");
  check(
    answers.length === 1 && answers[0].answer === answer && answers[0].id === "acc_1" && answers[0].space === "school",
    `${label} calls agent_access_answer with {answer:"${answer}"}`,
    JSON.stringify(answers),
  );
  const back = await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input"));
  check(back, "focus is back in the composer after answering");
  await page.waitForSelector(`[data-access-receipt="${answer}"]`, { timeout: 5000 });
  // What a sighted reader sees: the line without its screen-reader-only words.
  const line = await page.evaluate(() => {
    const copy = document.querySelector("[data-access-receipt]").cloneNode(true);
    copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
    return copy.textContent;
  });
  const squash = (t) => t.replace(/\s+/g, "");
  check(squash(line) === squash(receipt), `the reply keeps a receipt "${receipt}"`, line);
  const said = await status(page);
  check(said.startsWith(receipt), "the status region confirms the answer once", said);
};

export default [
  {
    name: "access-request",
    mock: { threads: { school: prior }, holdOpen: true, turn: turn(true) },
    async run(page, h) {
      await ask(page, h);
      const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
      check(role === "alertdialog", "the access card takes focus when it appears", role);
      const modal = await page.evaluate(() => document.querySelector("[data-access-request]").getAttribute("aria-modal"));
      check(modal === "false", "the access card is aria-modal=false");
      const title = await page.evaluate(() => document.querySelector("[data-access-request] h3").textContent);
      check(title === "Phaethon wants to read from Work", "the heading names the other space in plain words", title);
      const said = await status(page);
      check(!said.includes("Waiting for you"), "the status region does not also announce the request", said);
      const activity = await page.evaluate(() => !!document.querySelector("[data-activity]"));
      check(!activity, "the waiting line is not shown under the card");
      const order = await page.evaluate(() => {
        const card = document.querySelector("[data-access-request]");
        card.focus();
        return [...card.querySelectorAll("button")].map((b) => b.textContent.trim());
      });
      check(order.join("|") === "Allow once|Always allow|Deny", "Tab order is Allow once, Always allow, Deny", order.join("|"));
      await page.keyboard.press("Tab");
      const first = await page.evaluate(() => document.activeElement?.textContent.trim());
      check(first === "Allow once", "the first Tab stop is Allow once", first);
      await page.keyboard.press("Escape");
      await h.idle();
      const still = await page.evaluate(() => !!document.querySelector("[data-access-request]"));
      const none = await calls(page, "agent_access_answer");
      check(still && none.length === 0, "Escape does not answer; the card stays");
      const note = await page.evaluate(() => document.querySelector('[data-access-request] [role="status"]').textContent);
      check(note.startsWith("Choose Allow once"), "Escape says how to choose instead", note);
      // Leave the card unfocused for the picture, with the hint visible.
      await page.evaluate(() => document.activeElement?.blur());
      await h.idle();
    },
  },
  {
    name: "access-once",
    mock: { threads: { school: prior }, turn: turn() },
    async run(page, h) {
      await answered(page, h, "Allow once", "once", "Allowed once: Work / calendar");
      await page.waitForFunction(() => document.querySelector('[data-activity-space="work"]'), { timeout: 5000 });
      check(true, 'the activity line "Reading work/calendar/oct.md" carries Work\'s hue mark');
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent === "Reading work/calendar/oct.md", { timeout: 5000 });
      check(true, "the status region announces the cross-space read");
      await h.waitText("moved problem set 4");
      await page.waitForFunction(() => document.querySelector('[data-testid="reply-status"]').textContent.startsWith("Phaethon replied"), { timeout: 5000 });
      const done = await status(page);
      check(done.includes("moved problem set 4"), "the status region announces the reply after the answer", done);
      await h.idle();
    },
  },
  {
    name: "access-always",
    mock: { threads: { school: prior }, turn: turn() },
    async run(page, h) {
      await answered(page, h, "Always allow", "always", "Always allowed: Work / calendar");
      await h.waitText("moved problem set 4");
      // The kept grant appears in the title bar without a reload.
      await page.waitForFunction(() => document.querySelector("header")?.innerText.includes("Also reads"), { timeout: 4000 });
      console.log("     check: title bar shows the new grant right after Always allow");
      await h.idle();
    },
  },
  {
    name: "access-deny",
    mock: {
      threads: { school: prior },
      turn: [
        ...turn(true),
        { kind: "text", delta: "\n\nNo problem. Tell me which evenings you work and I'll plan around them.", delay: 120 },
      ],
    },
    async run(page, h) {
      await answered(page, h, "Deny", "deny", "Not allowed: Work / calendar");
      await h.waitText("Tell me which evenings");
      const read = await calls(page, "agent_access_answer");
      check(read.length === 1, "only one answer was sent");
      await h.idle();
    },
  },
  {
    name: "access-file-narrow",
    mock: {
      threads: { school: prior },
      holdOpen: true,
      turn: [
        { kind: "tool", label: "Waiting for you to answer: Asking for read access to work/calendar/2026-10-october-shifts-and-meetings.md" },
        {
          ...request,
          path: "calendar/2026-10-october-shifts-and-meetings.md",
          reason: "Your shifts this month decide which evenings are free.",
        },
      ],
    },
    async run(page, h) {
      await ask(page, h);
      const icon = await page.evaluate(() => document.querySelector("[data-access-request] h3").textContent);
      check(icon.includes("Work"), "a file request also names the space");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      check(!overflow, "a long path wraps without horizontal scroll");
      await h.idle();
    },
  },
];
