import { SETTINGS, check } from '../audit-fixtures.mjs';

// Valid, selectable PDFs parsed and rendered by the real bundled pdf.js.
function pdf(count, textAt) {
  const children = Array.from({ length: count }, (_, index) => `${4 + index * 2} 0 R`).join(' ');
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${children}] /Count ${count} >>`, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  for (let n = 1; n <= count; n++) {
    const words = textAt(n).replace(/[\\()]/g, '\\$&');
    const text = `BT /F1 16 Tf 40 700 Td (${words}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 760] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (n - 1) * 2} 0 R >>`, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Root 1 0 R /Size ${objects.length + 1} >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data).toString('base64');
}
const file = b64 => ({ kind: 'pdf', mediaType: 'application/pdf', b64 });
const short = pdf(3, n => `Chapter ${n}${n === 3 ? ' unique theorem' : ''}`);
const long = pdf(1001, n => `Chapter ${n}${n === 1001 ? ' outside-only' : ''}`);
const fresh = pdf(3, n => `Fresh source ${n}`);
const pageInput = '[data-pdf-page-input]';
const findInput = '[data-pdf-find-input]';

async function fill(page, selector, text) {
  await page.focus(selector); await page.$eval(selector, node => node.select());
  await page.keyboard.press('Backspace'); if (text) await page.type(selector, text);
}
async function visiblePage(page, n) {
  await page.waitForFunction(n => {
    const region = document.querySelector('[data-pdf-pages-box]');
    const target = document.querySelector(`[data-pdf-page="${n}"]`);
    if (!region || !target) return false;
    const a = region.getBoundingClientRect(), b = target.getBoundingClientRect();
    return b.top >= a.top - 2 && b.top < a.bottom;
  }, { timeout: 5000 }, n).catch(async error => {
    const detail = await page.evaluate(() => ({ current: document.querySelector('[data-pdf-page-input]')?.value, window: document.querySelector('[data-pdf-pages-box]')?.dataset.pdfWindowStart, pages: [...document.querySelectorAll('[data-pdf-page]')].map(node => ({ n: node.dataset.pdfPage, top: node.getBoundingClientRect().top })), region: document.querySelector('[data-pdf-pages-box]')?.getBoundingClientRect().toJSON(), nextDisabled: document.querySelector('[data-pdf-next]')?.disabled }));
    throw new Error(`Page ${n}: ${error.message}: ${JSON.stringify(detail)}`);
  });
}
async function find(page, text) {
  await fill(page, findInput, text);
  await page.waitForSelector('[data-pdf-find-status="done"]', { timeout: 30000 });
}

export default [
  { name: 'pdf-navigation-r5-controls', sizes: [[1100, 720], [640, 480]], mock: { settings: SETTINGS, threads: { school: [{ role: 'assistant', text: '[Document](notes.pdf)' }] }, files: { 'notes.pdf': file(short) } },
    async run(page, h) {
      await h.click('[data-view-file="notes.pdf"]'); await page.waitForSelector('[data-pdf-pages="3"]');
      await fill(page, pageInput, '3'); await page.keyboard.press('Enter'); await visiblePage(page, 3);
      check(await page.$eval(pageInput, node => node.value === '3'), 'Enter jumps to the real requested page');
      await h.click('[data-pdf-previous]'); await visiblePage(page, 2);
      await h.click('[data-pdf-next]'); await visiblePage(page, 3);
      check(await page.$eval(pageInput, node => node.value === '3'), 'previous and next use the page being read');
      await h.click('[data-pdf-find-toggle]');
      check(await page.$eval(findInput, node => node === document.activeElement), 'Find puts focus in the Vic search input');
      await find(page, 'unique theorem'); await visiblePage(page, 3);
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent.includes('Page 3') && node.textContent.includes('1 of 1 matching pages')), 'real text extraction finds the phrase only on page three');
      await page.waitForFunction(() => document.querySelector('[data-pdf-page="3"] .textLayer')?.textContent.includes('unique theorem'), { timeout: 3000 }).catch(async error => {
        const detail = await page.$eval('[data-pdf-page="3"]', node => ({ text: node.textContent, canvas: node.querySelector('canvas')?.width, html: node.querySelector('.textLayer')?.innerHTML }));
        throw new Error(`${error.message}: ${JSON.stringify(detail)}`);
      });
      await find(page, 'Chapter');
      await h.click('[data-pdf-find-next]'); await visiblePage(page, 2);
      await h.click('[data-pdf-find-previous]'); await visiblePage(page, 1);
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent.includes('1 of 3 matching pages')), 'matching-page traversal reports pages, not invented occurrence counts');
      await find(page, 'no-such-phrase');
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent === 'No matching pages'), 'no-match state is explicit');
      await h.click('[data-pdf-find-clear]'); await page.waitForSelector('[data-pdf-find-status="idle"]');
      check(await page.$eval(findInput, node => node.value === ''), 'clearing resets the query and its results');
      await page.keyboard.press('Escape');
      check(!!await page.$('[data-file-viewer]') && !await page.$('[data-pdf-find]'), 'Escape closes Find before the file dialog');
      await fill(page, pageInput, '1'); await page.keyboard.press('Enter'); await visiblePage(page, 1);
      await page.keyboard.press('+'); await page.waitForSelector('[data-pdf-zoom="125"]');
      await page.keyboard.press('-'); await page.waitForSelector('[data-pdf-zoom="100"]');
      await page.keyboard.press('+'); await page.keyboard.press('0'); await page.waitForSelector('[data-pdf-zoom="100"]');
      check(await page.$eval('[data-pdf-view]', node => [...node.querySelectorAll('.ui-file-preview-toolbar')].every(bar => bar.scrollWidth <= bar.clientWidth + 1)), 'compact Vic toolbars fit the current width');
      await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[data-file-viewer]'));
      await page.waitForFunction(() => document.querySelector('[data-view-file="notes.pdf"]') === document.activeElement);
      check(await page.$eval('[data-view-file="notes.pdf"]', node => node === document.activeElement), 'closing restores the original file action');
    } },
  { name: 'pdf-navigation-r5-window-search', sizes: [[1100, 720]], mock: { settings: SETTINGS, threads: { school: [{ role: 'assistant', text: 'The source says [source: notes.pdf "Long source"].\n\n[Fresh file](fresh.pdf)' }] }, study: { citeFiles: { 'notes.pdf': 'Long source' }, citePage: { 'notes.pdf': 1000 } }, files: { 'notes.pdf': file(long), 'fresh.pdf': file(fresh) } },
    async run(page, h) {
      await page.waitForSelector('[data-citation="found"]'); await h.click('[data-citation="found"]'); await h.click('[data-citation-dialog] [data-view-file="notes.pdf"]');
      await visiblePage(page, 1000);
      check(await page.$$eval('[data-pdf-page]', nodes => nodes.length <= 40), 'page1000 citation renders at most40 page boxes');
      await h.click('[data-pdf-next]'); await visiblePage(page, 1001);
      check(await page.$$eval('[data-pdf-page]', nodes => nodes.length === 1), 'next page crosses the final window without prefix expansion');
      await h.click('[data-pdf-previous-window]'); await visiblePage(page, 961);
      await h.click('[data-pdf-next-window]'); await visiblePage(page, 1001);
      await fill(page, pageInput, '1'); await page.keyboard.press('Enter'); await visiblePage(page, 1);
      check(await page.$$eval('[data-pdf-page]', nodes => nodes.length === 40), 'earlier pages remain reachable with the same bounded layout');
      await h.click('[data-pdf-find-toggle]'); await find(page, 'outside-only');
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent.includes('No matching pages in searched text') && node.textContent.includes('Searched 1000 of 1001 pages')), 'search budgets disclose partial coverage instead of a false global no-match');
      await fill(page, findInput, 'Chapter');
      await page.waitForFunction(() => { const status = document.querySelector('[data-pdf-find-status="searching"]'); return status && !status.textContent.includes('Searching 0 of'); });
      await page.$eval('[data-pdf-find-cancel]', node => node.click()); await page.waitForSelector('[data-pdf-find-status="cancelled"]');
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent.includes('Search cancelled')), 'an active multi-page extraction can be cancelled');
      await page.focus(findInput); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('[data-file-viewer]')); await page.keyboard.press('Escape');
      await h.click('[data-view-file="fresh.pdf"]'); await page.waitForSelector('[data-pdf-pages="3"]'); await visiblePage(page, 1);
      check(!await page.$('[data-pdf-find]') && await page.$eval(pageInput, node => node.value === '1'), 'a new input starts without old search or page state');
      await h.click('[data-pdf-find-toggle]'); await find(page, 'Chapter');
      check(await page.$eval('[data-pdf-find-status]', node => node.textContent === 'No matching pages'), 'old document text and late extraction cannot pollute a new file');
    } },
];
