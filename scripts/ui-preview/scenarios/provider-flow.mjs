import { SETTINGS, check, openSettings } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration, providerPopup, useProviderDefault } from "../provider-flow.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([name]) => name === cmd).map(([, args]) => args), cmd);
const prov = () => ({ provider: "anthropic", keys: {}, models: {}, urls: {}, lists: { openrouter: [{ id: "openai/gpt-5", name: "GPT-5" }] } });

async function assertDefault(page, backend, provider) {
  const actual = await page.evaluate(() => [window.__MOCK__.settings.backend, window.__MOCK__.prov.provider]);
  check(actual[0] === backend && actual[1] === provider, "configuration preserves the selected default", JSON.stringify(actual));
}

async function assertSwitchError(page, message) {
  await page.waitForFunction((message) => document.querySelector('[data-provider-popup] [role="alert"]')?.textContent.includes(message), { timeout: 3000 }, message);
  check(!!await page.$(`${providerPopup} [data-provider-configuration]`), "a failed switch keeps configuration open");
}

export default [
  {
    name: "provider-management-separate-default",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, prov: prov(), slow: { settings_set_provider: 400 } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "openrouter", { keyboard: true, catalog: true });
      await h.idle();
      const input = `${providerPopup} [data-key-input]`;
      check(await page.$eval(`${providerPopup} [data-provider-default="openrouter"]`, (button) => button.disabled), "an unconfigured provider cannot become the default");
      check(await page.$eval("[data-model-selection]", (state) => state.textContent === "Not selected"), "the model field makes its unselected state explicit");
      check(await page.$eval(input, (node) => node.type) === "password", "API keys use a password input");
      await page.type(input, "sk-or-v1-0123456789abcdef");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-key-outcome="saved"]', { timeout: 3000 });
      check((await calls(page, "api_key_set")).at(-1)?.provider === "openrouter", "the inactive provider receives its own key");
      check(await page.$eval(`${providerPopup} [data-provider-default="openrouter"]`, (button) => button.disabled), "saving a key still requires choosing a model before activation");
      await page.click('[data-model-choice="openai/gpt-5"]');
      await page.waitForFunction(() => window.__MOCK__.prov.models.openrouter === "openai/gpt-5", { timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('[data-provider-popup] [data-provider-default="openrouter"]')?.disabled === false, { timeout: 3000 });
      check(await page.$eval("[data-model-selection]", (state) => state.textContent === "Selected"), "the selected model is explicit before activation");
      await assertDefault(page, "codex-cli", "anthropic");
      check((await calls(page, "settings_set_backend")).length === 0 && (await calls(page, "settings_set_provider")).length === 0, "adding a key and model never changes the default");
      const secret = await page.$eval(providerPopup, (dialog) => ({ text: dialog.textContent, value: dialog.querySelector("[data-key-input]").value }));
      check(secret.value === "" && !secret.text.includes("sk-or-v1-0123456789abcdef"), "saving clears the key and keeps it out of visible copy");
      await closeProviderPopup(page, { keyboard: true });
      await page.waitForSelector('[data-provider-row="openrouter"]', { timeout: 3000 });
      await openProviderConfiguration(page, "openrouter", { keyboard: true });
      await assertDefault(page, "codex-cli", "anthropic");
      check((await calls(page, "settings_set_provider")).length === 0, "Manage on the inactive provider does not select it");
      await useProviderDefault(page, "openrouter", { keyboard: true });
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__MOCK__.settings.backend === "phaethon" && window.__MOCK__.prov.provider === "openrouter", { timeout: 3000 });
      check((await calls(page, "settings_set_provider")).length === 1 && (await calls(page, "settings_set_backend")).length === 1, "explicit default activation switches provider and backend once while pending");
      await closeProviderPopup(page);
      check(await page.$eval('[data-provider-row="openrouter"]', (row) => /Default/.test(row.textContent)), "the selected provider's row shows Default");
    },
  },
  {
    name: "provider-default-failure-visible",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, prov: { ...prov(), keys: { openrouter: true }, models: { openrouter: "openai/gpt-5" } }, fail: { settings_set_provider: "Wait for the current reply to finish." } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "openrouter", { catalog: true });
      await useProviderDefault(page, "openrouter");
      await assertSwitchError(page, "Wait for the current reply to finish.");
      await assertDefault(page, "codex-cli", "anthropic");
      check((await calls(page, "settings_set_backend")).length === 0, "a failed provider change leaves the CLI backend active");
      await page.evaluate(() => delete window.__MOCK__.fail.settings_set_provider);
      await useProviderDefault(page, "openrouter");
      await page.waitForFunction(() => window.__MOCK__.prov.provider === "openrouter" && window.__MOCK__.settings.backend === "phaethon", { timeout: 3000 });
      check(!(await page.$(`${providerPopup} [role="alert"]`)), "retry clears the switch error after success");
    },
  },
  {
    name: "provider-cli-default-failure-visible",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, prov: prov(), fail: { agent_instance_select: "Wait for the current reply to finish." } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "codex-cli");
      check((await calls(page, "agent_instance_select")).length === 0, "managing an inactive CLI does not select it");
      await useProviderDefault(page, "codex-cli");
      await assertSwitchError(page, "Wait for the current reply to finish.");
      await assertDefault(page, "phaethon", "anthropic");
      await page.evaluate(() => delete window.__MOCK__.fail.agent_instance_select);
      await useProviderDefault(page, "codex-cli");
      await page.waitForFunction(() => window.__MOCK__.settings.backend === "codex-cli", { timeout: 3000 });
      check(!(await page.$(`${providerPopup} [role="alert"]`)), "CLI default selection can be retried in the same popup");
    },
  },
];
