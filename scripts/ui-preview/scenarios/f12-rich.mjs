// Rich output (Team Rich output): math, diagrams, LaTeX documents and figures in replies, and files
// shown in the app. Behaviour checks: check(...) fails the run.
//   f12-math          inline and display math ($ and \( \[ ), MathML kept for screen readers, a wide formula
//                     scrolls in its own focusable box (the page never does), money stays money, code is
//                     untouched, a formula KaTeX can't read shows its source; the user's own math too
//   f12-stream        a half-written $$ block while the reply streams shows nothing broken, then the formula
//   f12-mermaid       a diagram drawn in the app's colours, an image named by its kind, its source one fold
//                     below; a broken one says so in words and shows its source
//   f12-latex-card    a LaTeX document as a card: View shows the compiled PDF in the app (pages, selectable
//                     text, zoom by button and key), Escape returns focus to View; Save to space says what it saved
//   f12-latex-error   a document with an error: View says what's wrong in plain words, with the log
//   f12-latex-none    no LaTeX installed: the card says how to install it and still shows the source
//   f12-tikz          a ```tikz figure drawn as a picture in the reply; it opens larger in the viewer
//   f12-viewer        links in a reply open the viewer: Markdown (with math), a PDF, a picture, code, a file
//                     it can't show (Open in its app, Show in Finder), and a path outside the space refused
//   f12-attachment    a file sent with a message opens in the viewer from its chip
//   f12-keyboard      Tab to a file link, Enter opens the viewer (named by the file), Escape closes it and
//                     focus is back on the link
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SETTINGS, check, park, png } from "../audit-fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const b64 = (name) => readFileSync(join(here, "../fixtures", name)).toString("base64");
const PDFS = { doc: b64("m301-study-guide.pdf"), fig: b64("vector-figure.pdf") };
const GUIDE = readFileSync(join(here, "../../../src-tauri/tests/fixtures/m301-study-guide.tex"), "utf8");

const shown = "[data-space-pane][data-shown]";
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const waitFor = (page, fn, arg, timeout = 5000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const reply = (text) => [{ role: "user", text: "Show me." }, { role: "assistant", text }];
const noPageScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const MATH = [
  "The area under $y = x^2$ from $0$ to $1$ is \\(\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\\).",
  "",
  "\\[ \\det\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} = ad - bc \\]",
  "",
  "$$",
  "\\sum_{k=1}^{n} k^2 = \\frac{n(n+1)(2n+1)}{6} \\quad\\text{and}\\quad \\sum_{k=1}^{n} k^3 = \\left(\\frac{n(n+1)}{2}\\right)^2 \\quad\\text{and}\\quad e^{i\\pi} + 1 = 0 \\quad\\text{and}\\quad \\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}",
  "$$",
  "",
  "The book costs $5 and the calculator $7.",
  "",
  "A formula with a typo: $\\frac{1}{$ stays readable.",
  "",
  "```latex",
  "\\(x\\) and $$y$$ stay as written in code",
  "```",
].join("\n");

const MERMAID = [
  "Here is how row reduction goes:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A[Augmented matrix] --> B{Pivot in column?}",
  "  B -- yes --> C[Eliminate below]",
  "  B -- no --> D[Next column]",
  "  C --> E[Echelon form]",
  "  D --> E",
  "```",
  "",
  "And one with a mistake:",
  "",
  "```mermaid",
  "flowchart LR",
  "  A --> --> B ((",
  "```",
].join("\n");

const DOC = `Here is your study guide:\n\n\`\`\`latex\n${GUIDE}\`\`\`\n\nIt has a vector diagram, a transformation and a plotted polynomial.`;
const BROKEN = "```latex\n\\documentclass{article}\n\\title{Broken notes}\n\\begin{document}\n\\undefinedcommand\n\\end{document}\n```";
const TIKZ = [
  "The vectors $\\mathbf{u}$ and $\\mathbf{v}$ add head to tail:",
  "",
  "```tikz",
  "\\begin{tikzpicture}[>=Stealth]",
  "\\draw[->] (0,0) -- (2,1) node[right] {$\\mathbf{u}$};",
  "\\draw[->] (0,0) -- (1,2) node[above] {$\\mathbf{v}$};",
  "\\draw[dashed] (2,1) -- (3,3) -- (1,2);",
  "\\draw[->, thick] (0,0) -- (3,3) node[above right] {$\\mathbf{u}+\\mathbf{v}$};",
  "\\end{tikzpicture}",
  "```",
  "",
  "The diagonal is $\\mathbf{u}+\\mathbf{v}$.",
].join("\n");

const FILES = {
  "notes/week6.md": { kind: "markdown", text: "# Week 6\n\nEigenvalues solve $\\det(A - \\lambda I) = 0$.\n\nSee [the guide](../documents/guide.pdf)." },
  "documents/guide.pdf": { kind: "pdf", mediaType: "application/pdf", b64: PDFS.doc },
  "attachments/whiteboard.png": { kind: "image", mediaType: "image/png", b64: png(96, 64).toString("base64") },
  "code/fact.py": { kind: "text", language: "python", text: "def fact(n):\n    return 1 if n == 0 else n * fact(n - 1)\n" },
  "essay.docx": { kind: "other", mediaType: "application/octet-stream", size: 48213 },
};
const LINKS = [
  "Your files:",
  "",
  "- [Week 6 notes](notes/week6.md)",
  "- [the study guide](documents/guide.pdf)",
  "- [whiteboard photo](attachments/whiteboard.png)",
  "- [factorial](code/fact.py)",
  "- [essay](essay.docx)",
  "- [work's secret](../work/secret.md)",
  "- [the syllabus online](https://example.edu/m301)",
].join("\n");

/** Open the viewer by clicking `sel`, wait for its body to settle on `ready`. */
async function openViewer(page, sel, ready) {
  await page.click(sel);
  await page.waitForSelector(`[data-file-viewer] ${ready}`, { timeout: 8000 });
}
const closeViewer = async (page) => {
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[data-file-viewer]"), { timeout: 3000 });
};
/** The dialog's accessible name and description. */
const dialogNames = (page) =>
  page.$eval('[role="dialog"]', (d) => [
    document.getElementById(d.getAttribute("aria-labelledby"))?.textContent,
    document.getElementById(d.getAttribute("aria-describedby"))?.textContent,
  ]);
/** Wait until the viewer's PDF has drawn its first page and laid its text over it. */
const pdfDrawn = (page) =>
  waitFor(page, () => {
    const p = document.querySelector("[data-file-viewer] [data-pdf-page='1']");
    const c = p?.querySelector("canvas");
    return !!c && c.width > 0 && p.querySelectorAll(".textLayer span").length > 5;
  }, undefined, 10000);

export default [
  {
    name: "f12-math",
    mock: { settings: SETTINGS, threads: { school: [{ role: "user", text: "Is $x^2 \\ge 0$ always?" }, { role: "assistant", text: MATH }] } },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-role="assistant"] .katex`, { timeout: 8000 });
      const m = await page.evaluate((S) => {
        const reply = document.querySelector(`${S} [data-role="assistant"]`);
        const user = document.querySelector(`${S} [data-role="user"]`);
        return {
          inline: reply.querySelectorAll(".katex:not(.katex-display .katex)").length,
          display: reply.querySelectorAll(".katex-display").length,
          mathml: reply.querySelectorAll(".katex-mathml math").length,
          userMath: user.querySelectorAll(".katex").length,
          error: reply.querySelector(".katex-error")?.textContent ?? "",
          code: reply.querySelector("pre code")?.textContent ?? "",
          text: reply.innerText,
          box: [...reply.querySelectorAll("[data-math-display]")].map((b) => ({ tab: b.tabIndex, role: b.getAttribute("role"), name: b.getAttribute("aria-label"), wide: b.scrollWidth > b.clientWidth + 1 })),
        };
      }, shown);
      check(m.inline >= 4, "inline math from $…$ and \\(…\\) is drawn", JSON.stringify(m.inline));
      check(m.display === 2, "display math from \\[…\\] and $$…$$ is drawn", String(m.display));
      check(m.mathml >= 6, "each formula keeps its MathML for screen readers", String(m.mathml));
      check(m.userMath === 1, "the user's own message gets math too");
      check(m.text.includes("$5 and the calculator $7"), "money stays money", m.text.slice(m.text.indexOf("book"), m.text.indexOf("book") + 50));
      check(m.code.includes("\\(x\\) and $$y$$"), "math in code is left as written", m.code);
      check(m.error.includes("\\frac{1}{"), "a formula KaTeX can't read shows its source", m.error);
      check(m.box.every((b) => b.tab === 0 && b.role === "group" && b.name === "Formula"), "display math is a focusable group named Formula", JSON.stringify(m.box));
      check(await noPageScroll(page), "the page itself never scrolls sideways");
      const w = await page.evaluate(() => window.innerWidth);
      if (w <= 800) check(m.box.some((b) => b.wide), "the wide formula scrolls inside its box at this width", JSON.stringify(m.box));
      await park(page);
      await h.shot("math");
    },
  },
  {
    name: "f12-stream",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, holdOpen: true, turn: [{ kind: "text", delta: "The sum is:\n\n$$\n\\sum_{k=1}^{n} k = \\frac{n(n+" }] },
    async run(page, h) {
      await h.send("Sum of 1 to n?");
      check(await waitFor(page, () => document.body.innerText.includes("The sum is:")), "the reply starts");
      await h.idle();
      const half = await page.evaluate((S) => {
        const r = [...document.querySelectorAll(`${S} [data-role="assistant"]`)].pop();
        return { text: r.innerText, katex: r.querySelectorAll(".katex").length, error: r.querySelectorAll(".katex-error").length };
      }, shown);
      check(!half.text.includes("$$") && !half.text.includes("\\frac") && half.katex === 0 && half.error === 0, "a half-written $$ block shows nothing half-made while it streams", JSON.stringify(half));
      await h.shot("half");
      await page.evaluate(() => {
        window.__liveTurn.send({ kind: "text", delta: "1)}{2}\n$$\n\nDone." });
        window.__liveTurn.send({ kind: "end", sessionId: null });
        window.__liveTurn = null;
      });
      check(await waitFor(page, (S) => [...document.querySelectorAll(`${S} [data-role="assistant"]`)].pop()?.querySelector(".katex-display") !== null, shown), "once the block closes the formula is drawn");
      const done = await page.evaluate((S) => [...document.querySelectorAll(`${S} [data-role="assistant"]`)].pop().querySelectorAll(".katex-error").length, shown);
      check(done === 0, "and nothing failed along the way");
    },
  },
  {
    name: "f12-mermaid",
    mock: { settings: SETTINGS, threads: { school: reply(MERMAID) } },
    async run(page, h) {
      check(await waitFor(page, () => document.querySelector("[data-mermaid-figure] svg"), undefined, 15000), "the diagram is drawn");
      const d = await page.evaluate(() => {
        const fig = document.querySelector("[data-mermaid-figure]");
        return {
          role: fig.getAttribute("role"),
          name: fig.getAttribute("aria-label"),
          desc: document.getElementById(fig.getAttribute("aria-describedby"))?.textContent,
          nodes: fig.querySelectorAll("g.node").length,
          scripts: fig.querySelectorAll("script").length,
          problem: document.querySelector("[data-mermaid-problem]")?.textContent ?? "",
          problemSource: document.querySelector("[data-mermaid-problem]")?.closest("figure")?.querySelector("pre")?.textContent ?? "",
          summary: [...document.querySelectorAll("[data-mermaid] summary")].map((s) => s.textContent),
        };
      });
      check(d.role === "img" && d.name === "Flowchart", "the diagram is an image named by its kind", JSON.stringify(d));
      check(/source/.test(d.desc ?? ""), "its description says where its source is", d.desc);
      check(d.nodes >= 4 && d.scripts === 0, "it has its boxes and no scripts", JSON.stringify(d));
      check(/couldn’t be drawn/.test(d.problem) && d.problemSource.includes("A --> --> B"), "the broken one says so and shows its source", JSON.stringify(d));
      check(d.summary.includes("Show the diagram’s source"), "the source is one fold below", JSON.stringify(d.summary));
      // The source opens with the keyboard.
      await page.focus("[data-mermaid] summary");
      await page.keyboard.press("Enter");
      check(await waitFor(page, () => document.querySelector("[data-mermaid] details")?.open), "Enter opens the source");
      check(await noPageScroll(page), "the page never scrolls sideways");
      await park(page);
      await h.shot("diagram");
    },
  },
  {
    name: "f12-latex-card",
    mock: { settings: SETTINGS, threads: { school: reply(DOC) }, pdfs: PDFS },
    async run(page, h) {
      await page.waitForSelector("[data-latex-card]", { timeout: 8000 });
      const card = await page.$eval("[data-latex-card]", (c) => ({ name: c.getAttribute("aria-label"), title: c.querySelector("[data-latex-title]")?.textContent, header: !!c.closest("[data-role]")?.querySelector("[data-code-wrap]") }));
      check(card.name === "LaTeX document: M301 Linear Algebra: Exam Study Guide" && card.title === "M301 Linear Algebra: Exam Study Guide", "the card is named by the document's title", JSON.stringify(card));
      check(!card.header, "no code bar over the card");
      await park(page);
      await h.shot("card");
      await page.waitForSelector("[data-latex-view]:not([disabled])", { timeout: 3000 });
      await page.focus("[data-latex-view]");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-file-viewer] [data-pdf-view]", { timeout: 8000 });
      check(await pdfDrawn(page), "View shows the compiled PDF in the app, its text laid over the page");
      const v = await page.evaluate(() => ({
        pages: document.querySelector("[data-pdf-pages]")?.textContent,
        sections: [...document.querySelectorAll("[data-pdf-page]")].map((s) => s.getAttribute("aria-label")),
        text: document.querySelector("[data-pdf-page='1'] .textLayer")?.textContent ?? "",
      }));
      const [title, desc] = await dialogNames(page);
      check(title === "M301 Linear Algebra: Exam Study Guide" && /LaTeX document as a PDF, made with pdfLaTeX/.test(desc ?? ""), "the viewer is named by the document and says what it shows", JSON.stringify([title, desc]));
      check(v.pages === "3 pages" && v.sections[0] === "Page 1 of 3", "it says how many pages, and each page is named", JSON.stringify(v));
      check(v.text.includes("Vectors and linear combinations"), "the page's text is there to select and read", v.text.slice(0, 120));
      const compiled = await calls(page, "latex_compile");
      check(compiled.length === 1 && compiled[0].figure === false && compiled[0].source.includes("\\documentclass"), "the document was compiled once", JSON.stringify(compiled.map((c) => c.figure)));
      // Zoom: a button, then the + key on the pages.
      await page.click("[data-pdf-zoom-in]");
      check(await waitFor(page, () => document.querySelector("[data-pdf-zoom]")?.dataset.pdfZoom === "125"), "Zoom in makes it 125%");
      await page.focus("[data-pdf-pages-box]");
      await page.keyboard.press("-");
      check(await waitFor(page, () => document.querySelector("[data-pdf-zoom]")?.dataset.pdfZoom === "100"), "- on the pages zooms back out");
      await h.shot("viewer");
      await closeViewer(page);
      check(await page.evaluate(() => document.activeElement?.hasAttribute("data-latex-view")), "Escape closes it and focus is back on View");
      // Save to space.
      await page.click("[data-latex-save]");
      await page.waitForSelector("[data-latex-saved]", { timeout: 4000 });
      const said = await page.$eval("[data-latex-saved]", (p) => p.textContent);
      const saved = await calls(page, "latex_save");
      check(saved.length === 1 && saved[0].space === "school" && saved[0].title === "M301 Linear Algebra: Exam Study Guide", "Save to space saves into this space", JSON.stringify(saved.map((s) => [s.space, s.title])));
      check(/Saved documents\/m301-linear-algebra-exam-study-guide\.tex and documents\/m301-linear-algebra-exam-study-guide\.pdf\./.test(said), "and says what it saved", said);
      await park(page);
      await h.shot("saved");
    },
  },
  {
    name: "f12-latex-error",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: { school: reply(BROKEN) }, pdfs: PDFS },
    async run(page, h) {
      await page.waitForSelector("[data-latex-view]:not([disabled])", { timeout: 8000 });
      await page.click("[data-latex-view]");
      await page.waitForSelector("[data-file-viewer] [data-latex-problem='failed']", { timeout: 6000 });
      const p = await page.$eval("[data-latex-problem]", (d) => ({ alert: d.querySelector('[role="alert"]')?.textContent, summaries: [...d.querySelectorAll("summary")].map((s) => s.textContent) }));
      check(/doesn’t know the command \\undefinedcommand \(line 4\)/.test(p.alert ?? ""), "it says what's wrong in plain words, with the line", p.alert);
      check(p.summaries.includes("Show LaTeX’s log") && p.summaries.includes("Show the document’s source"), "the log and the source are one fold away", JSON.stringify(p.summaries));
      await h.shot("error");
    },
  },
  {
    name: "f12-latex-none",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: SETTINGS, threads: { school: reply(DOC) }, latex: { noEngine: true } },
    async run(page, h) {
      await page.waitForSelector("[data-latex-no-engine]", { timeout: 8000 });
      const c = await page.$eval("[data-latex-card]", (c) => ({ said: c.querySelector("[data-latex-no-engine]")?.textContent, view: !!c.querySelector("[data-latex-view]"), save: !!c.querySelector("[data-latex-save]"), summary: c.querySelector("summary")?.textContent }));
      check(/no LaTeX on this computer/.test(c.said) && /MacTeX/.test(c.said) && /TeX Live/.test(c.said) && /tectonic/.test(c.said), "it says LaTeX isn't installed and how to get it", c.said);
      check(!c.view && c.save && c.summary === "Show the document’s source", "View is gone; the source can still be saved and shown", JSON.stringify(c));
      check(await noPageScroll(page), "the page never scrolls sideways");
      await park(page);
      await h.shot("none");
    },
  },
  {
    name: "f12-tikz",
    mock: { settings: SETTINGS, threads: { school: reply(TIKZ) }, pdfs: PDFS },
    async run(page, h) {
      check(await waitFor(page, () => document.querySelector("[data-tikz-figure='drawn'] img")?.naturalWidth > 0, undefined, 10000), "the figure is drawn as a picture in the reply");
      const f = await page.$eval("[data-tikz-open]", (b) => ({ name: b.getAttribute("aria-label"), w: b.querySelector("img").naturalWidth }));
      check(/^Figure, labelled: .*u.*v/.test(f.name) && /Open it larger$/.test(f.name), "it is named by its labels and says it opens larger", f.name);
      const compiled = await calls(page, "latex_compile");
      check(compiled.length === 1 && compiled[0].figure === true, "it was compiled as a figure", JSON.stringify(compiled.map((c) => c.figure)));
      await park(page);
      await h.shot("figure");
      await page.click("[data-tikz-open]");
      await page.waitForSelector("[data-file-viewer] [data-pdf-view]", { timeout: 8000 });
      check(await waitFor(page, () => document.querySelector("[data-file-viewer] [data-pdf-page='1'] canvas")?.width > 0, undefined, 8000), "it opens larger in the viewer");
      await closeViewer(page);
    },
  },
  {
    name: "f12-viewer",
    mock: { settings: SETTINGS, threads: { school: reply(LINKS) }, files: FILES, pdfs: PDFS },
    async run(page, h) {
      await page.waitForSelector('[data-view-file="notes/week6.md"]', { timeout: 8000 });
      const ext = await page.$eval('a[href="https://example.edu/m301"]', (a) => a.target);
      check(ext === "_blank", "a web link stays a web link");
      // Markdown, with math and a link beside it.
      await openViewer(page, '[data-view-file="notes/week6.md"]', "[data-viewer-markdown] .katex");
      let [title, desc] = await dialogNames(page);
      check(title === "week6.md" && /^Markdown · .* · notes\/week6\.md$/.test(desc ?? ""), "Markdown opens, named by the file", JSON.stringify([title, desc]));
      const inner = await page.$eval("[data-viewer-markdown] [data-view-file]", (b) => b.dataset.viewFile);
      check(inner === "documents/guide.pdf", "a link inside it leads beside it (../documents/guide.pdf)", inner);
      await h.shot("markdown");
      await closeViewer(page);
      // A PDF.
      await openViewer(page, '[data-view-file="documents/guide.pdf"]', "[data-pdf-view]");
      check(await pdfDrawn(page), "a PDF opens with its text over its pages");
      await h.shot("pdf");
      await closeViewer(page);
      // A picture.
      await openViewer(page, '[data-view-file="attachments/whiteboard.png"]', "[data-viewer-image]");
      const img = await page.$eval("[data-viewer-image]", (i) => ({ alt: i.alt, ok: i.naturalWidth === 96 }));
      check(img.alt === "whiteboard.png" && img.ok, "a picture opens, named by the file", JSON.stringify(img));
      await closeViewer(page);
      // Code, with its language.
      await openViewer(page, '[data-view-file="code/fact.py"]', "pre");
      const code = await page.$eval("[data-file-viewer] pre", (p) => ({ text: p.textContent, name: p.getAttribute("aria-label") }));
      [title, desc] = await dialogNames(page);
      check(code.text.includes("def fact(n)") && code.name === "fact.py" && /^Python · /.test(desc ?? ""), "code opens as code", JSON.stringify([code, desc]));
      await h.shot("code");
      await closeViewer(page);
      // A file it can't show: say so, and offer its app and Finder.
      await openViewer(page, '[data-view-file="essay.docx"]', "[data-viewer-other]");
      const other = await page.$eval("[data-file-viewer]", (d) => ({ text: d.querySelector("[data-viewer-other]").textContent, app: !!d.querySelector("[data-viewer-open-app]"), reveal: d.querySelector("[data-viewer-reveal]")?.textContent }));
      check(/can’t show this kind of file/.test(other.text) && other.app && other.reveal === "Show in Finder", "an unsupported file says so, with Open in its app and Show in Finder", JSON.stringify(other));
      await page.click("[data-viewer-open-app]");
      const opened = await calls(page, "file_open");
      check(opened.at(-1)?.path === "essay.docx" && opened.at(-1)?.reveal === false, "Open in its app opens it with its app", JSON.stringify(opened));
      await h.shot("other");
      await closeViewer(page);
      // Outside the space: refused by the core, said plainly.
      await openViewer(page, '[data-view-file="../work/secret.md"]', "[data-viewer-error]").catch(() => {});
      const refused = await page.$eval("[data-viewer-error]", (p) => p.textContent).catch(() => "");
      const vcalls = await calls(page, "file_view");
      check(/Only files in this space/.test(refused) || !vcalls.some((c) => c.path.includes("secret")), "a path outside the space is refused", refused);
      await closeViewer(page).catch(() => {});
      await park(page);
    },
  },
  {
    name: "f12-attachment",
    sizes: [[1100, 720]],
    mock: {
      settings: SETTINGS,
      threads: { school: [{ role: "user", text: "Here's the board.", attachments: [{ name: "whiteboard.png", path: "attachments/whiteboard.png", mediaType: "image/png" }] }, { role: "assistant", text: "Thanks." }] },
      files: FILES,
    },
    async run(page, h) {
      await page.waitForSelector("[data-view-attachment]", { timeout: 8000 });
      // Its name as a screen reader hears it: the text that isn't aria-hidden.
      const name = await page.$eval("[data-view-attachment]", (b) => {
        const c = b.cloneNode(true);
        c.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
        return c.textContent.replace(/\s+/g, " ").trim();
      });
      check(/^whiteboard\.png, PNG.*, open in the viewer$/.test(name), "the chip is named by the file and says it opens in the viewer", name);
      await openViewer(page, "[data-view-attachment]", "[data-viewer-image]");
      const viewed = await calls(page, "file_view");
      check(viewed.at(-1)?.path === "attachments/whiteboard.png" && viewed.at(-1)?.space === "school", "a sent file opens from where it is saved in the space", JSON.stringify(viewed));
      await h.shot("attachment");
      await closeViewer(page);
    },
  },
  {
    name: "f12-keyboard",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: { school: reply(LINKS) }, files: FILES, pdfs: PDFS },
    async run(page, h) {
      await page.waitForSelector('[data-view-file="notes/week6.md"]', { timeout: 8000 });
      await page.focus("[data-composer-input]");
      // Shift+Tab back from the composer into the reply until the first file link has focus.
      for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => document.activeElement?.dataset?.viewFile === "notes/week6.md")) break;
        await page.keyboard.down("Shift");
        await page.keyboard.press("Tab");
        await page.keyboard.up("Shift");
      }
      check(await page.evaluate(() => document.activeElement?.dataset?.viewFile === "notes/week6.md"), "the file link takes focus by keyboard");
      const role = await page.evaluate(() => [document.activeElement.tagName, document.activeElement.textContent]);
      check(role[0] === "BUTTON" && role[1] === "Week 6 notes", "it is a button named by its text", JSON.stringify(role));
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-file-viewer] [data-viewer-markdown]", { timeout: 5000 });
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      check(inside, "Enter opens the viewer and focus moves into it");
      const [title] = await dialogNames(page);
      check(title === "week6.md", "the dialog is named by the file", title);
      await closeViewer(page);
      check(await page.evaluate(() => document.activeElement?.dataset?.viewFile === "notes/week6.md"), "Escape closes it and focus is back on the link");
    },
  },
];
