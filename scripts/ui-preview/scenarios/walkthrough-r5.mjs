import { SETTINGS, check, openSettings, openSpaceDetails } from '../audit-fixtures.mjs';

const input = '[data-space-pane][data-shown] [data-composer-input]';
const calls = (page, command) => page.evaluate(command => window.__calls.filter(([cmd]) => cmd === command).map(([, args]) => args), command);
const tool = { kind: 'tool', id: 'call-1', category: 'command', label: 'Running command', status: 'failed', detail: 'Exit code 1' };
function pdf() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [4 0 R 6 0 R 8 0 R] /Count 3 >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let n = 1; n <= 3; n++) {
    const text = `BT /F1 18 Tf 40 700 Td (Source passage page ${n}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 760] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (n - 1) * 2} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(data)); data += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data).toString('base64');
}

export default [
  { name: 'walkthrough-r5-work-log', sizes: [[1100, 720], [640, 480]], mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: [{ kind: 'toolStart', id: 'call-1', category: 'command', label: 'Running command' }, { kind: 'tool', label: 'Running command' }] },
    async run(page, h) {
      await h.send('Check the build'); await page.waitForSelector('[data-work-entry="call-1"][data-tool-state="running"]');
      await h.click('[data-work-log] summary');
      check(!!await page.$('[data-work-entry="call-1"] [data-icon="spinner"]'), 'actual pending call has a running icon');
      await page.evaluate(record => { window.__liveTurn.send({ kind: 'toolEnd', id: record.id, status: record.status, detail: record.detail }); window.__liveTurn.send({ kind: 'record', record }); window.__liveTurn.send({ kind: 'text', delta: 'The command failed.' }); window.__liveTurn.send({ kind: 'end', sessionId: null }); window.__liveTurn = null; }, tool);
      await page.waitForSelector('[data-tool-state="failed"]');
      check(await page.$$eval('[data-work-entry]', nodes => nodes.length === 1), 'terminal event and durable record update the same call');
      check(await page.$eval('[data-work-log]', node => node.textContent.includes('Failed') && node.textContent.includes('Exit code 1')), 'failure stays explicit after words arrive');
      check(!await page.$('[data-activity]'), 'finished work does not leave a running label');
      await h.shot('failed-work');
    } },
  { name: 'walkthrough-r5-work-log-reload', sizes: [[1100, 720]], mock: { settings: SETTINGS, threads: { school: [{ role: 'user', text: 'Check the build' }, { role: 'assistant', text: 'The command failed.', records: [tool] }] } },
    async run(page, h) {
      await page.waitForSelector('[data-work-entry="call-1"][data-tool-state="failed"]');
      await page.reload({ waitUntil: 'load' }); await page.waitForSelector('[data-work-entry="call-1"][data-tool-state="failed"]');
      await h.click('[data-work-log] summary');
      check(await page.$eval('[data-work-entry]', e => e.textContent.includes('Exit code 1')), 'loaded terminal record survives a fresh app render');
    } },
  { name: 'walkthrough-r5-citation-page', sizes: [[1100, 720], [640, 480]], mock: { settings: SETTINGS, threads: { school: [{ role: 'assistant', text: 'The source says [source: notes.pdf "Source passage page three"].' }] }, study: { citeFiles: { 'notes.pdf': 'Source passage page three' }, citePage: { 'notes.pdf': 3 } }, files: { 'notes.pdf': { kind: 'pdf', mediaType: 'application/pdf', b64: pdf() } } },
    async run(page, h) {
      await page.waitForSelector('[data-citation="found"]'); await h.click('[data-citation="found"]'); await h.click('[data-citation-dialog] [data-view-file="notes.pdf"]');
      await page.waitForFunction(() => { const region = document.querySelector('[data-pdf-pages-box]'); const target = document.querySelector('[data-pdf-page="3"]'); if (!region || !target) return false; const a = region.getBoundingClientRect(), b = target.getBoundingClientRect(); return b.top >= a.top - 2 && b.top < a.bottom; });
      check(await page.$eval('[data-pdf-pages-box]', node => node.scrollTop > 0), 'citation opens the actual third PDF page in its own scroll region');
      await page.waitForFunction(() => !!document.querySelector('[data-pdf-page="3"] canvas')?.width);
      await h.shot('citation-page-3'); await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('[data-citation-dialog] [data-view-file]') === document.activeElement);
      check(await page.$eval('[data-citation-dialog] [data-view-file]', node => node === document.activeElement), 'closing the file returns to its source action');
    } },
  { name: 'walkthrough-r5-folder-start', sizes: [[1100, 720], [640, 480]], mock: { settings: SETTINGS, threads: {}, workspacePicks: [{ path: '/Users/example/Projects/Thesis notes', name: 'Thesis notes' }] },
    async run(page, h) {
      await h.click('[data-space-pane][data-shown] [data-empty-workspace]');
      await page.waitForSelector('[data-workspace-picker] .ui-combobox-search'); await page.type('[data-workspace-picker] .ui-combobox-search', 'work');
      check(!await page.$('[data-choose-workspace="school"]') && !!await page.$('[data-choose-workspace="work"]'), 'inline Vic workspace search filters spaces');
      await h.click('[data-workspace-open-folder]'); await page.waitForSelector('[data-new-space-dialog]');
      check(await page.$eval('[data-new-space-dialog] input', node => node.value === 'Thesis notes'), 'native folder choice seeds its actual folder name');
      await h.click('[data-next-space]');
      check(await page.$eval('[data-new-workspace-path]', node => node.textContent.includes('/Projects/Thesis notes')), 'new workspace step shows chosen directory');
      await h.click('[data-create-space]'); await page.waitForFunction(() => !document.querySelector('[data-new-space-dialog]'));
      const bindings = await calls(page, 'space_workspace_bind');
      check(bindings.length === 1 && bindings[0].id === 'thesis-notes' && bindings[0].token && !('path' in bindings[0]), 'creation binds exactly one native approval token, never a renderer path');
      await openSettings(page, h, 'spaces'); await openSpaceDetails(page, ['thesis-notes']);
      await page.waitForFunction(() => document.querySelector('[data-workspace-location]')?.textContent.includes('/Projects/Thesis notes'));
      check(true, 'reopening space settings reads its persisted folder binding');
      await h.shot('workspace-folder');
    } },
  { name: 'walkthrough-r5-folder-cancel', sizes: [[1100, 720]], mock: { settings: SETTINGS, threads: {}, workspacePicks: [null] },
    async run(page, h) {
      await h.click('[data-space-pane][data-shown] [data-empty-workspace]'); await h.click('[data-workspace-open-folder]'); await h.idle();
      check(!(await calls(page, 'space_create')).length && !(await calls(page, 'space_workspace_bind')).length, 'cancelled folder picker creates and binds nothing');
    } },
  { name: 'walkthrough-r5-folder-retry', sizes: [[1100, 720]], mock: { settings: SETTINGS, threads: {}, workspacePicks: [{ path: '/Users/example/Projects/Thesis notes', name: 'Thesis notes' }], workspaceBindError: 'Workspace settings could not be saved.' },
    async run(page, h) {
      await h.click('[data-space-pane][data-shown] [data-empty-workspace]'); await h.click('[data-workspace-open-folder]'); await page.waitForSelector('[data-new-space-dialog]');
      await h.click('[data-next-space]'); await h.click('[data-create-space]');
      await page.waitForFunction(() => document.querySelector('[data-new-space-dialog] [role="alert"]')?.textContent.includes('Workspace settings could not be saved'));
      await page.evaluate(() => { delete window.__MOCK__.workspaceBindError; });
      await h.click('[data-create-space]'); await page.waitForFunction(() => !document.querySelector('[data-new-space-dialog]'));
      check((await calls(page, 'space_create')).length === 1 && (await calls(page, 'space_workspace_bind')).length === 2, 'retry completes the existing space with its still-valid native token');
    } },
  { name: 'walkthrough-r5-dictation-draft', sizes: [[1100, 720]], mock: { settings: SETTINGS, platform: 'linux', threads: {}, holdOpen: true, turn: [{ kind: 'text', delta: 'A reply is streaming.' }] },
    async run(page, h) {
      await page.evaluate(() => { window.SpeechRecognition = class { start() { window.__recognition = this; } stop() { this.onend?.(); } abort() { this.onend?.(); } }; });
      await h.send('Start the reply'); await page.waitForSelector('[data-voice-input] button');
      await page.type(input, 'Next draft'); await h.click('[data-voice-input] button');
      check(await page.$eval('[data-voice-input] button', node => !node.disabled && node.getAttribute('aria-pressed') === 'true'), 'dictation remains available while a reply streams');
      await page.evaluate(() => window.__recognition.onresult({ results: [[{ transcript: 'spoken continuation' }]] }));
      await page.waitForFunction(selector => document.querySelector(selector)?.value === 'Next draft spoken continuation', {}, input);
      check(await page.$eval(input, node => node.value === 'Next draft spoken continuation'), 'spoken draft appends without replacing typed words');
      check((await calls(page, 'agent_send')).length === 1, 'dictation does not send a second turn');
    } },
];
