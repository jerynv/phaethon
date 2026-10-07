// The first-run SetupCard on its test page (../main.tsx). Run with
//   pnpm exec vite build --config scripts/ui-preview/setup-card/vite.config.mjs --outDir <out>
//   node scripts/ui-preview/shoot.mjs --dist <out> --scenarios scripts/ui-preview/setup-card/scenarios ...
// Behaviour checks: what the card says, what each key result does, and the
// Claude Code way in.

const check = (ok, what, got) => {
  if (!ok) throw new Error(`check failed: ${what} (${got})`);
  console.log(`     check: ${what}`);
};
const CARD = "[data-setup-card]";
const NO_KEY = { backend: "phaethon", hasAnthropicKey: false, model: "claude-opus-5-5", appearance: {} };
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const listen = (page) =>
  page.evaluate(() => {
    window.__changed = [];
    window.addEventListener("phaethon:settings-changed", (e) => window.__changed.push(e.detail.what));
  });

async function submitKey(page, key) {
  await page.focus("[data-setup-key]");
  await page.keyboard.type(key);
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-key-outcome]", { timeout: 5000 });
  await new Promise((r) => setTimeout(r, 300));
  return page.evaluate(() => {
    const input = document.querySelector("[data-setup-key]");
    const line = document.querySelector("[data-key-outcome]");
    return {
      outcome: line?.getAttribute("data-key-outcome"),
      text: line?.textContent ?? "",
      said: document.querySelector(`[data-setup-card] [role="status"]`)?.textContent ?? "",
      invalid: input?.getAttribute("aria-invalid") ?? null,
      focus: document.activeElement?.hasAttribute("data-setup-key") ? "key" : document.activeElement?.hasAttribute("data-composer-input") ? "composer" : document.activeElement?.tagName,
    };
  });
}

const bad = (name, keyCheck, key, says) => ({
  name: `t2-setup-card-${name}`,
  sizes: [[1100, 720]],
  mock: { settings: NO_KEY, keyCheck },
  async run(page, h) {
    await page.waitForSelector(CARD);
    const got = await submitKey(page, key);
    console.log(`     ${name}: ${JSON.stringify(got)}`);
    check(got.text.includes(says) && got.said.includes(says), `says "${says}" at the field and aloud`, got.text);
    check(got.invalid === "true" && got.focus === "key", "the field is marked invalid and keeps focus", JSON.stringify(got));
    check((await calls(page, "api_key_set")).length === 0, "nothing is saved");
    if (name === "network") {
      await page.$$eval(`${CARD} button`, (bs) => bs.find((b) => b.textContent.trim() === "Save without checking")?.click());
      await new Promise((r) => setTimeout(r, 400));
      check((await calls(page, "api_key_set")).length === 1, "Save without checking saves it");
    }
  },
});

export default [
  {
    name: "t2-setup-card",
    mock: { settings: NO_KEY },
    async run(page, h) {
      await page.waitForSelector(CARD);
      const c = await page.evaluate((sel) => {
        const card = document.querySelector(sel);
        return {
          name: document.getElementById(card.getAttribute("aria-labelledby"))?.textContent,
          text: card.innerText,
          link: card.querySelector('a[href="https://console.anthropic.com/settings/keys"]')?.textContent,
          label: document.querySelector("[data-setup-key]").labels?.[0]?.textContent,
          cli: !!card.querySelector("[data-setup-cli]"),
        };
      }, CARD);
      check(c.name === "Set up Phaethon to answer in School", "the card is a region named by its heading", c.name);
      for (const want of ["API key", "separate account", "ChatGPT or Claude.ai subscription", "few dollars a month", "spending limit", "never syncs", "Get a key", "Paste it here"]) {
        check(c.text.includes(want), `it says: ${want}`);
      }
      check(c.link?.startsWith("console.anthropic.com"), "it links straight to the API keys page", c.link);
      check(c.label === "Your Anthropic API key", "the field has a visible label", c.label);
      check(c.cli, "Use Claude Code instead is offered");
      await page.focus("[data-setup-key]");
      await h.shot("field-focused");
    },
  },
  bad("format", null, "Linda1959!", "doesn’t look like an Anthropic API key"),
  bad("rejected", { ok: false, problem: "rejected", message: "invalid x-api-key" }, "sk-ant-api03-deleted-xxxxxxxxxxxx", "Anthropic didn’t accept this key"),
  bad("network", { ok: false, problem: "network", message: "offline" }, "sk-ant-api03-offline-xxxxxxxxxxxx", "couldn’t reach Anthropic"),
  {
    name: "t2-setup-card-billing",
    sizes: [[1100, 720]],
    mock: { settings: NO_KEY, keyCheck: { ok: false, problem: "billing", message: "credit balance too low" } },
    async run(page, h) {
      await page.waitForSelector(CARD);
      await listen(page);
      await page.focus("[data-setup-key]");
      await page.keyboard.type("sk-ant-api03-no-credit-xxxxxxxxx");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-setup-credit]", { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      const got = await page.evaluate(() => ({
        heading: document.querySelector("[data-setup-card] h2")?.textContent,
        text: document.querySelector("[data-setup-credit]").innerText,
        link: document.querySelector('[data-setup-credit] a[href="https://console.anthropic.com/settings/billing"]')?.textContent,
        said: document.querySelector('[data-setup-card] [role="status"]')?.textContent,
        focus: document.activeElement?.tagName,
      }));
      console.log(`     billing: ${JSON.stringify(got)}`);
      check(got.heading === "One more step: add credit" && got.text.includes("no credit yet") && !!got.link, "a key with no credit: the card says only to add credit, with the Billing link", JSON.stringify(got));
      check(got.said.includes("no credit yet") && got.focus === "H2", "it is said aloud and focus is on the card's heading", JSON.stringify(got));
      check((await calls(page, "api_key_set")).length === 1, "the key is saved (no need to paste it again after adding credit)");
      check((await page.evaluate(() => window.__changed)).join() === "key", "the settings-changed event says the key changed");
    },
  },
  {
    name: "t2-setup-card-ok",
    mock: { settings: NO_KEY },
    async run(page, h) {
      await page.waitForSelector(CARD);
      await listen(page);
      await page.focus("[data-setup-key]");
      await page.keyboard.type("sk-ant-api03-works-xxxxxxxxxxxxxx");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-setup-done]", { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      const got = await page.evaluate(() => ({
        heading: document.querySelector("[data-setup-card] h2")?.textContent,
        done: document.querySelector("[data-setup-done]")?.textContent,
        said: document.querySelector('[data-setup-card] [role="status"]')?.textContent,
        focus: document.activeElement?.hasAttribute("data-composer-input"),
        changed: window.__changed,
      }));
      const order = (await page.evaluate(() => window.__calls.map(([c]) => c))).filter((c) => c.startsWith("api_key"));
      console.log(`     ok: ${JSON.stringify({ ...got, order })}`);
      check(order.join() === "api_key_check,api_key_set", "checked, then saved", order.join());
      check(got.heading === "You’re set up" && got.done.includes("Type your first message"), "the card says what to do next", JSON.stringify(got));
      check(got.said.includes("Your key works"), "and says it aloud", got.said);
      check(got.focus, "focus moves to the message box");
      check(got.changed.join() === "key", "the settings-changed event fired for the key", got.changed.join());
    },
  },
  {
    name: "t2-setup-card-cli",
    sizes: [[1100, 720]],
    mock: { settings: NO_KEY },
    async run(page, h) {
      await page.waitForSelector(CARD);
      await listen(page);
      await page.click("[data-setup-cli]");
      await page.waitForSelector("[data-setup-done]", { timeout: 5000 });
      await new Promise((r) => setTimeout(r, 300));
      const sets = await calls(page, "settings_set_backend");
      const got = await page.evaluate(() => ({
        done: document.querySelector("[data-setup-done]")?.textContent,
        focus: document.activeElement?.hasAttribute("data-composer-input"),
        changed: window.__changed,
      }));
      check(sets.length === 1 && sets[0].backend === "claude-cli", "Use Claude Code instead switches the backend", JSON.stringify(sets));
      check(got.done.includes("Claude Code") && got.focus, "the card says so and focus moves to the message box", JSON.stringify(got));
      check(got.changed.join() === "backend", "the settings-changed event fired for the backend", got.changed.join());
      check((await calls(page, "api_key_set")).length === 0, "no key is saved");
    },
  },
];
