// The no-key path a first-time user follows: the error says to add a key and
// send again. Saving the key must not wipe the failed message or its Send again.

const check = (ok, what, got) => {
  if (!ok) throw new Error(`check failed: ${what} (${got})`);
  console.log(`     check: ${what}`);
};

export default [
  {
    name: "key-flow-send-again-survives",
    mock: {
      settings: { backend: "phaethon", hasAnthropicKey: false, model: "claude-opus-5-5", appearance: {} },
      threads: {},
      sendError: { code: "noApiKey", message: "Add your Anthropic API key in Settings to start." },
    },
    async run(page, h) {
      await h.send("Can you help me keep a list of my pills?");
      await page.waitForSelector('[data-error-action="settings"]', { timeout: 5000 });
      await page.click('[data-error-action="settings"]');
      await page.waitForSelector('[role="dialog"] input[type="password"]', { timeout: 5000 });
      await page.type('[role="dialog"] input[type="password"]', "sk-ant-api03-test-key");
      await page.keyboard.press("Enter");
      await h.waitText("Your key works");
      // The fake backend now accepts sends.
      await page.evaluate(() => {
        window.__MOCK__.sendError = null;
        window.__MOCK__.turn = [{ kind: "text", delta: "Yes. Tell me the first one." }];
      });
      await page.keyboard.press("Escape");
      await h.idle();
      const after = await page.evaluate(() => ({
        question: document.body.innerText.includes("list of my pills"),
        retry: !!document.querySelector('[data-error-action="retry"]'),
      }));
      check(after.question && after.retry, "after saving the key, the failed message and Send again are still there", JSON.stringify(after));
      await page.click('[data-error-action="retry"]');
      await h.waitText("Tell me the first one");
      const sends = await page.evaluate(() => window.__calls.filter((c) => c[0] === "agent_send").map((c) => c[1].prompt));
      check(sends.length === 2 && sends[1].includes("list of my pills"), "Send again resends the same question", JSON.stringify(sends));
      await h.idle();
    },
  },
];
