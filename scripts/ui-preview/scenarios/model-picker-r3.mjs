import { SETTINGS, check } from "../audit-fixtures.mjs";

const shown = '[data-space-pane][data-shown]';
const calls = (page, command) => page.evaluate(command => window.__calls.filter(([cmd]) => cmd === command).map(([, args]) => args), command);
const account = (id, name) => ({ config: { id, cli: 'codex', name, binary: '', args: [] }, installed: true, loggedIn: true, managedHome: id !== 'codex', account: `${name}@example.test`, plan: 'Pro', selected: id === 'codex' });
async function open(page, h) {
  await page.waitForSelector(`${shown} [data-model-picker]`);
  await h.click(`${shown} [data-model-picker]`);
  await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input[role="combobox"]'));
}
const active = page => page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('data-model-option'));

export default [
  {
    name: 'model-picker-r3-api', sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, model: 'claude-api-model-0' }, threads: {}, models: Array.from({ length: 120 }, (_, index) => ({ id: `claude-api-model-${index}`, name: `API model ${index}` })) },
    async run(page, h) {
      await open(page, h);
      check(!(await page.$('[data-model-menu] [role="menu"]')), 'model choices use an inline combobox, not a searchable menu');
      check(await page.$$eval('[data-model-list] [role="option"]', rows => rows.length === 121), 'the full catalog remains available without a cap');
      const geometry = await page.$eval('[data-model-picker-content]', root => ({ rail: root.querySelector('[data-model-picker-sidebar]').getBoundingClientRect().width, row: root.querySelector('[role="option"]').getBoundingClientRect().height, weight: getComputedStyle(root.querySelector('.ph-model-row-name')).fontWeight }));
      check(geometry.rail === 44 && geometry.row <= 36 && geometry.weight === '400', 'T3 rail width and compact normal-weight rows are preserved', JSON.stringify(geometry));
      await page.keyboard.press('End');
      check(await active(page) === 'claude-api-model-119', 'End reaches the final model while focus stays in search');
      await page.keyboard.down('Alt');
      await page.keyboard.press('f');
      await page.keyboard.up('Alt');
      check(!!await page.$('[aria-label="Remove API model 119 from favorites"]'), 'the host favorite shortcut uses the library active descendant');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'), { timeout: 5000 });
      check((await calls(page, 'space_model_set')).at(-1)?.model === 'claude-api-model-119', 'Enter persists the exact model through the existing space command');
      await open(page, h);
      await page.keyboard.type('nothing-matches');
      await page.keyboard.press('Enter');
      check((await calls(page, 'space_model_set')).length === 1, 'Enter with no result leaves the current model unchanged');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]') && document.activeElement?.matches('[data-model-picker]'));
    },
  },
  {
    name: 'model-picker-r3-accounts', sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {}, agentInstances: [account('codex', 'Personal'), account('codex-work', 'Work')], cliLists: { codex: { models: [{ id: 'personal-pro', name: 'Personal Pro' }] } }, instanceModels: { 'codex-work': { models: [{ id: 'work-pro', name: 'Work Pro' }] } }, fullAccess: ['school'] },
    async run(page, h) {
      await open(page, h);
      await h.click('[data-model-picker-provider="codex-work"]');
      await page.waitForSelector('[data-model-option="work-pro"]');
      check((await calls(page, 'agent_instance_models')).some(args => args.id === 'codex-work'), 'browsing reads the exact account catalog');
      check((await calls(page, 'agent_instance_select')).length === 0, 'browsing another account never changes the running assistant');
      await h.click('[aria-label="Favorite Work Pro"]');
      await h.click('[data-model-picker-provider="favorites"]');
      await page.waitForSelector('[data-model-option="work-pro"]');
      check(await page.$$eval('[data-model-list] [role="option"]', rows => rows.length === 1), 'favorites retain the model and account identity');
      await h.click('[data-model-option="work-pro"]');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'space_model_set' && args.model === 'codex:work-pro'));
      check((await calls(page, 'agent_instance_select')).at(-1)?.id === 'codex-work', 'choosing the row selects the real named account');
      await open(page, h);
      await h.click('[data-access-picker]');
      await page.waitForSelector('[data-access-menu]', { visible: true });
      await h.click('[data-access-menu] [data-state="unchecked"]');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'full_access_set' && args.on === false));
      check(!!await page.$('[data-model-menu]'), 'the permission footer works inside the model popover');
      await page.waitForFunction(() => !document.querySelector('[data-access-menu]'), { timeout: 5000 });
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'), { timeout: 5000 });
    },
  },
  {
    name: 'model-picker-r3-rollback', sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {}, agentInstances: [account('codex', 'Personal'), account('codex-work', 'Work')], cliLists: { codex: { models: [{ id: 'personal-pro', name: 'Personal Pro' }] } }, instanceModels: { 'codex-work': { models: [{ id: 'work-pro', name: 'Work Pro' }] } }, fail: { space_model_set: 'Could not save the model.' } },
    async run(page, h) {
      await open(page, h);
      await h.click('[data-model-picker-provider="codex-work"]');
      await page.waitForSelector('[data-model-option="work-pro"]');
      await h.click('[data-model-option="work-pro"]');
      await h.waitText('The model couldn’t be changed.');
      const selections = await calls(page, 'agent_instance_select');
      check(selections.length === 2 && selections[0].id === 'codex-work' && selections[1].id === 'codex', 'failed model persistence restores the previous real account');
      check(await page.evaluate(() => window.__MOCK__.activeAgentInstances.codex === 'codex'), 'the restored account is the actual backend selection');
    },
  },
  {
    name: 'model-picker-r3-vic-boundary', sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, slow: { space_model_set: 500 }, fail: { space_model_set: 'Disk unavailable.' } },
    async run(page, h) {
      await open(page, h);
      check(await page.$eval('[data-model-search] input', input => input.classList.contains('ui-combobox-search')), 'the consumer renders the actual Vic ComboboxSearch');
      await page.keyboard.press('ArrowDown');
      await page.evaluate(() => {
        const input = document.querySelector('[data-model-search] input');
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
      });
      check((await calls(page, 'space_model_set')).length === 0, 'IME composition Enter never selects or persists a model');
      await h.click('[data-model-option="claude-sonnet-5-5"]');
      await page.waitForFunction(() => document.querySelector('[data-model-search] input')?.disabled);
      check(await page.$$eval('[data-model-list] [role="option"]', rows => rows.every(row => row.getAttribute('aria-disabled') === 'true')), 'pending host persistence disables every Vic choice');
      await h.click('[data-model-option="claude-haiku-5-5"]');
      check((await calls(page, 'space_model_set')).length === 1, 'a pointer press while busy cannot submit another model');
      await h.waitText('The model couldn’t be changed. Disk unavailable.');
      check(!!await page.$('[data-model-menu]'), 'async failure keeps the enclosing model popover open');
      await page.waitForFunction(() => !document.querySelector('[data-model-search] input')?.disabled);
      await page.evaluate(() => { delete window.__MOCK__.slow.space_model_set; delete window.__MOCK__.fail.space_model_set; });
      await h.click('[data-model-option="claude-haiku-5-5"]');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'), { timeout: 5000 });
      check((await calls(page, 'space_model_set')).at(-1)?.model === 'claude-haiku-5-5', 'unlocking permits a successful retry through the host');
    },
  },
  {
    name: 'model-picker-r3-custom', sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {} },
    async run(page, h) {
      await open(page, h);
      await h.click('[aria-label="Custom model"]');
      await page.waitForSelector('[data-cli-model-input]');
      await page.type('[data-cli-model-input]', 'my-custom-model');
      await h.click('[data-cli-model-save]');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'space_model_set' && args.model === 'codex:my-custom-model'));
      await page.waitForFunction(() => !document.querySelector('[data-cli-model-dialog]') && document.activeElement?.matches('[data-model-picker]'));
      check(true, 'custom model entry preserves persistence and focus return');
    },
  },
];
