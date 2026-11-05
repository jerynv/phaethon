import { SETTINGS, check, showSidebar } from "../audit-fixtures.mjs";

const now = Date.now();
const shown = '[data-space-pane][data-shown]';
const archive = Array.from({ length: 3000 }, (_, index) => ({
  id: String(now - (index + 1) * 1000), updated: now - (index + 1) * 1000,
  messages: [{ role: 'user', text: `Archive ${index}`, attachments: [] }, { role: 'assistant', text: `Saved reply ${index}`, attachments: [] }],
}));

export default [
  {
    name: 'workspace-r2-history-keyboard',
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: { school: [{ role: 'user', text: 'Current workspace', attachments: [] }] }, threadArchive: { school: archive } },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-composer-input]`);
      await h.focusVia('[data-conversations-trigger]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-history-controls] input'));
      check(true, 'keyboard opening starts in history search');
      await page.keyboard.type('Archive 2999');
      await page.waitForFunction(() => document.querySelectorAll('[data-history-list] [data-thread-id]').length === 1);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await h.waitText('Saved reply 2999');
      await page.waitForFunction(() => !document.querySelector('[data-conversations-menu]') && document.activeElement?.matches('[data-composer-input]'));
      check(await page.evaluate((id) => window.__calls.some(([cmd, args]) => cmd === 'thread_open' && args.id === id), archive[2999].id), 'keyboard search reaches an archive entry beyond page one');
      await h.focusVia('[data-conversations-trigger]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-history-controls] input'));
      for (let i = 0; i < 5 && !(await page.evaluate(() => document.activeElement?.matches('[aria-label="Next conversations"]'))); i++) await page.keyboard.press('Tab');
      check(await page.evaluate(() => document.activeElement?.matches('[aria-label="Next conversations"]')), 'Tab reaches paging without traversing every archive row');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-history-pagination]')?.textContent.includes('51–100'));
      for (let i = 0; i < 3 && !(await page.evaluate(() => document.activeElement?.matches('[data-thread-id]'))); i++) await h.tab(-1);
      await page.waitForFunction(() => document.activeElement?.matches('[data-thread-id]'));
      const id = await page.evaluate(() => document.activeElement.dataset.threadId);
      await page.keyboard.press('Enter');
      check(await page.waitForFunction((id) => window.__calls.some(([cmd, args]) => cmd === 'thread_open' && args.id === id), {}, id), 'a page-two result opens using keyboard only');
    },
  },
  {
    name: 'workspace-r2-api-catalog-keyboard',
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, model: 'claude-api-model-0' }, threads: {}, models: Array.from({ length: 120 }, (_, i) => ({ id: `claude-api-model-${i}`, name: `API model ${i}` })) },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-model-picker]`);
      await h.focusVia(`${shown} [data-model-picker]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input'));
      check(await page.$$eval('[data-model-menu] [role="option"]', (rows) => rows.length === 121), 'the API provider exposes all 120 models beyond its former 60-model cap');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      check(await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('data-model-option') === 'claude-api-model-119'), 'keyboard discovery reaches the API catalog final model');
      await h.shot('api-catalog-last-model');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'space_model_set' && args.model === 'claude-api-model-119'));
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]') && document.activeElement?.matches('[data-model-picker]'));
      check(true, 'the API selection persists and restores the model trigger');
    },
  },
  {
    name: 'workspace-r2-model-keyboard-catalog',
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, threads: {}, cliLists: { codex: { models: Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}`, name: `Model ${i}` })) } } },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-model-picker]`);
      await h.focusVia(`${shown} [data-model-picker]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input'));
      check(await page.$$eval('[data-model-menu] [role="option"]', (rows) => rows.length === 121), 'all 120 models are discoverable, with no silent catalog cap');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('End');
      check(await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('data-model-option') === 'model-119'), 'End reaches the final catalog model through the bounded scroll area');
      await h.shot('cli-catalog-last-model');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'space_model_set' && args.model === 'codex:model-119'));
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]') && document.activeElement?.matches('[data-model-picker]'));
      await h.focusVia(`${shown} [data-model-picker]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input'));
      check(await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('data-model-option') === 'model-119'), 'the editable combobox highlights the selected model');
      await page.keyboard.type('Model 118');
      await page.keyboard.press('ArrowDown');
      check(await page.evaluate(() => document.getElementById(document.activeElement?.getAttribute('aria-activedescendant'))?.getAttribute('data-model-option') === 'model-118'), 'search arrow navigation reaches a model beyond the former cap');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__calls.some(([cmd, args]) => cmd === 'space_model_set' && args.model === 'codex:model-118'));
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]') && document.activeElement?.matches('[data-model-picker]'));
      await h.focusVia(`${shown} [data-model-picker]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input'));
      const before = await page.evaluate(() => window.__calls.filter(([cmd]) => cmd === 'space_model_set').length);
      await page.keyboard.type('No such catalog model');
      await page.keyboard.press('Enter');
      check(await page.evaluate((before) => document.activeElement?.matches('[data-model-search] input') && !!document.querySelector('[data-model-menu]') && window.__calls.filter(([cmd]) => cmd === 'space_model_set').length === before, before), 'Enter with no match keeps the current model and search intact');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-model-menu]') && document.activeElement?.matches('[data-model-picker]'));
      check(true, 'Escape closes the model picker and restores its trigger');
    },
  },
  {
    name: 'workspace-r2-edit-surface',
    sizes: [[1100, 720], [640, 480]], sizesRequired: true,
    mock: { settings: SETTINGS, threads: { school: [{ role: 'user', text: 'Review this draft', attachments: [] }, { role: 'assistant', text: 'Ready for your revision.', attachments: [] }] } },
    async run(page, h) {
      await h.waitText('Ready for your revision.');
      await page.hover('[data-role="user"]');
      await h.click('[data-edit-message]');
      await page.waitForSelector('[data-edit-input]');
      const style = await page.$eval('[data-editing] [data-composer]', (frame) => ({ shadow: getComputedStyle(frame).boxShadow, edge: getComputedStyle(frame).borderTopWidth }));
      check(style.shadow === 'none' && Number.parseFloat(style.edge) <= 1, 'editing uses the quiet composer rim without a competing shadow', JSON.stringify(style));
      await h.shot('editing');
      await h.click('[data-editing] button[type="button"]');
      await page.waitForFunction(() => !document.querySelector('[data-edit-input]'));
      check(await page.$eval('[data-role="user"]', (node) => node.textContent.includes('Review this draft')), 'cancel keeps the original message');
    },
  },
  {
    name: 'workspace-r2-history',
    sizes: [[1100, 720], [640, 480]], sizesRequired: true,
    mock: { settings: SETTINGS, threads: { school: [{ role: 'user', text: 'Current workspace', attachments: [] }] }, threadArchive: { school: archive } },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-composer-input]`);
      await showSidebar(page);
      await h.click('[data-conversations-trigger]');
      await page.waitForSelector('[data-history-list] [data-thread-id]');
      check(await page.$$eval('[data-history-list] [data-thread-id]', (rows) => rows.length === 50), '3,000 saved conversations render only one bounded page');
      const bounds = await page.evaluate(() => {
        const menu = document.querySelector('[data-conversations-menu]').getBoundingClientRect();
        const search = document.querySelector('[data-history-controls]').getBoundingClientRect();
        const action = document.querySelector('[data-menu-new-conversation]').getBoundingClientRect();
        const list = document.querySelector('[data-history-list]').getBoundingClientRect();
        return { menu: [menu.top, menu.bottom], search: search.top, action: action.bottom, list: list.top, height: innerHeight };
      });
      check(bounds.search < bounds.action && bounds.action <= bounds.list + 1 && bounds.menu[0] >= 0 && bounds.menu[1] <= bounds.height, 'search and New stay above bounded history inside the viewport', JSON.stringify(bounds));
      await h.shot('bounded-history');
      await h.click('[aria-label="Next conversations"]');
      check(await page.$eval('[data-history-pagination]', (el) => el.textContent.includes('51–100')), 'paging advances without appending thousands of DOM rows');
      await h.click('[data-history-controls] input');
      await page.type('[data-history-controls] input', 'Archive 2999');
      await page.waitForFunction(() => document.querySelectorAll('[data-history-list] [data-thread-id]').length === 1);
      await h.shot('history-search');
      await h.click(`[data-thread-id="${archive[2999].id}"]`);
      await h.waitText('Saved reply 2999');
      check(await page.evaluate((id) => window.__calls.filter(([cmd, args]) => cmd === 'thread_open' && args.id === id).length === 1, archive[2999].id), 'a result beyond the first archive page opens through the existing controller once');
    },
  },
  {
    name: 'workspace-r2-model-permissions',
    sizes: [[1100, 720], [640, 480]], sizesRequired: true,
    mock: { settings: { ...SETTINGS, backend: 'codex-cli' }, fullAccess: ['school'], threads: {} },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-model-picker]`);
      check(!(await page.$(`${shown} [data-composer] [data-access-picker]`)), 'permissions belong to the model menu instead of a duplicate composer pill');
      await h.click(`${shown} [data-model-picker]`);
      await page.waitForSelector('[data-model-option="gpt-6-astra"]');
      await h.click('[data-model-search] input');
      await page.type('[data-model-search] input', 'Astra');
      check(await page.$$eval('[data-model-menu] [role="option"][data-model-option]', (rows) => rows.length === 1 && rows.some((row) => row.textContent.includes('GPT-6-Astra'))), 'model search filters actual catalog rows across providers');
      const color = await page.$eval('[data-access-picker] svg', (icon) => getComputedStyle(icon).color);
      const danger = await page.$eval('[data-access-picker]', (el) => {
        const probe = document.createElement('span'); probe.style.color = 'var(--ph-danger-ink)'; el.append(probe);
        const expected = getComputedStyle(probe).color; probe.remove(); return expected;
      });
      check(color === danger, 'full access uses the semantic danger colour', JSON.stringify({ color, danger }));
      await h.shot('model-and-permissions');
      await page.evaluate(() => {
        window.__accessPointer = [];
        document.addEventListener('pointerdown', (event) => {
          const row = event.target.closest('[role="menuitemradio"]');
          window.__accessPointer.push({ access: !!event.target.closest('[data-access-menu]'), choice: row?.getAttribute('data-state'), model: row?.getAttribute('data-model-option') });
        }, { capture: true });
      });
      await h.click('[data-model-menu] [data-access-picker]');
      await page.waitForSelector('[data-access-menu]');
      await h.click('[data-access-menu] [data-state="unchecked"]');
      await page.waitForFunction(() => (window.__MOCK__.fullAccessCalls ?? []).some((call) => call.id === 'school' && !call.on), { timeout: 5000 }).catch(async (error) => {
        throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(() => ({ pointer: window.__accessPointer, calls: window.__MOCK__.fullAccessCalls ?? [], menu: !!document.querySelector('[data-access-menu]'), active: document.activeElement?.outerHTML.slice(0, 200) })))}`);
      });
      check(await page.evaluate(() => window.__calls.filter(([cmd]) => cmd === 'full_access_set').length === 1), 'permission submenu persists the real access change once');
    },
  },
  {
    name: 'workspace-r2-thread-states',
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: [{ kind: 'text', delta: 'Working on this request.' }] },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-composer-input]`);
      await page.type(`${shown} [data-composer-input]`, 'Keep this draft');
      await page.waitForSelector('[data-sidebar-thread="current"] [data-thread-state="draft"]');
      check(await page.$eval('[data-sidebar-thread="current"]', (row) => row.firstElementChild.getAttribute('data-thread-state') === 'draft'), 'the left conversation icon reflects its saved draft');
      await h.click(`${shown} [aria-label="Send message"]`);
      await page.waitForSelector('[data-sidebar-thread="current"] [data-thread-state="running"]');
      check(await page.$eval('[data-sidebar-thread="current"]', (row) => row.querySelectorAll('[data-icon="spinner"]').length === 1 && row.firstElementChild.getAttribute('data-icon') === 'spinner'), 'running state replaces the left icon without a duplicate right spinner');
      const stop = await page.$eval('[data-stop] svg', (svg) => ({ fill: getComputedStyle(svg).fill, stroke: getComputedStyle(svg).stroke, colour: getComputedStyle(svg).color }));
      check(stop.fill === stop.colour && stop.stroke === 'none', 'Stop uses a solid square instead of an outlined glyph', JSON.stringify(stop));
      await h.shot('running-state');
      await page.evaluate(() => window.__setSpaceActivity('school', { running: true, needsYou: true }));
      await page.waitForSelector('[data-sidebar-conversations="school"] [data-thread-state="needs-you"]');
      check(await page.$eval('[data-sidebar-conversations="school"] [data-thread-state="needs-you"]', (icon) => icon.dataset.icon === 'warning'), 'waiting for the user replaces the same leading state icon');
      await page.evaluate(() => window.__setSpaceActivity('school', { running: true, needsYou: false }));
      await h.click('[data-space-id="work"]');
      await page.waitForSelector('[data-space-pane="work"][data-shown]');
      await page.evaluate(() => { window.__liveTurn.send({ kind: 'end', sessionId: null }); window.__liveTurn = null; });
      await page.waitForSelector('[data-sidebar-conversations="school"] [data-thread-state="unread"]');
      check(true, 'background completion remains unread until its conversation is shown');
      await h.click('[data-sidebar-conversations="school"] [data-sidebar-thread="current"]');
      await page.waitForFunction(() => !document.querySelector('[data-sidebar-conversations="school"] [data-thread-state="unread"]'));
      check(true, 'showing the completed conversation acknowledges its unread state');
    },
  },
  {
    name: 'workspace-r2-tutor',
    sizes: [[1100, 720], [640, 480]], sizesRequired: true,
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await page.waitForSelector('[data-tutor-mode]');
      await h.click('[data-tutor-mode]');
      const panel = await page.$eval('[data-tutor-menu]', (menu) => ({ width: menu.getBoundingClientRect().width, icons: [...menu.querySelectorAll('[data-tutor-option]')].map((row) => row.querySelector('svg')?.getAttribute('data-icon')) }));
      check(panel.width < 300 && new Set(panel.icons).size === 5, 'tutor modes use distinct icons in a content-sized menu', JSON.stringify(panel));
      await h.shot('tutor-modes');
    },
  },
];
