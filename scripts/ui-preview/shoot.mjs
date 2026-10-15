#!/usr/bin/env node
// Screenshot the built UI (dist/) in scenarios, with a fake desktop backend.
//
//   pnpm build && node scripts/ui-preview/shoot.mjs --out /tmp/shots [--only name,name] [--dist dist]
//
// Default engine: a running Obscura (`obscura serve --port 9333 --allow-private-network`,
// or set OBSCURA_WS). Obscura is light but approximate (no web fonts, some
// calc() colours dropped). For a faithful render pass `--engine chromium`: it
// launches one chrome-headless-shell (PHAETHON_CHROME_SHELL, or the Playwright
// cache copy) for the run and closes it after. Captures each scenario in light and dark at two window
// sizes, and writes <out>/<scenario>-<theme>-<w>x<h>[-variant].png. Prints any page
// errors; exits non-zero if a scenario failed.
//
// Selecting scenarios: --only a,b (exact names) or --match a,b (names starting with any of them).
// --help prints this and exits.
//
// Variants (apply to every scenario in the run, and name the files):
//   --scale 1.5        text size token at startup (mock appearance)   -> -scale1.5
//   --contrast         Increase contrast on (mock appearance)          -> -contrast
//   --motion reduce    prefers-reduced-motion: reduce                  -> -motion-reduce
//   --forced-colors    forced-colors: active                           -> -forced
// Audit:
//   --axe              run axe-core (WCAG 2.0/2.1/2.2 A and AA) after each shot,
//                      merge into <out>/axe.json, print a count per shot.
// A scenario may set `sizes: [[w, h], ...]` and `themes: [...]` to use instead of the defaults
// (an explicit --sizes / --themes still wins, unless the scenario sets `sizesRequired: true`
// because what it checks only exists at those sizes). Scenario helpers: idle, waitText,
// click, send, hover, press (mouse down, no up: :active), tab, focusVia (Tab
// until a selector has focus), shot(label) (an extra screenshot mid-run,
// named <scenario>--<label>-<theme>-<w>x<h>[-variant].png).
import { createServer } from "node:http";
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  const head = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(head.slice(0, head.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const flag = (k) => process.argv.includes(`--${k}`);
const dist = arg("dist", "dist");
const out = arg("out", "ui-shots");
const only = arg("only", "")?.split(",").filter(Boolean);
const match = arg("match", "")?.split(",").filter(Boolean);
const sizesGiven = flag("sizes");
const sizes = arg("sizes", "1100x720,760x560").split(",").map((s) => s.split("x").map(Number));
const themes = arg("themes", "light,dark").split(",");
// --connect <ws> (or BROWSER_WS / OBSCURA_WS) joins an already-running browser,
// e.g. the shared one from chromium-server.mjs, instead of launching one.
const ws = arg("connect", null) || process.env.BROWSER_WS || process.env.OBSCURA_WS || "ws://127.0.0.1:9333/devtools/browser";
mkdirSync(out, { recursive: true });

// ---- Variants ----
const scale = arg("scale", null);
const contrast = flag("contrast");
const motion = arg("motion", null);
const forced = flag("forced-colors");
const variant = [scale && `scale${scale}`, contrast && "contrast", motion && `motion-${motion}`, forced && "forced"]
  .filter(Boolean)
  .join("-");
/** The mock's default settings (mock-ipc.js), so a variant can add appearance to them. */
const BASE_SETTINGS = { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5" };
function withVariant(mock) {
  if (!scale && !contrast) return mock;
  const settings = { ...BASE_SETTINGS, ...mock.settings };
  const appearance = { ...settings.appearance, tokens: { ...settings.appearance?.tokens } };
  if (scale) appearance.tokens["--ph-text-scale"] = Number(scale);
  if (contrast) appearance.increaseContrast = "on";
  return { ...mock, settings: { ...settings, appearance } };
}

// ---- axe-core ----
const axe = flag("axe");
const axeSource = axe ? readFileSync(join(here, "../../node_modules/axe-core/axe.min.js"), "utf8") : "";
const axeResults = {};
async function runAxe(page, name) {
  if (!axe) return;
  try {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: axeSource });
    const found = await page.evaluate(async (forced) => {
      const res = await window.axe.run(document, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"] },
        // Under forced colours axe reads the author colours, not the forced
        // palette that is painted, so its contrast results are false.
        rules: forced ? { "color-contrast": { enabled: false } } : {},
        resultTypes: ["violations"],
      });
      return res.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary, html: n.html.slice(0, 240) })),
      }));
    }, forced);
    axeResults[name] = found;
    const count = found.reduce((n, v) => n + v.nodes.length, 0);
    console.log(`     axe ${name}: ${count}${found.length ? ` [${found.map((v) => `${v.id} x${v.nodes.length}`).join(", ")}]` : ""}`);
  } catch (e) {
    axeResults[name] = { error: e.message };
    console.log(`     axe ${name}: could not run (${e.message})`);
  }
}

/**
 * Wait for every finite animation and transition to end (a menu or tooltip fading in or out, a colour easing on
 * hover), so a screenshot and axe see the page as it rests, not a frame of a fade: a half-faded tooltip measures a
 * contrast it never has at rest. Endless ones (spinners) don't count. At most 3 s; then it goes on as it is.
 */
async function settle(page) {
  await page
    .waitForFunction(
      () => document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming?.().iterations === Infinity),
      { timeout: 3000, polling: 50 },
    )
    .catch(() => {});
}

const scenarios = [];
// --scenarios <dir> loads scenario files from another folder instead (kept out of the repo).
const scenarioDir = arg("scenarios", null) ?? join(here, "scenarios");
for (const f of readdirSync(scenarioDir).sort()) {
  if (f.endsWith(".mjs")) scenarios.push(...(await import(join(scenarioDir, f))).default);
}
const chosen = scenarios.filter((s) => (!only?.length || only.includes(s.name)) && (!match?.length || match.some((m) => s.name.startsWith(m))));

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
  process.env.PHAETHON_CHROME_SHELL ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser =
  engine === "chromium"
    ? await puppeteer.launch({ executablePath: shellPath, headless: "shell", args: ["--disable-features=MacAppCodeSignClone", "--force-color-profile=srgb"] })
    : await puppeteer.connect({ browserWSEndpoint: ws });
let failed = 0;
let shots = 0;
for (const s of chosen) {
  for (const theme of flag("themes") || !s.themes ? themes : s.themes) {
    for (const [w, h] of s.sizes && (s.sizesRequired || !sizesGiven) ? s.sizes : sizes) {
      current = { mock: withVariant({ ...s.mock, theme, platform: s.mock.platform ?? "mac" }) };
      // A fresh context per shot: no localStorage carried between scenarios.
      const ctx = await browser.createBrowserContext().catch(() => null);
      await ctx?.overridePermissions(base, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]).catch(() => {});
      const page = await (ctx ?? browser).newPage();
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      const suffix = `-${theme}-${w}x${h}${variant ? `-${variant}` : ""}`;
      const name = `${s.name}${suffix}`;
      try {
        // Puppeteer's emulateMediaFeatures refuses forced-colors, so this goes
        // to CDP directly; Chromium then paints with the forced palette too.
        const media = [];
        if (motion) media.push({ name: "prefers-reduced-motion", value: motion });
        if (forced) media.push({ name: "forced-colors", value: "active" });
        if (media.length) await (await page.createCDPSession()).send("Emulation.setEmulatedMedia", { features: media });
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
          /** Pointer over the element's centre (hover styles, tooltips). */
          hover: async (sel) => { await page.waitForSelector(sel, { timeout: 5000 }); await page.hover(sel); },
          /** Mouse down on the element without releasing: shows its :active (pressed) state. */
          press: async (sel) => {
            const el = await page.waitForSelector(sel, { timeout: 5000 });
            const box = await el.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.down();
          },
          /** Press Tab n times (Shift+Tab when n is negative). */
          tab: async (n = 1) => {
            for (let i = 0; i < Math.abs(n); i++) {
              if (n < 0) await page.keyboard.down("Shift");
              await page.keyboard.press("Tab");
              if (n < 0) await page.keyboard.up("Shift");
            }
          },
          /** Tab from wherever focus is until `sel` has it, as a keyboard user would. Returns the presses. */
          focusVia: async (sel, max = 60) => {
            for (let i = 0; i < max; i++) {
              if (await page.evaluate((sel) => !!document.activeElement?.matches(sel), sel)) return i;
              await page.keyboard.press("Tab");
            }
            throw new Error(`Tab never reached ${sel}`);
          },
          /** An extra screenshot now (axe runs on it too, with --axe). */
          shot: async (label) => {
            const n = `${s.name}--${label}${suffix}`;
            await settle(page);
            await page.screenshot({ path: join(out, `${n}.png`) });
            shots++;
            console.log(`ok   ${n}`);
            await runAxe(page, n);
          },
        };
        await s.run(page, helpers);
        await settle(page);
        await page.screenshot({ path: join(out, `${name}.png`) });
        shots++;
        console.log(`ok   ${name}${errors.length ? `  (page errors: ${errors.join(" | ").slice(0, 300)})` : ""}`);
        await runAxe(page, name);
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
if (axe) {
  // Merged into any axe.json already in <out>, so several runs (variants, --match) build one report.
  const file = join(out, "axe.json");
  const before = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...before, ...axeResults }, null, 2));
  const byRule = {};
  for (const r of Object.values(axeResults)) if (Array.isArray(r)) for (const v of r) byRule[v.id] = (byRule[v.id] ?? 0) + v.nodes.length;
  console.log(`axe totals by rule (nodes): ${JSON.stringify(byRule)}`);
}
console.log(`${shots} screenshot(s), ${failed} failed scenario run(s)`);
if (engine === "chromium") await browser.close();
else await browser.disconnect();
server.close();
process.exit(failed ? 1 : 0);
