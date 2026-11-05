import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { SETTINGS, check, openSettings } from '../audit-fixtures.mjs';
import lms from './lms-revision.mjs';

// Actual synthetic OpenXML packages, written with the installed DOCX peer dependency.
const ZIP = createRequire(import.meta.resolve('docx-preview'))('jszip');
const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const types = body => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${body}</Types>`;
const packageBytes = async files => { const zip = new ZIP(); Object.entries(files).forEach(([name, body]) => zip.file(name, body)); return (await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })).toString('base64'); };
const docx = await packageBytes({
  '[Content_Types].xml': types('<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'),
  '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Actual document preview</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Rendered table cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>',
  'word/_rels/document.xml.rels': `<Relationships xmlns="${rels}"/>`,
});
const xlsx = await packageBytes({
  '[Content_Types].xml': types('<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'),
  '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/workbook.xml': `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${office}"><sheets><sheet name="Grades" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Course</t></is></c><c r="B1" t="inlineStr"><is><t>Score</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Discrete structures</t></is></c><c r="B2"><v>94</v></c></row></sheetData></worksheet>',
});
const pptx = await packageBytes({
  '[Content_Types].xml': types('<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'),
  '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  'ppt/presentation.xml': `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Induction and proof</a:t></a:r></a:p><a:p><a:r><a:t>Actual slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
});
const wav = Buffer.alloc(44 + 8000); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(8000, 40);
for (let i = 0; i < 4000; i++) wav.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 440 / 8000) * 2000), 44 + i * 2);
const files = {
  'notes.docx': { kind: 'docx', mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', b64: docx },
  'grades.xlsx': { kind: 'spreadsheet', mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', b64: xlsx },
  'lecture.pptx': { kind: 'slides', mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', b64: pptx },
  'voice.wav': { kind: 'audio', mediaType: 'audio/wav', b64: wav.toString('base64') },
  'clip.webm': { kind: 'video', mediaType: 'video/webm', b64: readFileSync(new URL('../fixtures/preview-video.webm', import.meta.url)).toString('base64') },
  'oversized.docx': { kind: 'docx', size: 10 * 1024 * 1024 + 1 },
};
const mock = { settings: SETTINGS, threads: { school: [{ role: 'assistant', text: Object.keys(files).map(name => `[${name}](${name})`).join('\n\n') }] }, files };
const open = async (page, path) => { await page.click(`[data-view-file="${path}"]`); await page.waitForSelector('[data-file-viewer]'); };
const close = async page => { await page.keyboard.press('Escape'); await page.waitForFunction(() => !document.querySelector('[data-file-viewer]')); };
export default [
  { name: 'office-media-r5-documents', sizes: [[1100, 720], [640, 480]], mock,
    async run(page, h) {
      check(await page.evaluate(() => !performance.getEntriesByType('resource').some(entry => /\/(preview-(docx|office|media)|docx-preview)-/.test(entry.name))), 'optional renderers and the DOCX peer stay out of startup requests');
      await open(page, 'notes.docx'); await page.waitForSelector('[data-file-viewer] iframe');
      const frameElement = await page.$('[data-file-viewer] iframe'); const frame = await frameElement.contentFrame();
      await frame.waitForFunction(() => document.body.textContent.includes('Rendered table cell'));
      check(await frame.evaluate(() => !!document.querySelector('table') && document.body.textContent.includes('Actual document preview')), 'real DOCX renders its paragraph and table');
      check(await frameElement.evaluate(node => node.getAttribute('sandbox') === ''), 'DOCX stays in an empty sandbox under the host CSP');
      await h.shot('docx'); await close(page);
      await open(page, 'grades.xlsx'); await page.waitForFunction(() => document.querySelector('[data-file-viewer] table')?.textContent.includes('Discrete structures'));
      check(await page.$eval('[data-file-viewer] table', table => table.textContent.includes('94')), 'actual XLSX stored cell values appear in the sheet table'); await h.shot('xlsx'); await close(page);
      await open(page, 'lecture.pptx'); await page.waitForFunction(() => document.querySelector('[data-file-viewer]')?.textContent.includes('Actual slide text'));
      check(await page.$eval('[data-file-viewer]', node => /extracted|text/i.test(node.textContent)), 'PPTX presents actual slide text with an honest format label'); await h.shot('pptx'); await close(page);
      await open(page, 'oversized.docx'); await page.waitForFunction(() => document.querySelector('[data-file-viewer]')?.textContent.includes('larger than'));
      check(await page.evaluate(() => !window.__calls.some(([command, args]) => command === 'file_bytes' && args.path === 'oversized.docx')), 'encoded Office budget rejects before the host fetches bytes');
    } },
  { name: 'office-media-r5-playback', sizes: [[1100, 720]], mock,
    async run(page, h) {
      for (const [path, tag] of [['voice.wav', 'audio'], ['clip.webm', 'video']]) {
        await open(page, path); await page.waitForFunction(tag => document.querySelector(`[data-file-viewer] ${tag}`)?.readyState >= 1, {}, tag);
        await page.$eval(`[data-file-viewer] ${tag}`, media => media.play());
        await page.waitForFunction(tag => document.querySelector(`[data-file-viewer] ${tag}`)?.currentTime > 0, {}, tag);
        check(await page.$eval(`[data-file-viewer] ${tag}`, media => media.controls && media.duration > 0), `${tag} actually decodes and plays ready bytes under host CSP`);
        await h.shot(tag); await page.$eval(`[data-file-viewer] ${tag}`, media => media.pause()); await close(page);
      }
    } },
  { name: 'office-media-r5-imported-text', sizes: [[1100, 720]], mock: {
      ...lms.find(scenario => scenario.name === 'lms-revision-sources').mock,
      lmsContent: { 'c1/101': [{ path: 'courses/Discrete Structures/files/lecture.pptx', title: 'Lecture slides', kind: 'file', text: 'courses/Discrete Structures/files/lecture.pptx.md' }] },
      files: { 'courses/Discrete Structures/files/lecture.pptx': files['lecture.pptx'], 'courses/Discrete Structures/files/lecture.pptx.md': { kind: 'markdown', text: '# Slide 1\n\nImported OCR text remains accessible.' } },
    },
    async run(page, h) {
      await openSettings(page, h, 'courses'); await h.click('[data-course-overview-tab="courses"]'); await h.click('[data-course-select="c1/101"]'); await h.click('[data-browse-course]');
      await h.click('[data-course-content-open]'); await page.waitForSelector('[data-preview-text]'); await h.click('[data-preview-text]');
      await page.waitForFunction(() => document.querySelector('[data-viewer-markdown]')?.textContent.includes('Imported OCR text remains accessible'));
      check(await page.evaluate(() => window.__calls.some(([command, args]) => command === 'file_view' && args.path.endsWith('lecture.pptx.md') && args.space === 'school')), 'imported text view uses a separately permission-checked companion source');
    } },
];
