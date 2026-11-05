import { SETTINGS, check, png } from "../audit-fixtures.mjs";

const csv = 'Name,Notes,Value\nAda,"quoted, value",=1+1\nLin,"two\nlines",<img src=x onerror=alert(1)>\n';
const longCsv = "Name,Score\n" + Array.from({ length: 1100 }, (_, n) => `Student ${n},${n}`).join("\n");
const files = {
  "attachments/plot.png": { kind: "image", mediaType: "image/png", b64: png(960, 640).toString("base64") },
  "data/results.csv": { kind: "text", text: csv },
  "data/large.csv": { kind: "text", text: longCsv },
  "notes/plain.txt": { kind: "text", text: "First line\n<script>window.previewExecuted = true</script>\nFinal line" },
};
const links = Object.keys(files).concat("notes/retry.txt").map((path) => `[${path}](${path})`).join("\n\n");
async function open(page, path, ready) {
  await page.click(`[data-view-file="${path}"]`);
  await page.waitForSelector(`[data-file-viewer] ${ready}`, { timeout: 8000 });
}
async function close(page, path) {
  await page.keyboard.press("Escape");
  await page.waitForFunction((path) => !document.querySelector("[data-file-viewer]") && document.activeElement?.getAttribute("data-view-file") === path, { timeout: 4000 }, path);
}

export default [{
  name: "vic-rich-file-previews",
  mock: { settings: SETTINGS, files, threads: { school: [{ role: "user", text: "Open these files." }, { role: "assistant", text: links }] } },
  async run(page, h) {
    await page.waitForSelector('[data-view-file="attachments/plot.png"]');
    await open(page, "attachments/plot.png", ".ui-preview-image img");
    await page.waitForFunction(() => document.querySelector(".ui-preview-image img")?.naturalWidth === 960);
    check(await page.$eval(".ui-preview-image img", (img) => img.src.startsWith("blob:") && img.alt === "plot.png"), "image uses the upstream safe Blob renderer with its file label");
    await page.click('[aria-label="Zoom in"]');
    await page.waitForSelector(".ui-preview-image-viewport.is-zoomed");
    await page.focus(".ui-preview-image-viewport");
    await page.keyboard.press("ArrowRight");
    check(await page.$eval(".ui-preview-image img", (img) => getComputedStyle(img).transform !== "none"), "image zoom and pan controls act on the rendered image");
    await page.click('[aria-label="Fit image"]');
    await page.waitForFunction(() => !document.querySelector(".ui-preview-image-viewport.is-zoomed"));
    await h.shot("image-fit");
    await close(page, "attachments/plot.png");

    await open(page, "data/results.csv", ".ui-preview-table");
    const table = await page.$eval(".ui-preview-table", (table) => ({ rows: table.rows.length, text: table.textContent, active: !!table.querySelector("img,script,iframe") }));
    check(table.rows === 3 && table.text.includes("quoted, value") && table.text.includes("two\nlines") && table.text.includes("=1+1") && !table.active, "CSV preserves quoted records and renders formula/HTML-looking cells as inert text", JSON.stringify(table));
    check((await page.$$("[data-file-viewer] [aria-label='File actions']")).length === 1, "file actions use the shared Vic toolbar");
    await h.shot("csv");
    await close(page, "data/results.csv");

    await open(page, "data/large.csv", ".ui-preview-text-notice");
    check(await page.$eval(".ui-preview-table", (table) => table.rows.length <= 1000), "large CSV stays within the upstream row budget");
    await close(page, "data/large.csv");

    await open(page, "notes/plain.txt", ".ui-preview-text-line");
    check(await page.$eval(".ui-preview-text", (text) => text.querySelectorAll(".ui-preview-text-line").length === 3 && text.textContent.includes("<script>") && !text.querySelector("script")), "plain text has numbered lines without executing markup");
    check(!await page.evaluate(() => window.previewExecuted), "preview text has no script side effect");
    await h.shot("text");
    await close(page, "notes/plain.txt");

    await open(page, "notes/retry.txt", "[data-viewer-error]");
    await page.evaluate(() => { window.__MOCK__.files["notes/retry.txt"] = { kind: "text", text: "Recovered file" }; });
    await page.click("[data-viewer-error] button");
    await page.waitForFunction(() => document.querySelector(".ui-preview-text")?.textContent.includes("Recovered file"));
    check(await page.evaluate(() => window.__calls.filter(([cmd, args]) => cmd === "file_view" && args.path === "notes/retry.txt").length === 2), "retry re-enters Phaethon's permission-aware loader exactly once");
    await close(page, "notes/retry.txt");
  },
}];
