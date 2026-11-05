// Model providers (Team Providers). Behaviour checks: check(...) fails the run.
//   f10-openrouter   Settings › Assistant: choose OpenRouter, another provider's key refused before it is sent, a key checked and
//                    saved for OpenRouter, its long model list searched by keyboard, a model chosen, and a name typed as a model
//   f10-ollama-off   Ollama chosen while it isn't running: said in plain words, no key asked, nothing leaves the computer
//   f10-ollama-on    Ollama started: Check again says it is running with its models, and one is chosen
//   f10-space        a space picks another provider's model from its menu, and any model through Another model…
//   f10-palette      ⌘K › Change model… lists provider · model and chooses one by keyboard only
//   f10-fit          at 640x480 (and with --scale 2) the provider settings and the model chooser fit
import { SETTINGS, check, openSettings, park } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration, useProviderDefault } from "../provider-flow.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const providerPopup = '[data-provider-detail] [data-provider-popup]';
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
const popupGeometry = (page) => page.$eval(providerPopup, (editor) => {
  const rect = element => element.getBoundingClientRect().toJSON();
  const dialog = editor.closest('[role="dialog"]');
  const viewport = editor.closest('[role="tabpanel"]');
  return {
    popup: rect(dialog), header: rect(dialog.querySelector('[data-settings-header]')),
    viewport: rect(viewport), modelList: rect(editor.querySelector('[data-model-search] [role="listbox"]')),
    buttons: [...editor.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map(rect),
    scrollTop: viewport.scrollTop, scrolls: viewport.scrollHeight > viewport.clientHeight,
    window: { width: innerWidth, height: innerHeight },
  };
});

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

async function palette(page, query) {
  await page.keyboard.down("Meta");
  await page.keyboard.press("k");
  await page.keyboard.up("Meta");
  await page.waitForSelector("[data-command-palette] .ui-palette-head input", { timeout: 3000 });
  await page.keyboard.type(query);
}

export default [
  {
    name: "f10-openrouter",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, prov: PROV() },
    async run(page, h) {
      await openSettings(page, h, "agent");
      check(!!(await page.$("[data-provider-add]")), "Add provider opens configuration");
      check(!(await page.$("[data-provider-select]")), "provider management has no select that changes the default");
      await page.click("[data-provider-add]");
      await page.waitForSelector("[data-provider-catalog]", { timeout: 3000 });
      const catalog = await page.$$eval("[data-provider-catalog-select]", (buttons) => buttons.map((button) => button.dataset.providerCatalogSelect));
      check(["anthropic", "openrouter", "openai", "ollama", "custom", "claude-cli", "codex-cli", "gemini-cli"].every((id) => catalog.includes(id)), "Add provider offers hosted, local, custom and CLI configuration", JSON.stringify(catalog));
      await closeProviderPopup(page);
      await openProviderConfiguration(page, "openrouter");
      check(await page.$eval('[data-provider-detail] [data-provider-popup] [data-provider-default="openrouter"]', (button) => button.disabled), "OpenRouter requires a key and model before becoming the default");
      await page.waitForSelector("[data-model-search=openrouter]", { timeout: 3000 });
      const text = await page.$eval(providerPopup, (e) => e.innerText);
      const keyLink = await page.$eval(`${providerPopup} a`, (a) => a.href);
      check(/OpenRouter API key/.test(text) && /openrouter\.ai/.test(keyLink), "the popup asks for OpenRouter's key and links to it", text.slice(0, 600));
      check(!/What is sent to|passes it on to the company/.test(text), "configuration omits the removed disclosure paragraphs");

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
      check(await settingsSaid(page, "API key saved."), "saving the key is said", await settingsStatus(page));
      await page.waitForFunction(() => /A key is saved/.test(document.querySelector("[data-key-input]")?.closest("form")?.textContent ?? ""), { timeout: 3000 });

      // Every available model stays reachable; typing narrows the full catalog.
      await page.waitForFunction(() => /120 models/.test(document.querySelector("[data-model-search-status]")?.textContent ?? ""), { timeout: 3000 });
      check((await searchStatus(page)).trim() === "120 models.", "a long list gives its concise count without a tutorial", await searchStatus(page));
      check((await page.$$("[data-model-search] [role=option]")).length === 120, "all 120 models remain reachable in the scrollable list");
      const none = await page.$eval("[data-model-query]", (e) => ({ value: e.value, placeholder: e.placeholder, label: e.labels?.[0]?.textContent }));
      check(none.value === "" && none.placeholder && none.label === "Default model" && !(await page.$("[data-provider-model]")), "an unconfigured model has an empty labelled search with a format cue", JSON.stringify(none));
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
      check(/Default: OpenRouter · Anthropic: Claude Sonnet 5/.test(inUse), "the configured default model is shown", inUse);
      await useProviderDefault(page, "openrouter");
      check(await settingsSaid(page, "Now using OpenRouter."), "activating the configured provider is said", await settingsStatus(page));

      // A model the list doesn't have: typed, then used as it is.
      await page.click("[data-model-query]", { clickCount: 3 });
      await page.keyboard.type("my-org/private-model");
      await page.waitForFunction(() => document.getElementById(document.querySelector("[data-model-query]")?.getAttribute("aria-activedescendant"))?.dataset.modelChoice === "__free__", { timeout: 3000 });
      check((await activeOption(page)) === "__free__", "with nothing listed matching, the typed name is offered first", await activeOption(page));
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__calls.filter(([c]) => c === "settings_set_provider_model").length === 2, { timeout: 3000 });
      pm = (await calls(page, "settings_set_provider_model")).at(-1);
      check(pm.model === "my-org/private-model", "a typed name is saved as the model", JSON.stringify(pm));
      // Escape clears the search, and the dialog stays.
      await page.keyboard.type("x");
      await page.keyboard.press("Escape");
      await new Promise((r) => setTimeout(r, 400));
      const after = await page.evaluate(() => [document.querySelector("[data-model-query]")?.value, !!document.querySelector('[data-provider-detail] [data-provider-popup]')]);
      check(after[0] === "" && after[1], "Escape clears the search first, without closing configuration", JSON.stringify(after));
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-settings-header]'), { timeout: 3000 });
      check(!(await page.$('[data-provider-configuration="openrouter"]')), "the next Escape closes Settings and its inline provider editor together");
    },
  },
  {
    name: "f10-ollama-off",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, prov: PROV({ provider: "ollama" }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "ollama");
      await page.waitForSelector('[data-provider-status="stopped"]', { timeout: 3000 });
      const st = await page.$eval("[data-provider-status]", (e) => e.textContent);
      check(/Ollama isn’t running at http:\/\/127\.0\.0\.1:11434\. Open it, then check again\./.test(st), "says Ollama isn’t running, where, and what to do", st);
      check(!(await page.$("[data-key-input]")), "no key is asked for a model on this computer");
      const text = await page.$eval(providerPopup, (e) => e.innerText);
      check(/Connect to your Ollama server/.test(text) && !/What is sent to/.test(text), "the popup gives Ollama's address without the removed disclosure", text.slice(0, 900));
      const ms = await searchStatus(page);
      check(/Ollama isn’t running/.test(ms) && !/Type a model’s name/.test(ms), "the model list retains its actual failure without an input tutorial", ms);
      const url = await page.$eval("[data-provider-url]", (e) => [e.value, e.labels?.[0]?.textContent]);
      check(url[0] === "http://127.0.0.1:11434/v1" && url[1] === "Server URL", "the usual address is shown, labelled", JSON.stringify(url));
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
      await openProviderConfiguration(page, "ollama");
      await page.waitForSelector('[data-provider-status="stopped"]', { timeout: 3000 });
      await page.evaluate(() => (window.__MOCK__.prov.running.ollama = true));
      await page.click("[data-provider-check]");
      await page.waitForSelector('[data-provider-status="running"]', { timeout: 3000 });
      check(await settingsSaid(page, "Ollama is running, with 2 models."), "Check again says it is running, with its models", await settingsStatus(page));
      const f = await page.evaluate(() => document.activeElement?.hasAttribute("data-provider-check"));
      check(f, "focus stays on Check again");
      // Reopening configuration refreshes the list without changing the default.
      // Leave the inline editor before reopening it, rather than closing a removed nested modal.
      await h.click('[data-provider-configure="claude-cli"]');
      await openProviderConfiguration(page, "ollama");
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
      await page.waitForSelector('[data-model-menu] [role="option"]', { timeout: 3000 });
      await h.idle();
      const groups = await page.$$eval('[data-model-menu] [data-model-picker-provider^="api:"]', (els) => els.map((e) => e.getAttribute('aria-label')));
      check(groups.join(",") === "Anthropic,OpenRouter", "the provider rail lists configured API providers", groups.join(","));
      await page.click('[data-model-picker-provider="api:openrouter"]');
      await page.waitForSelector('[data-model-option="openrouter:openai/gpt-5"]');
      const item = await page.$eval('[data-model-option="openrouter:openai/gpt-5"]', (e) => [e.getAttribute("aria-label"), e.textContent.trim()]);
      check(/OpenRouter/.test(item[0]) && /GPT-5|openai\/gpt-5/.test(item[0]), "OpenRouter's model is said with its provider", JSON.stringify(item));
      await park(page);
      await h.shot("menu");
      await page.click('[data-model-option="openrouter:openai/gpt-5"]');
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "space_model_set"), { timeout: 3000 });
      let sets = await calls(page, "space_model_set");
      check(sets.at(-1).space === "school" && sets.at(-1).model === "openrouter:openai/gpt-5", "School saves provider:model", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses OpenRouter · OpenAI: GPT-5."), "and says it with the provider", await shellStatus(page));
      const label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(/^Model in School: OpenRouter · OpenAI: GPT-5$/.test(label[0]) && /OpenRouter · OpenAI: GPT-5/.test(label[1]), "the button shows the provider and model", JSON.stringify(label));

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
      await page.waitForFunction(() => !!document.querySelector('[data-command="change-model"]'), { timeout: 3000 });
      const hint = await page.$eval('[data-command="change-model"]', (e) => e.textContent);
      check(/in School: OpenRouter · OpenAI: GPT-5/.test(hint), "Change model… says the space's provider and model, by its name from the list", hint);
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-model-menu] [role="option"]', { timeout: 3000 });
      await h.idle();
      check(await page.evaluate(() => document.activeElement?.matches('[data-model-search] input')), "the menu opens on its editable search");
      let f = await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute("aria-activedescendant"))?.dataset.modelOption);
      check(f === "openrouter:openai/gpt-5", "the inline combobox highlights the model in use", f);
      await page.keyboard.press("ArrowUp");
      f = await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute("aria-activedescendant"))?.dataset.modelOption);
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
    mock: { settings: SETTINGS, threads: {}, prov: PROV({ provider: "custom", keys: {}, urls: { custom: "https://llm.example.com/v1" }, lists: { custom: OPENROUTER } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "custom");
      await page.waitForSelector("[data-provider-url]", { timeout: 3000 });
      await h.idle();
      const over = await page.$eval(providerPopup, (p) => p.scrollWidth - p.clientWidth);
      check(over <= 0, "provider configuration doesn't scroll sideways", `${over}`);
      const text = await page.$eval(providerPopup, (e) => e.innerText);
      check(/Server URL/.test(text) && /OpenAI-compatible endpoint/.test(text) && /Add a key only if your server requires one/.test(text) && !/What is sent to/.test(text), "custom configuration offers an address and optional key without disclosure paragraphs", text.slice(0, 1200));
      await page.$eval("[data-model-search]", (e) => e.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("custom");
      const targets = await page.$$eval("[data-model-search] [role=option], [data-provider-check], [data-provider-url-save]", (els) => els.map((e) => e.getBoundingClientRect().height));
      check(targets.every((t) => t >= 24), "targets are at least 24px tall", JSON.stringify(targets));
      const layout = await page.$eval('[data-model-search] [role="listbox"]', (list) => {
        const rows = [...list.querySelectorAll('[role="option"]')];
        const bad = rows.flatMap((row, index) => {
          const bounds = row.getBoundingClientRect();
          const text = row.lastElementChild.getBoundingClientRect();
          const next = rows[index + 1]?.getBoundingClientRect();
          return text.top < bounds.top - 1 || text.bottom > bounds.bottom + 1 || (next && text.bottom > next.top + 1)
            ? [{ model: row.dataset.modelChoice, rowHeight: bounds.height, textHeight: text.height }]
            : [];
        });
        return { count: rows.length, scrolls: list.scrollHeight > list.clientHeight, bad };
      });
      check(layout.count === 120 && layout.scrolls, "the full model list scrolls instead of compressing its rows", JSON.stringify(layout));
      check(layout.bad.length === 0, "model titles and identifiers fit their rows without overlapping the next option", JSON.stringify(layout.bad.slice(0, 3)));
      await page.$eval('[role="tabpanel"][data-state="active"]', (viewport) => {
        viewport.scrollTop = 0;
      });
      await h.idle();
      const beforeScroll = await popupGeometry(page);
      await page.$eval('[role="tabpanel"][data-state="active"]', (viewport) => {
        viewport.scrollTop = viewport.scrollHeight;
      });
      await h.idle();
      const afterScroll = await popupGeometry(page);
      check(afterScroll.scrolls && afterScroll.scrollTop > beforeScroll.scrollTop + 1, "the Settings panel scrolls the inline provider editor from beginning to end");
      check(Math.abs(beforeScroll.header.top - afterScroll.header.top) <= 1 && Math.abs(beforeScroll.header.bottom - afterScroll.header.bottom) <= 1, "the Settings header stays fixed while the inline editor scrolls");
      for (const geometry of [beforeScroll, afterScroll]) {
        const { popup, header, viewport, buttons, window } = geometry;
        const inside = (bounds, container) => bounds.top >= container.top - 1 && bounds.bottom <= container.bottom + 1 && bounds.left >= container.left - 1 && bounds.right <= container.right + 1;
        const screen = { top: 0, left: 0, right: window.width, bottom: window.height };
        check(inside(header, popup) && inside(header, screen) && inside(viewport, popup) && header.bottom <= viewport.top + 1, "the dedicated Settings header and scroll panel stay inside the window without overlapping");
        check(buttons.every(bounds => bounds.left >= popup.left - 1 && bounds.right <= popup.right + 1), "inline provider actions do not clip horizontally");
      }
      check(Math.max(afterScroll.modelList.top, afterScroll.viewport.top) < Math.min(afterScroll.modelList.bottom, afterScroll.viewport.bottom), "the model list remains reachable at the end of the inline editor");
    },
  },
];
