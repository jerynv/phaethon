import { SETTINGS, check, openSettings } from '../audit-fixtures.mjs';

const shown = '[data-space-pane][data-shown]';
const calls = (page, command) => page.evaluate(command => window.__calls.filter(([cmd]) => cmd === command).map(([, args]) => args), command);
const account = (id, name) => ({ config: { id, cli: 'codex', name, binary: '', args: [] }, installed: true, loggedIn: true, managedHome: true, account: `${id}@example.test`, selected: id === 'codex' });
const models = Array.from({ length: 120 }, (_, index) => ({ id: `vendor/model-${index}`, name: `Model ${String(index).padStart(3, '0')}` }));
const prov = { provider: 'anthropic', keys: { openrouter: true }, models: { openrouter: 'vendor/model-0' }, urls: {}, running: {}, lists: { openrouter: models } };
const instances = [account('codex', 'Codex Personal'), account('codex-team', 'Codex Team')];
const mock = { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {}, prov, agentInstances: instances };
async function api(page, h) {
  await openSettings(page, h, 'agent');
  await h.click('[data-provider-configure="openrouter"]');
  await page.waitForSelector('[data-provider-detail] [data-provider-configuration="openrouter"]', { visible: true });
  await page.waitForFunction(() => document.querySelectorAll('[data-model-search="openrouter"] [role="option"]').length === 120);
}
async function ime(page, selector) {
  await page.focus(selector);
  await page.evaluate(selector => {
    const input = document.querySelector(selector);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
  }, selector);
}
export default [
  { name: 'providers-r5-mixed-inline', sizes: [[1100, 720], [640, 480]], mock,
    async run(page, h) {
      await api(page, h);
      check(await page.$$eval('[role="dialog"]:not(#spaces-sidebar)', items => items.length === 1), 'API Manage stays inside the single Settings dialog');
      check(await page.$eval('[data-provider-configure="openrouter"]', e => e.getAttribute('aria-pressed') === 'true'), 'API row is the selected connection');
      check(await page.$eval('[data-model-query]', e => e.classList.contains('ui-combobox-search')), 'secondary API model search uses the actual Vic ComboboxSearch');
      await h.shot('mixed-api');
      const back = await page.$('[data-provider-detail] .provider-detail-back');
      if (back && await back.isVisible()) await back.click();
      await h.click('[data-agent-instance="codex-team"]');
      await page.waitForSelector('[data-provider-detail] [data-instance-name]', { visible: true });
      check(await page.$eval('[data-instance-name]', e => e.value === 'Codex Team'), 'CLI Manage uses the same selected detail pane');
      check(await page.$$eval('[role="dialog"]:not(#spaces-sidebar)', items => items.length === 1), 'CLI Manage also has no nested dialog');
      check((await calls(page, 'agent_instance_select')).length === 0 && (await calls(page, 'settings_set_provider')).length === 0 && (await calls(page, 'settings_set_backend')).length === 0, 'browsing API and CLI connections never changes runtime default');
      await h.shot('mixed-cli');
    } },
  { name: 'providers-r5-secondary-ime', sizes: [[1100, 720], [640, 480]], mock,
    async run(page, h) {
      await api(page, h);
      await ime(page, '[data-model-query]');
      check((await calls(page, 'settings_set_provider_model')).length === 0, 'IME confirmation does not persist an API default model');
      await page.keyboard.press('End');
      check(await page.$eval('[data-model-query]', e => document.getElementById(e.getAttribute('aria-activedescendant'))?.dataset.modelChoice === 'vendor/model-119'), 'Vic End reaches all 120 secondary model choices');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__calls.some(([cmd]) => cmd === 'settings_set_provider_model'));
      check((await calls(page, 'settings_set_provider_model')).length === 1 && (await calls(page, 'settings_set_provider_model'))[0].model === 'vendor/model-119', 'ordinary Enter selects the exact final model once');
      await page.type('[data-model-query]', 'custom-model-r5');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'settings_set_provider_model' && args.model === 'custom-model-r5'));
      check(true, 'custom identifiers retain actual Vic selection behavior');
      await page.focus('[data-model-query]');
      await page.keyboard.press('Escape');
      check(await page.$eval('[data-model-query]', e => e.value === ''), 'Escape clears a nonempty secondary query without dismissing Settings');
    } },
  { name: 'providers-r5-secondary-failure', sizes: [[1100, 720]], mock: { ...mock, fail: { settings_set_provider_model: 'Model preference could not be saved.' } },
    async run(page, h) {
      await api(page, h); await page.focus('[data-model-query]'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
      await h.waitText('Model preference could not be saved.');
      check(await page.$eval('[data-provider-model]', e => e.dataset.providerModel === 'vendor/model-0'), 'failed save retains the configured API model');
      check(!!await page.$('[data-provider-detail] [data-model-query]'), 'failed save leaves the inline editor and search available');
    } },
  { name: 'providers-r5-custom-api-ime', sizes: [[1100, 720]], mock: { settings: SETTINGS, threads: {}, models, prov },
    async run(page, h) {
      await h.click(`${shown} [data-model-picker]`); await page.waitForFunction(() => { const button = document.querySelector('[data-model-option="__other__"]'); return button && !button.disabled; });
      await h.click('[data-model-option="__other__"]'); await page.waitForSelector('[data-other-model-dialog] [data-model-query]');
      await page.select('[data-other-provider]', 'openrouter');
      await page.waitForFunction(() => document.querySelectorAll('[data-other-model-dialog] [role="option"]').length === 120);
      await ime(page, '[data-other-model-dialog] [data-model-query]');
      check((await calls(page, 'space_model_set')).length === 0, 'custom API model dialog ignores IME confirmation');
      await page.keyboard.press('End'); await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('[data-other-model-dialog]'));
      check((await calls(page, 'space_model_set')).length === 1 && (await calls(page, 'space_model_set'))[0].model === 'openrouter:vendor/model-119', 'custom API normal Enter saves exactly once');
    } },
  { name: 'providers-r5-auth-guard', sizes: [[1100, 720], [640, 480]], mock: { ...mock, signIn: { 'codex-team': { hold: true } } },
    async run(page, h) {
      await openSettings(page, h, 'agent');await h.click('[data-agent-instance="codex-team"]');
      await h.click('[data-cli-sign-in-start]');
      await page.waitForSelector('[data-cli-sign-in-stop]');
      await page.keyboard.press('Escape');
      check(!!await page.$('[data-settings-header]'),'immediate Escape cannot discard a running account sign-in');
      check(await page.$eval('[aria-label="Close settings"]', button => button.disabled),'Settings Close is disabled while authentication is pending');
      await h.click('[data-testid="settings-tab-appearance"]');
      check(!!await page.$('[data-provider-configuration="codex-cli"] [data-cli-sign-in-stop]'),'section switching cannot hide a pending sign-in');
      check((await calls(page,'agent_instance_select')).length===0,'managing sign-in does not activate the account');
      await h.click('[data-cli-sign-in-stop]');
      await page.waitForSelector('[data-cli-sign-in-outcome="cancelled"]');
      check((await calls(page,'agent_instance_sign_in_cancel')).at(-1)?.id==='codex-team','Cancel targets the exact in-flight account');
      await page.waitForFunction(()=>!document.querySelector('[aria-label="Close settings"]')?.disabled);
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-settings-header]'));
      check(true,'Settings becomes dismissible after explicit sign-in cancellation');
    } },
  { name: 'providers-r5-account-identity', sizes: [[1100, 720], [640, 480]], mock: { ...mock, cliLists: { codex: { models: [{ id: 'shared-model', name: 'Shared model' }] } }, instanceModels: { 'codex-team': { models: [{ id: 'shared-model', name: 'Shared model' }] } } },
    async run(page, h) {
      await h.click(`${shown} [data-model-picker]`); await page.waitForSelector('[data-model-search] input');
      await page.type('[data-model-search] input', 'shared');
      await page.waitForFunction(() => document.querySelectorAll('[data-model-option="shared-model"]').length === 2);
      const identity = await page.$$eval('[data-model-option="shared-model"]', rows => rows.map(row => ({ text: row.textContent, badge: row.querySelector('.ph-model-account-badge')?.textContent })));
      check(identity[0].badge === '1' && identity[1].badge === '2' && identity[0].text.includes('Codex Personal') && identity[1].text.includes('Codex Team'), 'merged model rows visibly distinguish deterministic per-account identity', JSON.stringify(identity));
      await h.shot('account-search');
      const star = '[data-model-option="shared-model"] + button';
      const stars = await page.$$(star); for (const button of stars) await button.click();
      await h.click('[data-model-picker-provider="favorites"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-model-option="shared-model"]').length === 2);
      check(await page.$$eval('[data-model-option="shared-model"]', rows => rows.every(row => row.querySelector('[data-model-account]')?.getAttribute('data-model-account'))), 'Favorites retains each visible connection identity');
      check((await calls(page, 'agent_instance_select')).length === 0, 'searching and favoriting accounts does not select a runtime');
      await h.shot('account-favorites');
      const row = await page.$$(' [data-model-option="shared-model"]'); await row[1].click();
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]'));
      check((await calls(page, 'agent_instance_select')).at(-1)?.id === 'codex-team', 'choosing the second duplicate model selects the exact Team account');
    } },
];
