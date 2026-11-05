import { SETTINGS, check } from '../audit-fixtures.mjs';

const trigger = '[data-space-pane][data-shown] [data-model-picker]';
const chip = '[data-space-pane][data-shown] [data-composer-effort]';
const account = (id, cli, name) => ({ config: { id, cli, name, binary: '', args: [] }, installed: true, loggedIn: true, managedHome: true, selected: id === cli });
const calls = (page, command) => page.evaluate(command => window.__calls.filter(([name]) => name === command).map(([, args]) => args), command);
const claudeModels = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', aliases: ['opus'], reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', aliases: ['sonnet'], reasoningEfforts: ['low', 'medium', 'high'] },
];
const reasoningMock = {
  settings: { ...SETTINGS, backend: 'claude-cli' }, threads: {},
  cliLists: { claude: { models: claudeModels, defaultModel: 'claude-opus-5-5' } },
  reasoning: { school: { claude: { $default: 'medium', 'claude-sonnet-5-5': 'low' } } },
};

export default [
  {
    name: 'model-selection-r6-account-default', sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {},
      agentInstances: [account('codex', 'codex', 'Codex Personal'), account('codex-team', 'codex', 'Codex Team')],
      instanceModels: {
        codex: { models: [{ id: 'personal-model', name: 'Personal Model' }], defaultModel: 'personal-model' },
        'codex-team': { models: [{ id: 'team-model', name: 'Team Model' }], defaultModel: 'team-model' },
      },
    },
    async run(page, h) {
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Personal Model'), {}, trigger);
      check(!await page.$('[data-model-menu]'), 'initial exact account default resolves without opening the picker');
      // Settings publishes this event after selecting an account. Exercise its
      // public protocol without depending on Settings' own layout selectors.
      await page.evaluate(async () => {
        await window.__TAURI_INTERNALS__.invoke('agent_instance_select', { id: 'codex-team' });
        window.dispatchEvent(new CustomEvent('phaethon:settings-changed', { detail: { what: 'backend' } }));
      });
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Team Model'), { timeout: 4000 }, trigger);
      check(!await page.$('[data-model-menu]'), 'changing account updates the real default name while the picker stays closed');
      check((await calls(page, 'space_model_set')).length === 0, 'loading account identity does not rewrite the model preference');
      await h.shot('closed-account');
    },
  },
  {
    name: 'model-selection-r6-default-alias', sizes: [[1100, 720]],
    mock: { ...reasoningMock, cliLists: { claude: { models: claudeModels, defaultModel: 'opus' } } },
    async run(page, h) {
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Claude Opus 5.5'), {}, trigger);
      await h.click(trigger);
      await page.waitForFunction(() => !document.querySelector('[data-model-option="__refresh__"]')?.disabled);
      await page.waitForFunction(() => document.querySelector('[data-model-option="__default__"]')?.textContent.includes('Claude Opus 5.5'), { timeout: 4000 });
      check(true, 'Default resolves the same published alias and full model name as the composer');
      check((await calls(page, 'space_model_set')).length === 0 && (await calls(page, 'agent_instance_select')).length === 0, 'inspecting the default is read-only');
      await h.shot('default-name');
    },
  },
  {
    name: 'model-selection-r6-effort-save-race', sizes: [[1100, 720]], mock: reasoningMock,
    async run(page, h) {
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Medium', {}, chip);
      check(!await page.$('[data-model-menu]'), 'saved reasoning is restored at mount without opening the picker');
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'Medium', {}, chip);
      check(!await page.$('[data-model-menu]'), 'a page reload restores the saved reasoning before opening the picker');
      await h.click(trigger);
      await page.waitForSelector('[data-effort-level="max"]');
      await page.evaluate(() => {
        const invoke = window.__TAURI_INTERNALS__.invoke;
        let held = false;
        window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
          const result = await invoke(command, args, options);
          if (!held && command === 'space_reasoning_get' && args.model === 'claude-sonnet-5-5') {
            held = true;
            window.__effortReadHeld = true;
            await new Promise(resolve => { window.__releaseEffortRead = resolve; });
          }
          return result;
        };
      });
      await h.click('[data-model-option="claude-sonnet-5-5"]');
      await page.waitForFunction(() => window.__effortReadHeld && document.querySelector('[data-effort-level="low"]')?.getAttribute('aria-checked') === 'true');
      await h.click('[data-effort-level="high"]');
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent === 'High', {}, chip);
      await page.evaluate(() => window.__releaseEffortRead());
      await h.idle();
      check(await page.$eval(chip, element => element.textContent === 'High'), 'a delayed old preference read cannot overwrite the reasoning just saved');
      check((await calls(page, 'space_reasoning_set')).at(-1)?.model === 'claude-sonnet-5-5', 'reasoning save remains scoped to the selected CLI model');
      await h.click('[data-effort-level="default"]');
      await page.waitForFunction(selector => !document.querySelector(selector), {}, chip);
      check(true, 'Default removes the explicit reasoning chip');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'));
      await h.click(trigger);
      await page.waitForFunction(() => document.querySelector('[data-effort-level="default"]')?.getAttribute('aria-checked') === 'true');
      check(!await page.$(chip), 'reopening retains the saved Default preference');
      await h.shot('saved-effort');
    },
  },
];
