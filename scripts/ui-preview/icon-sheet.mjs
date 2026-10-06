#!/usr/bin/env node
// Write a standalone HTML contact sheet of every Phaethon icon: each glyph at
// 16, 20 and 32px, in the light and dark themes, with its name. Loads the real
// <Icon> through Vite (so TSX and the @/ alias work), renders it to static
// markup, and needs no browser to build.
//
//   node scripts/ui-preview/icon-sheet.mjs --out /tmp/icons.html
//
// Open the file, or screenshot it with any headless browser.
import { writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const out = arg("out", "icon-sheet.html");

const vite = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
try {
  const { Icon, ICON_NAMES } = await vite.ssrLoadModule("/src/icons/index.tsx");

  const sizes = [16, 20, 32];
  const cell = (name) =>
    `<figure><div class="row">${sizes
      .map((s) => renderToStaticMarkup(createElement(Icon, { name, style: { width: s, height: s, strokeWidth: 1.5 } })))
      .join("")}</div><figcaption>${name}</figcaption></figure>`;
  const grid = ICON_NAMES.map(cell).join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phaethon icons</title>
<style>
  body { margin: 0; font: 11px/1.3 ui-sans-serif, system-ui, sans-serif; }
  section { padding: 16px; }
  .light { color: oklch(0.25 0.014 255); background: oklch(0.985 0.006 80); }
  .dark { color: oklch(0.93 0.009 80); background: oklch(0.2 0.01 255); }
  h2 { margin: 0 0 12px; font-size: 13px; font-weight: 600; }
  .grid { display: grid; grid-template-columns: repeat(8, 1fr); gap: 10px 8px; }
  figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .row { display: flex; align-items: center; gap: 10px; height: 36px; }
  figcaption { opacity: 0.75; }
</style></head><body>
<section class="light"><h2>Light (16 / 20 / 32 px)</h2><div class="grid">${grid}</div></section>
<section class="dark"><h2>Dark (16 / 20 / 32 px)</h2><div class="grid">${grid}</div></section>
</body></html>`;
  writeFileSync(out, html);
  console.log(`icon-sheet: ${ICON_NAMES.length} icons -> ${out}`);
} finally {
  await vite.close();
}
