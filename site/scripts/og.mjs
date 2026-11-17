// The social preview (site/public/og.jpg): the live page's hero art and app
// window, recomposed at 1200x630 with the headline. Serve a build first:
//   pnpm site:build && pnpm exec vite preview --config site/vite.config.ts --port 5181
//   node site/scripts/og.mjs [url]   (then: sips -s format jpeg site/public/og.png --out site/public/og.jpg)
import path from "node:path";
import { chromium } from "@playwright/test";
const url = process.argv[2] ?? "http://localhost:5181/";
const out = path.resolve(import.meta.dirname, "../public/og.png");
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 2, colorScheme: "light", reducedMotion: "reduce" });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.evaluate(() => {
  const art = document.querySelector("[data-stage]");
  const card = document.createElement("div");
  card.style.cssText = "position:fixed;inset:0;z-index:999;background:var(--background)";
  art.style.cssText = "position:absolute;inset:0;height:auto;mask-image:none;z-index:auto";
  const win = document.querySelector("[data-window]");
  win.style.cssText = "position:absolute;left:46%;top:16%;width:86%;margin:0;border-radius:12px 0 0 0";
  art.append(win);
  const text = document.createElement("div");
  text.style.cssText = "position:absolute;z-index:2;left:64px;top:64px;bottom:64px;width:440px;display:flex;flex-direction:column;justify-content:space-between";
  const mark = document.querySelector("header a").cloneNode(true);
  mark.style.cssText = "zoom:1.7;align-self:flex-start";
  const h = document.createElement("h1");
  h.textContent = "The AI you choose, in a workspace you own.";
  h.style.cssText = "margin:0;font-size:54px;font-weight:500;line-height:1.04;letter-spacing:-0.04em;color:var(--foreground);text-wrap:balance";
  const foot = document.createElement("p");
  foot.textContent = "Open source · macOS, Windows, Linux · phaethon.app";
  foot.style.cssText = "margin:0;white-space:nowrap;font-size:18px;color:oklch(30% 0 0 / 70%)";
  const top = document.createElement("div");
  top.style.cssText = "display:flex;flex-direction:column;gap:40px";
  top.append(mark, h);
  text.append(top, foot);
  art.append(text);
  card.append(art);
  document.body.append(card);
});
await page.waitForTimeout(1500);
await page.screenshot({ path: out, scale: "css" });
await browser.close();
