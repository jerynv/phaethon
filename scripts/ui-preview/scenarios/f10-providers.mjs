// Model providers (Team Providers). Behaviour checks: check(...) fails the run.
//   f10-openrouter   Settings › Assistant: choose OpenRouter, another provider's key refused before it is sent, a key checked and
//                    saved for OpenRouter, its long model list searched by keyboard, a model chosen, and a name typed as a model
//   f10-ollama-off   Ollama chosen while it isn't running: said in plain words, no key asked, nothing leaves the computer
//   f10-ollama-on    Ollama started: Check again says it is running with its models, and one is chosen
//   f10-space        a space picks another provider's model from its menu, and any model through Another model…
//   f10-palette      ⌘K › Change model… lists provider · model and chooses one by keyboard only
//   f10-fit          at 640x480 (and with --scale 2) the provider settings and the model chooser fit
import { SETTINGS, check, openSettings, park, PANEL } from "../audit-fixtures.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const picker = `${shown} [data-model-picker]`;
const settingsSaid = (page, text, timeout = 4000) =>
  page
    .waitForFunction((t) => [...document.querySelectorAll('[role="dialog"] p[role="status"]')].some((p) => p.textContent === t), { timeout }, text)
    .then(() => true, () => false);
const settingsStatus = (page) => page.evaluate(() => [...document.querySelectorAll('[role="dialog"] p[role="status"]')].map((p) => p.textContent).join(" | "));
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
const searchStatus = (page) => page.$eval("[data-model-search-status]", (e) => e.textContent);
const activeOption = (page) =>
  page.$eval("[data-model-query]", (i) => document.getElementById(i.getAttribute("aria-activedescendant") ?? "")?.dataset.modelChoice ?? null);

// A long list, as OpenRouter's is.
const OPENROUTER = [
  { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
  { id: "openai/gpt-5", name: "OpenAI: GPT-5" },
  { id: "meta-llama/llama-4-maverick", name: "Meta: Llama 4 Maverick" },
  { id: "google/gemini-3-pro", name: "Google: Gemini 3 Pro" },
  ...Array.from({ length: 116 }, (_, i) => ({ id: `vendor${i}/model-${i}`, name: `Vendor ${i}: Model ${i}` })),
];
const OLLAMA = [
  { id: "llama3.2:3b", name: "llama3.2:3b" },
  { id: "qwen3:8b", name: "qwen3:8b" },
];
const PROV = (over = {}) => ({ provider: "anthropic", keys: {}, models: {}, urls: {}, running: {}, lists: { openrouter: OPENROUTER, ollama: OLLAMA }, ...over });

async function choose(page, value) {
  await page.select("[data-provider-select]", value);
  await page.waitForFunction((v) => window.__calls.some(([c, a]) => c === "settings_set_provider" && a.provider === v), { timeout: 3000 }, value);
}

async function palette(page, query) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("k");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
  await page.keyboard.type(query);
}

export default [
  {
    name: "f10-openrouter",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, prov: PROV() },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const label = await page.$eval("[data-provider-select]", (s) => s.labels?.[0]?.textContent);
      check(label === "Provider", "the provider select has a visible label", label);
      const groups = await page.$$eval("[data-provider-select] optgroup", (gs) => gs.map((g) => `${g.label}: ${[...g.children].map((o) => o.textContent).join(", ")}`));
      check(groups.length === 3 && /Ollama \(on this computer\)/.test(groups[1]) && /OpenRouter/.test(groups[0]), "services, on this computer, other", JSON.stringify(groups));
      await choose(page, "openrouter");
      check(await settingsSaid(page, "Phaethon now answers with OpenRouter."), "choosing OpenRouter is said", await settingsStatus(page));
      await page.waitForSelector("[data-model-search=openrouter]", { timeout: 3000 });
      const text = await page.$eval(PANEL, (e) => e.innerText);
      check(/OpenRouter API key/.test(text) && /openrouter\.ai/.test(text), "it asks for an OpenRouter key and says where to make one", text.slice(0, 600));
      check(/What is sent to OpenRouter/.test(text) && /passes it on to the company that runs the model/.test(text), "the disclosure names OpenRouter", "");

      // Another provider's key: refused before anything is sent or saved.
      await page.type("[data-key-input]", "sk-ant-api03-this-is-anthropics");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-key-outcome]", { timeout: 3000 });
      let outcome = await page.$eval("[data-key-outcome]", (e) => [e.dataset.keyOutcome, e.textContent]);
      check(outcome[0] === "format" && /a key for Anthropic, not OpenRouter/.test(outcome[1]) && /wasn’t saved/.test(outcome[1]), "an Anthropic key is refused for OpenRouter", JSON.stringify(outcome));
      check((await calls(page, "api_key_set")).length === 0, "and not saved");
      const checked = await calls(page, "api_key_check");
      check(checked.at(-1)?.provider === "openrouter", "the check is OpenRouter's", JSON.stringify(checked));
      const invalid = await page.$eval("[data-key-input]", (e) => [e.getAttribute("aria-invalid"), document.activeElement === e]);
      check(invalid[0] === "true" && invalid[1], "the field is marked and keeps focus", JSON.stringify(invalid));
      await h.shot("wrong-key");

      await page.click("[data-key-input]", { clickCount: 3 });
      await page.type("[data-key-input]", "sk-or-v1-0123456789abcdef");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "api_key_set"), { timeout: 3000 });
      const set = (await calls(page, "api_key_set")).at(-1);
      check(set.provider === "openrouter" && set.key === "sk-or-v1-0123456789abcdef", "the key is saved for OpenRouter", JSON.stringify(set));
      check(await settingsSaid(page, "Your key works. It’s saved in this computer’s password store (Keychain)."), "and that is said", await settingsStatus(page));
      await page.waitForFunction(() => /A key is saved/.test(document.querySelector("[data-key-input]")?.closest("form")?.textContent ?? ""), { timeout: 3000 });

      // The list: long, so only the first 50 show, and typing narrows it.
      await page.waitForFunction(() => /120 models/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      check(/The first 50 are shown/.test(await searchStatus(page)), "a long list says only the first 50 show", await searchStatus(page));
      check((await page.$$("[data-model-search] [role=option]")).length === 50, "and shows 50");
      const none = await page.$eval("[data-provider-model]", (e) => e.textContent);
      check(/No model is chosen for OpenRouter yet/.test(none), "no model is chosen yet, said plainly", none);
      await page.focus("[data-model-query]");
      await page.keyboard.type("sonnet");
      await page.waitForFunction(() => /1 match/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      check((await activeOption(page)) === "anthropic/claude-sonnet-5", "the match is marked", await activeOption(page));
      const combo = await page.$eval("[data-model-query]", (e) => [e.getAttribute("role"), e.getAttribute("aria-expanded"), e.labels?.[0]?.textContent]);
      check(combo.join("|") === "combobox|true|Default model", "the search is a labelled combobox", combo.join("|"));
      await park(page);
      await h.shot("search");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_provider_model"), { timeout: 3000 });
      let pm = (await calls(page, "settings_set_provider_model")).at(-1);
      check(pm.provider === "openrouter" && pm.model === "anthropic/claude-sonnet-5", "Enter chooses it as OpenRouter's model", JSON.stringify(pm));
      check(await settingsSaid(page, "The default model is now OpenRouter · Anthropic: Claude Sonnet 5."), "and says so", await settingsStatus(page));
      await page.waitForFunction(() => document.querySelector("[data-provider-model]")?.dataset.providerModel === "anthropic/claude-sonnet-5", { timeout: 3000 });
      const inUse = await page.$eval("[data-provider-model]", (e) => e.textContent);
      check(/Phaethon answers with OpenRouter · Anthropic: Claude Sonnet 5/.test(inUse), "what is in use is shown", inUse);

      // A model the list doesn't have: typed, then used as it is.
      await page.click("[data-model-query]", { clickCount: 3 });
      await page.keyboard.type("my-org/private-model");
      await page.waitForFunction(() => /Press Enter to use it/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      check((await activeOption(page)) === "__free__", "with nothing listed matching, the typed name is offered first", await activeOption(page));
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "settings_set_provider_model").length === 2, { timeout: 3000 });
      pm = (await calls(page, "settings_set_provider_model")).at(-1);
      check(pm.model === "my-org/private-model", "a typed name is saved as the model", JSON.stringify(pm));
      // Escape clears the search, and the dialog stays.
      await page.keyboard.type("x");
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 400));
      const after = await page.evaluate(() => [document.querySelector("[data-model-query]")?.value, document.querySelector('[role="dialog"]')?.dataset.state]);
      check(after[0] === "" && after[1] === "open", "Escape clears the search first, without closing Settings", JSON.stringify(after));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 3000 }).catch(() => {});
      check(!(await page.$('[role="dialog"]')), "a second Escape closes Settings");
    },
  },
  {
    name: "f10-ollama-off",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, prov: PROV({ provider: "ollama" }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-provider-status="stopped"]', { timeout: 3000 });
      const st = await page.$eval("[data-provider-status]", (e) => e.textContent);
      check(/Ollama isn’t running at http:\/\/127\.0\.0\.1:11434\. Open it, then check again\./.test(st), "says Ollama isn’t running, where, and what to do", st);
      check(!(await page.$("[data-key-input]")), "no key is asked for a model on this computer");
      const text = await page.$eval(PANEL, (e) => e.innerText);
      check(/Where Ollama runs/.test(text) && /runs on this computer, so none of this leaves it/.test(text), "it says where Ollama runs and that nothing leaves the computer", text.slice(0, 900));
      const ms = await searchStatus(page);
      check(/Ollama isn’t running/.test(ms) && /Type a model’s name/.test(ms), "the model list says why it is empty and that a name can be typed", ms);
      const url = await page.$eval("[data-provider-url]", (e) => [e.value, e.labels?.[0]?.textContent]);
      check(url[0] === "http://127.0.0.1:11434/v1" && url[1] === "Address", "the usual address is shown, labelled", JSON.stringify(url));
      // A bad address is refused at the field.
      await page.click("[data-provider-url]", { clickCount: 3 });
      await page.keyboard.type("not an address");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.querySelector("[data-provider-url]")?.getAttribute("aria-invalid") === "true", { timeout: 3000 });
      const err = await page.$eval("[data-provider-url]", (e) => document.getElementById(e.getAttribute("aria-describedby").split(" ")[1])?.textContent);
      check(/isn’t an address Phaethon can use/.test(err ?? ""), "a bad address is explained at the field", err);
      await park(page);
      await h.shot("off");
    },
  },
  {
    name: "f10-ollama-on",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, prov: PROV({ provider: "ollama" }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-provider-status="stopped"]', { timeout: 3000 });
      await page.evaluate(() => (window.__MOCK__.prov.running.ollama = true));
      await page.click("[data-provider-check]");
      await page.waitForSelector('[data-provider-status="running"]', { timeout: 3000 });
      check(await settingsSaid(page, "Ollama is running, with 2 models."), "Check again says it is running, with its models", await settingsStatus(page));
      const f = await page.evaluate(() => document.activeElement?.hasAttribute("data-provider-check"));
      check(f, "focus stays on Check again");
      // The list was empty while it wasn't running; choosing the provider again reads it.
      await page.select("[data-provider-select]", "openrouter");
      await page.select("[data-provider-select]", "ollama");
      await page.waitForFunction(() => /2 models/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      await page.click('[data-model-choice="qwen3:8b"]');
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_provider_model"), { timeout: 3000 });
      const pm = (await calls(page, "settings_set_provider_model")).at(-1);
      check(pm.provider === "ollama" && pm.model === "qwen3:8b", "a model is chosen from Ollama's list", JSON.stringify(pm));
      check((await calls(page, "api_key_check")).length === 0 && (await calls(page, "api_key_set")).length === 0, "no key anywhere");
      await park(page);
      await h.shot("on");
    },
  },
  {
    name: "f10-space",
    sizes: [[1100, 720]],
    mock: {
      settings: SETTINGS,
      threads: {},
      prov: PROV({ keys: { openrouter: true }, models: { openrouter: "openai/gpt-5" } }),
    },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
      await h.idle();
      const groups = await page.$$eval("[data-model-menu] [data-model-group]", (els) => els.map((e) => e.textContent));
      check(groups.join(",") === "Anthropic,OpenRouter", "the menu lists models by provider", groups.join(","));
      const item = await page.$eval('[data-model-option="openrouter:openai/gpt-5"]', (e) => [e.getAttribute("aria-label"), e.textContent.trim()]);
      check(item[0] === "OpenRouter · GPT-5" || item[0] === "OpenRouter · openai/gpt-5", "OpenRouter's model is said with its provider", JSON.stringify(item));
      await park(page);
      await h.shot("menu");
      await page.click('[data-model-option="openrouter:openai/gpt-5"]');
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "space_model_set"), { timeout: 3000 });
      let sets = await calls(page, "space_model_set");
      check(sets.at(-1).space === "school" && sets.at(-1).model === "openrouter:openai/gpt-5", "School saves provider:model", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses OpenRouter · openai/gpt-5."), "and says it with the provider", await shellStatus(page));
      const label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(/^Model in School: OpenRouter · openai\/gpt-5$/.test(label[0]) && /OpenRouter · openai\/gpt-5/.test(label[1]), "the button shows the provider and model", JSON.stringify(label));

      // Any model: Another model… opens a chooser with every provider that can answer.
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      await page.click(picker);
      await page.waitForSelector('[data-model-option="__other__"]', { timeout: 3000 });
      await h.idle();
      await page.$eval('[data-model-option="__other__"]', (e) => e.scrollIntoView({ block: "nearest" }));
      await h.shot("menu-other");
      await page.click('[data-model-option="__other__"]');
      await page.waitForSelector("[data-other-model-dialog]", { timeout: 3000 });
      const provs = await page.$$eval("[data-other-provider] option", (os) => os.map((o) => o.value));
      check(provs.includes("anthropic") && provs.includes("openrouter") && !provs.includes("openai"), "it offers the providers that can answer, not ones without a key", provs.join(","));
      const sel = await page.$eval("[data-other-provider]", (s) => s.value);
      check(sel === "openrouter", "starting on the provider in use", sel);
      await page.waitForFunction(() => /120 models/.test(document.querySelector("[data-other-model-dialog] [data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      await page.focus("[data-other-model-dialog] [data-model-query]");
      await page.keyboard.type("llama 4");
      await page.waitForFunction(() => /1 match/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      await park(page);
      // The menu fades out as the chooser fades in; the picture is of the chooser once it has.
      await new Promise((r) => setTimeout(r, 500));
      await h.shot("another");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-other-model-dialog]"), { timeout: 3000 });
      sets = await calls(page, "space_model_set");
      check(sets.at(-1).model === "openrouter:meta-llama/llama-4-maverick", "the chosen model is saved for School", JSON.stringify(sets.at(-1)));
      check(await shellSaid(page, "School now uses OpenRouter · Meta: Llama 4 Maverick."), "and said with its name from the list", await shellStatus(page));
      await page.waitForFunction((sel) => document.activeElement === document.querySelector(sel), { timeout: 3000 }, picker).catch(() => {});
      const f = await page.evaluate(() => document.activeElement?.dataset.modelPicker);
      check(f === "school", "focus goes back to the model button", f);
    },
  },
  {
    name: "f10-palette",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: {
      settings: SETTINGS,
      threads: {},
      spaceModels: { school: "openrouter:openai/gpt-5" },
      prov: PROV({ keys: { openrouter: true }, models: { openrouter: "anthropic/claude-sonnet-5" } }),
    },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.focus(`${shown} [data-composer-input]`);
      await palette(page, "change model");
      await page.waitForFunction(() => document.querySelector('[role="option"][aria-selected="true"]')?.dataset.command === "change-model", { timeout: 3000 });
      const hint = await page.$eval('[data-command="change-model"]', (e) => e.textContent);
      check(/in School: OpenRouter · OpenAI: GPT-5/.test(hint), "Change model… says the space's provider and model, by its name from the list", hint);
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
      await h.idle();
      let f = await page.evaluate(() => document.activeElement?.dataset.modelOption);
      check(f === "openrouter:openai/gpt-5", "the menu opens on the model in use", f);
      await page.keyboard.press("ArrowUp");
      f = await page.evaluate(() => document.activeElement?.dataset.modelOption);
      check(f === "openrouter:anthropic/claude-sonnet-5", "arrows reach the other OpenRouter model", f);
      await park(page);
      await h.shot("menu");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "space_model_set"), { timeout: 3000 });
      const sets = await calls(page, "space_model_set");
      check(sets.at(-1).model === "openrouter:anthropic/claude-sonnet-5", "Enter saves it for School", JSON.stringify(sets.at(-1)));
      check(await shellSaid(page, "School now uses OpenRouter · Anthropic: Claude Sonnet 5."), "and it is said", await shellStatus(page));
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      const f2 = await page.evaluate(() => document.activeElement?.dataset.modelPicker);
      check(f2 === "school", "focus goes back to the model button", f2);
    },
  },
  {
    name: "f10-fit",
    sizes: [[640, 480], [1100, 720]],
    sizesRequired: true,
    mock: { settings: SETTINGS, threads: {}, prov: PROV({ provider: "custom", keys: {}, urls: { custom: "https://llm.example.com/v1" }, lists: { custom: OLLAMA } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector("[data-provider-url]", { timeout: 3000 });
      await h.idle();
      const over = await page.$eval(PANEL, (p) => p.scrollWidth - p.clientWidth);
      check(over <= 0, "Settings › Assistant doesn't scroll sideways", `${over}`);
      const text = await page.$eval(PANEL, (e) => e.innerText);
      check(/Your server’s address/.test(text) && /Only if your server asks for one/.test(text) && /sent only to llm\.example\.com/.test(text), "your own server: its address, and a key only if it asks, sent only there", text.slice(0, 1200));
      await page.$eval("[data-model-search]", (e) => e.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("custom");
      const targets = await page.$$eval("[data-model-search] [role=option], [data-provider-check], [data-provider-url-save]", (els) => els.map((e) => e.getBoundingClientRect().height));
      check(targets.every((t) => t >= 24), "targets are at least 24px tall", JSON.stringify(targets));
    },
  },
];
