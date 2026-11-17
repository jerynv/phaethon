import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, startCore, test, type Core } from "./core";

/**
 * A LaTeX document in a reply, compiled for real inside the sandbox: it shows
 * as a PDF in the chat, and the conversation opened again shows it at once,
 * at its size, without compiling again. Needs TeX (and bubblewrap on Linux),
 * so it skips where neither is installed (CI).
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

/** A TeX bin folder with xelatex: on PATH, or TeX Live in the home folder. */
function texBin(): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) if (dir && fs.existsSync(path.join(dir, "xelatex"))) return dir;
  const root = path.join(os.homedir(), ".local", "texlive");
  for (const year of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const bin = path.join(root, year, "bin");
    for (const platform of fs.existsSync(bin) ? fs.readdirSync(bin) : []) if (fs.existsSync(path.join(bin, platform, "xelatex"))) return path.join(bin, platform);
  }
  return null;
}
const bin = texBin();
const walls = process.platform === "darwin" || fs.existsSync("/usr/bin/bwrap") || fs.existsSync("/bin/bwrap");

const DOC = String.raw`\documentclass[11pt]{article}
\usepackage{phaethon}
\reporttitle{Placeholder study guide}{Placeholder author}{\today}
\begin{document}
\makereporttitle
\section{Induction}
For every $n \in \mathbb{N}$,
\begin{align}
  \sum_{k=1}^{n} k &= \frac{n(n+1)}{2}.
\end{align}
\begin{figure}[H]
  \centering
  \begin{tikzpicture}
    \node[box] (a) {Base case};
    \node[box, right=12mm of a] (b) {Step};
    \draw[->] (a) -- node[lbl, above] {then} (b);
  \end{tikzpicture}
  \caption{The two parts of a proof by induction.}
\end{figure}
\begin{tabularx}{\linewidth}{lL}
  \toprule
  Part & Claim \\ \midrule
  Base & holds for $n = 1$ \\
  Step & $P(n) \to P(n+1)$ \\ \bottomrule
\end{tabularx}
\end{document}`;

test("a LaTeX document in a reply compiles to a PDF, and shows again at once", async ({ page }) => {
  test.skip(!bin || !walls, "needs TeX and a sandbox on this computer");
  test.setTimeout(150_000);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    core = await startCore({ script: { claude: true, steps: [{ text: `Here is the guide.\n\n\`\`\`latex\n${DOC}\n\`\`\`` }] } });
  } finally {
    process.env.PATH = saved;
  }
  await core.open(page);
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("Make me a study guide");
  await page.keyboard.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.getByText("Here is the guide.")).toBeVisible();
  // Compiled for real: a page drawn on a canvas, no compile error.
  const canvas = reply.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 120_000 });
  await expect(reply.getByText(/Didn’t compile|No TeX on this computer|Can’t compile here/)).toHaveCount(0);
  const inked = await canvas.evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) dark++;
    return { w: c.width, h: c.height, dark };
  });
  expect(inked.w).toBeGreaterThan(200);
  expect(inked.dark).toBeGreaterThan(500);
  const height = await reply.boundingBox().then((b) => Math.round(b!.height));

  // Away and back: the PDF is there at once, at its size, with nothing still drawing.
  await page.getByRole("button", { name: "New chat", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "Where should we begin?" })).toBeVisible();
  await page.getByRole("navigation", { name: "Spaces and conversations" }).getByRole("button", { name: /^Make me a study guide/ }).click();
  const again = page.locator('[data-role="assistant"]').last();
  await expect(again.locator("canvas").first()).toBeVisible({ timeout: 5_000 });
  expect(await page.locator("[data-pending]").count()).toBe(0);
  expect(Math.abs((await again.boundingBox())!.height - height)).toBeLessThanOrEqual(2);
});

/** A figure as the model writes it: a ```tikz fence with one tikzpicture in the house styles, no document around it. */
const FIGURE = String.raw`\begin{tikzpicture}[node distance=8mm and 10mm]
\node[box] (input) {$x=a v_1+b v_2$};
\node[box, right=of input] (coords) {$[x]_P=\begin{pmatrix}a\\b\end{pmatrix}$};
\node[box, right=of coords] (diag) {$D[x]_P=\begin{pmatrix}3a\\b\end{pmatrix}$};
\draw[->] (input) -- node[lbl] {$P^{-1}$} (coords);
\draw[->] (coords) -- node[lbl] {$D$} (diag);
\node[softbox, below=14mm of coords] (bad) {$C e_1=2e_1,\quad C e_2=e_1+2e_2$};
\end{tikzpicture}`;

test("a ```tikz figure in a reply is drawn as a picture, not shown as code", async ({ page }) => {
  test.setTimeout(150_000);
  const saved = process.env.PATH;
  // With TeX it must draw; without it (CI) it must still be the figure's own block, which says so, never a plain code block.
  if (bin && walls) process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  try {
    core = await startCore({ script: { claude: true, steps: [{ text: `Here is the picture.\n\n\`\`\`tikz\n${FIGURE}\n\`\`\`\n\nThe top row is diagonalization.` }] } });
  } finally {
    process.env.PATH = saved;
  }
  await core.open(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Show me diagonalization");
  await page.keyboard.press("Enter");
  const reply = page.locator('[data-role="assistant"]').last();
  await expect(reply.getByText("The top row is diagonalization.")).toBeVisible();
  if (bin && walls) {
    await expect(reply.locator("canvas").first()).toBeVisible({ timeout: 120_000 });
    await expect(reply.getByText(/Didn’t compile|No TeX on this computer|Can’t compile here/)).toHaveCount(0);
    const dark = await reply.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! < 128) n++;
      return n;
    });
    expect(dark).toBeGreaterThan(200);
  } else {
    // Drawn (TeX found in its usual place) or the figure block saying there's no TeX: either way not a plain code block.
    await expect(reply.locator("canvas").or(reply.getByText(/No TeX on this computer|Can’t compile here/)).first()).toBeVisible({ timeout: 120_000 });
  }
});
