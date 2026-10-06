#!/usr/bin/env node
// Screenshot the built UI (dist/) in scenarios, with a fake desktop backend.
//
//   pnpm build && node scripts/ui-preview/shoot.mjs --out /tmp/shots [--only name,name] [--dist dist]
//
// Default engine: a running Obscura (`obscura serve --port 9333 --allow-private-network`,
// or set OBSCURA_WS). Obscura is light but approximate (no web fonts, some
// calc() colours dropped). For a faithful render pass `--engine chromium`: it
// launches one chrome-headless-shell (STEWARD_CHROME_SHELL, or the Playwright
// cache copy) for the run and closes it after. Captures each scenario in light and dark at two window
// sizes, and writes <out>/<scenario>-<theme>-<w>x<h>.png. Prints any page
// errors; exits non-zero if a scenario failed.
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const dist = arg("dist", "dist");
const out = arg("out", "ui-shots");
const only = arg("only", "")?.split(",").filter(Boolean);
const sizes = (arg("sizes", "1100x720,760x560")).split(",").map((s) => s.split("x").map(Number));
const themes = arg("themes", "light,dark").split(",");
const ws = process.env.OBSCURA_WS || "ws://127.0.0.1:9333/devtools/browser";
mkdirSync(out, { recursive: true });

const scenarios = [];
for (const f of readdirSync(join(here, "scenarios")).sort()) {
  if (f.endsWith(".mjs")) scenarios.push(...(await import(join(here, "scenarios", f))).default);
}
const chosen = only?.length ? scenarios.filter((s) => only.includes(s.name)) : scenarios;

const mockJs = readFileSync(join(here, "mock-ipc.js"), "utf8");
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png" };
let current = { mock: {} };
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/__mock.js") {
    res.setHeader("content-type", "text/javascript");
    return res.end(`window.__MOCK__ = ${JSON.stringify(current.mock)};\n${mockJs}`);
  }
  let p = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(p)) p = join(dist, "index.html");
  let body = readFileSync(p);
  if (p.endsWith("index.html")) body = body.toString().replace("<head>", '<head><script src="/__mock.js"></script>');
  res.setHeader("content-type", types[extname(p)] ?? "application/octet-stream");
  res.end(body);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const engine = arg("engine", "obscura");
const shellPath =
  process.env.STEWARD_CHROME_SHELL ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser =
  engine === "chromium"
    ? await puppeteer.launch({ executablePath: shellPath, headless: "shell", args: ["--disable-features=MacAppCodeSignClone", "--force-color-profile=srgb"] })
    : await puppeteer.connect({ browserWSEndpoint: ws });
let failed = 0;
for (const s of chosen) {
  for (const theme of themes) {
    for (const [w, h] of sizes) {
      current = { mock: { ...s.mock, theme, platform: s.mock.platform ?? "mac" } };
      // A fresh context per shot: no localStorage carried between scenarios.
      const ctx = await browser.createBrowserContext().catch(() => null);
      const page = await (ctx ?? browser).newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      const name = `${s.name}-${theme}-${w}x${h}`;
      try {
        await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
        await page.goto(base, { waitUntil: "load" });
        await page.waitForSelector("#root > *", { timeout: 8000 });
        const helpers = {
          idle: () => new Promise((r) => setTimeout(r, 600)),
          waitText: (t, o = {}) =>
            page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 5000 }, t).catch((e) => { if (!o.soft) throw e; }),
          click: async (sel) => { await page.waitForSelector(sel, { timeout: 5000 }); await page.click(sel); },
          send: async (text) => {
            const input = 'textarea, [contenteditable="true"]';
            await page.waitForSelector(input, { timeout: 5000 });
            await page.focus(input);
            await page.keyboard.type(text);
            await page.keyboard.press("Enter");
          },
        };
        await s.run(page, helpers);
        await page.screenshot({ path: join(out, `${name}.png`) });
        console.log(`ok   ${name}${errors.length ? `  (page errors: ${errors.join(" | ").slice(0, 300)})` : ""}`);
      } catch (e) {
        failed++;
        await page.screenshot({ path: join(out, `${name}-FAILED.png`) }).catch(() => {});
        console.log(`FAIL ${name}: ${e.message}${errors.length ? `  (page errors: ${errors.join(" | ").slice(0, 300)})` : ""}`);
      }
      await page.close();
      await ctx?.close().catch(() => {});
    }
  }
}
if (engine === "chromium") await browser.close();
else await browser.disconnect();
server.close();
process.exit(failed ? 1 : 0);
