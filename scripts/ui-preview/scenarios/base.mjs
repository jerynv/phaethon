// Core scenarios. Each: { name, mock (window.__MOCK__ fields), run(page, helpers) }.
// Add your own in another file in this folder; shoot.mjs loads them all.

const conversation = [
  { role: "user", text: "What do I have due this week for C241?", attachments: [] },
  {
    role: "assistant",
    text: "Two things, both in `syllabus.md`:\n\n1. **Problem set 4** is due Wednesday at 11:59 pm.\n2. **Test 1** is Thursday in class. It covers chapters 1 to 4.\n\nYou also wrote in `notes/week6.md` that you wanted to redo the recursion exercises before the test. Want me to make a study plan?",
    attachments: [],
  },
  { role: "user", text: "Yes, plan Monday to Wednesday evenings.", attachments: [{ name: "calendar.png", path: "attachments/2026-10-09/calendar.png", mediaType: "image/png" }] },
  {
    role: "assistant",
    text: "Here is a plan that fits around what is on your calendar:\n\n| Evening | Focus | Time |\n| --- | --- | --- |\n| Monday | Recursion exercises 3.1 to 3.6 | 90 min |\n| Tuesday | Problem set 4 | 2 h |\n| Wednesday | Review chapters 1 to 4, then sleep | 60 min |\n\n```python\ndef fact(n):\n    return 1 if n == 0 else n * fact(n - 1)\n```",
    attachments: [],
  },
];

export default [
  {
    name: "conversation",
    mock: { threads: { school: conversation } },
    async run(page, h) {
      await h.waitText("Wednesday | Review", { soft: true });
      await h.waitText("Here is a plan");
    },
  },
  {
    name: "empty",
    mock: { threads: {} },
    async run(page, h) {
      await h.idle();
    },
  },
  {
    name: "approval",
    mock: {
      threads: { school: conversation.slice(0, 2) },
      holdOpen: true,
      turn: [
        { kind: "text", delta: "I'll put the plan in a file so you can tick things off." },
        { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
        { waitApproval: true, id: "toolu_1", summary: "Create a new file plans/week6.md (7 lines).", detail: "# Week 6\n\n- [ ] Mon: recursion 3.1 to 3.6 (90 min)\n- [ ] Tue: problem set 4 (2 h)\n- [ ] Wed: review ch. 1 to 4 (60 min)\n" },
      ],
    },
    async run(page, h) {
      await h.send("Yes, make the plan.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await h.idle();
    },
  },
  {
    name: "streaming",
    mock: {
      threads: { school: conversation.slice(0, 2) },
      holdOpen: true,
      turn: [
        { kind: "tool", label: "Reading file notes/week6.md" },
        { kind: "text", delta: "Looking at your notes, the recursion exercises" },
      ],
    },
    async run(page, h) {
      await h.send("What did I say about recursion?");
      await h.waitText("recursion exercises");
      await h.idle();
    },
  },
  {
    name: "error",
    mock: { threads: {}, sendError: { code: "noApiKey", message: "Add your Anthropic API key in Settings to start." } },
    async run(page, h) {
      await h.send("hello");
      await h.waitText("Add your Anthropic API key");
      await h.idle();
    },
  },
  {
    name: "settings",
    mock: { threads: { school: conversation.slice(0, 2) } },
    async run(page, h) {
      await h.click('[data-testid="open-settings"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
      await h.idle();
    },
  },
];
