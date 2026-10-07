#!/usr/bin/env node
// One shared chrome-headless-shell for several test runs at once (each run
// gets its own browser context). Prints the WebSocket endpoint, then stays up
// until killed. Use with: shoot.mjs --connect <endpoint>.
import puppeteer from "puppeteer-core";

const shell =
  process.env.PHAETHON_CHROME_SHELL ||
  `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const browser = await puppeteer.launch({
  executablePath: shell,
  headless: "shell",
  args: ["--disable-features=MacAppCodeSignClone", "--force-color-profile=srgb"],
});
console.log(browser.wsEndpoint());
const stop = async () => {
  await browser.close().catch(() => {});
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
setInterval(() => {}, 1 << 30);
