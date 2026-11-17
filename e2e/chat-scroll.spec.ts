import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, startCore, test, type Core } from "./core";

/**
 * A very long conversation against the real core: clicking onto it lands at
 * its end on the first frame it shows, nothing moves while it finishes laying
 * out (older turns mounting, code, math, diagrams), and leaving it scrolled up
 * and coming back (another conversation, another tab) finds the same place.
 */

let core: Core | undefined;
test.afterEach(async () => {
  await core?.stop();
  core = undefined;
});

const TURNS = 300;
/** features/chat/timeline-scroll.ts: the longest a first open stays unseen while its last screen draws. */
const REVEAL_WAIT_MS = 600;
const nav = (page: Page) => page.getByRole("navigation", { name: "Spaces and conversations" });
const BOX = '[data-page="chat"]:not([data-inactive]) [data-slot="chat-scroll"]';
const prose = "Each step is small enough to check on its own, and says why it follows before the next one starts. ";

function reply(i: number): string {
  const parts = [`**Turn ${i + 1}.** ${prose.repeat(2 + (i % 4))}`];
  if (i % 5 === 0) parts.push("```python\n" + Array.from({ length: 4 + (i % 7) }, (_, k) => `def step_${k}(n):\n    return n * ${k}`).join("\n") + "\n```");
  if (i % 5 === 1) parts.push(`$$\\sum_{k=1}^{${i + 2}} k = \\frac{n(n+1)}{2}$$\n\nAnd inline, $f(a) = f(b) \\Rightarrow a = b$.`);
  if (i % 5 === 2) parts.push("| Step | Claim |\n|---|---|\n| 1 | base case |\n| 2 | inductive step |");
  if (i % 60 === 7) parts.push("```mermaid\nflowchart LR\n  a[Base case] --> b[Hypothesis] --> c[Step] --> d[Done]\n```");
  // The newest reply ends with a tall diagram: the end itself grows after the first paint.
  if (i === TURNS - 1) parts.push("```mermaid\nflowchart TD\n  a[Claim] --> b[Base case]\n  a --> c[Inductive step]\n  b --> d[Check]\n  c --> d\n  d --> e[Done]\n```");
  parts.push(`So case ${i + 1} holds.`);
  return parts.join("\n\n");
}

/** A long saved conversation (older) and a short one (newest, so it opens first). */
function seed(home: string) {
  const state = path.join(home, "Phaethon", "default", "spaces", "school", ".phaethon");
  const dir = path.join(state, "threads");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(state, "space.json"), JSON.stringify({ name: "School" }));
  const long = Array.from({ length: TURNS }, (_, i) => [
    { role: "user", content: [{ type: "text", text: i === 0 ? "Long placeholder conversation about proofs" : `Placeholder question ${i + 1}` }] },
    { role: "assistant", content: [{ type: "text", text: reply(i) }] },
  ]).flat();
  const now = Date.now();
  const write = (id: string, messages: unknown[], ago: number) => {
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(messages));
    const t = new Date(now - ago);
    fs.utimesSync(file, t, t);
  };
  write("1700000000000", long, 3_600_000);
  write("1700000000001", [
    { role: "user", content: [{ type: "text", text: "Short placeholder conversation" }] },
    { role: "assistant", content: [{ type: "text", text: "A short reply." }] },
  ], 60_000);
}

/**
 * Records what is painted, frame by frame: read after layout and after the app's own corrections (a
 * ResizeObserver created later runs later in the same frame), carried over on frames without a resize.
 */
async function startRecording(page: Page) {
  await page.evaluate((sel) => {
    const w = window as unknown as { __frames: unknown[]; __stopFrames: () => void };
    const frames: { t: number; dist: number; turns: number; lastY: number | null; last: string; hidden: boolean; drawing: boolean }[] = [];
    w.__frames = frames;
    let box: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    let fresh: (typeof frames)[number] | null = null;
    let prev: (typeof frames)[number] | null = null;
    const t0 = performance.now();
    const read = () => {
      if (!box || box.clientHeight === 0) return null;
      const turns = box.querySelectorAll<HTMLElement>("[data-turn]");
      const lastTurn = turns[turns.length - 1];
      return {
        t: performance.now() - t0,
        dist: box.scrollHeight - box.scrollTop - box.clientHeight,
        turns: turns.length,
        lastY: lastTurn ? lastTurn.getBoundingClientRect().top - box.getBoundingClientRect().top : null,
        last: lastTurn?.textContent?.trim().slice(0, 40) ?? "",
        // Held unseen (a first open waiting for its last screen to finish drawing).
        hidden: (() => {
          for (let n: HTMLElement | null = lastTurn ?? null; n && n !== box; n = n.parentElement) if (n.style.opacity === "0") return true;
          return false;
        })(),
        // Something on screen still drawing (a diagram's placeholder), as the app checks before it shows a conversation.
        drawing: [...box.querySelectorAll("[data-pending]")].some((n) => {
          const r = n.getBoundingClientRect();
          const b = box!.getBoundingClientRect();
          return r.bottom > b.top && r.top < b.bottom;
        }),
      };
    };
    let on = true;
    const tick = () => {
      if (!on) return;
      const now = document.querySelector<HTMLElement>(sel);
      if (now !== box) {
        box = now;
        ro?.disconnect();
        if (box) {
          ro = new ResizeObserver(() => (fresh = read()));
          ro.observe(box);
          for (const c of box.children) ro.observe(c);
        }
        fresh = read();
      }
      const f = fresh ?? (prev ? { ...prev, t: performance.now() - t0 } : read());
      fresh = null;
      if (f) frames.push(f);
      prev = f;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    w.__stopFrames = () => {
      on = false;
      ro?.disconnect();
    };
  }, BOX);
}

async function stopRecording(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __frames: { t: number; dist: number; turns: number; lastY: number | null; last: string; hidden: boolean; drawing: boolean }[]; __stopFrames: () => void };
    w.__stopFrames();
    return w.__frames;
  });
}

/** Resolves once the conversation's scroll position has held still for 300 ms. */
async function settled(page: Page) {
  let last = -1;
  let still = 0;
  for (let i = 0; i < 100 && still < 3; i++) {
    const y = await page.evaluate((sel) => document.querySelector<HTMLElement>(sel)!.scrollTop, BOX);
    still = y === last ? still + 1 : 0;
    last = y;
    await page.waitForTimeout(100);
  }
}

/** The first user turn whose top is on screen, and where it sits. */
function readingPlace(page: Page) {
  return page.evaluate((sel) => {
    const box = document.querySelector<HTMLElement>(sel)!;
    const top = box.getBoundingClientRect().top;
    const t = [...box.querySelectorAll<HTMLElement>("[data-turn]")].find((el) => el.getBoundingClientRect().top - top > 0)!;
    return { text: t.textContent!.trim().slice(0, 40), y: Math.round(t.getBoundingClientRect().top - top) };
  }, BOX);
}

function placeOf(page: Page, text: string) {
  return page.evaluate(
    ({ sel, text }) => {
      const box = document.querySelector<HTMLElement>(sel)!;
      const t = [...box.querySelectorAll<HTMLElement>("[data-turn]")].find((el) => el.textContent!.trim().startsWith(text))!;
      return Math.round(t.getBoundingClientRect().top - box.getBoundingClientRect().top);
    },
    { sel: BOX, text },
  );
}

test("a very long conversation opens at its end, holds still, and keeps a reader's place", async ({ page }) => {
  test.setTimeout(120_000);
  core = await startCore({ setup: seed });
  await core.open(page);
  const sidebar = nav(page);
  await expect(page.getByText("A short reply.")).toBeVisible();

  // Click onto the long conversation and record every frame from the click.
  await startRecording(page);
  await sidebar.getByRole("button", { name: /^Long placeholder conversation/ }).click();
  await expect(page.locator(BOX).getByText(`Placeholder question ${TURNS}`, { exact: true })).toBeVisible();
  // Older turns mount above, a step per frame, until every turn is there.
  await expect(page.locator(`${BOX} [data-turn]`)).toHaveCount(TURNS, { timeout: 30_000 });
  await page.waitForTimeout(1500);
  const frames = await stopRecording(page);
  const shown = frames.filter((f) => f.last.startsWith(`Placeholder question ${TURNS}`) && !f.hidden);
  expect(shown.length).toBeGreaterThan(10);
  // Every painted frame of it, from the first, is at the end: no visible scroll to get there.
  expect(Math.max(...shown.map((f) => f.dist))).toBeLessThanOrEqual(2);
  // Nothing moves from the first visible frame on: the diagram ending the last reply finished drawing
  // before the conversation was shown, and older turns mounting above don't shift the last one.
  // The app waits for it at most REVEAL_WAIT_MS (features/chat/timeline-scroll.ts); on a runner too slow
  // to load and draw it in that time, it must at least have waited that long before showing anything,
  // and nothing moves once it has drawn.
  if (shown[0]!.drawing) expect(shown[0]!.t).toBeGreaterThanOrEqual(REVEAL_WAIT_MS);
  const ys = shown.filter((f) => !f.drawing).map((f) => f.lastY!);
  expect(ys.length).toBeGreaterThan(10);
  expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(1);

  // Scroll up to read, leave for the other conversation, come back: the same turn in the same place.
  await page.mouse.move(760, 400);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -600);
  // Measure once the wheel has finished scrolling (a slow runner is still moving after a fixed wait).
  await settled(page);
  const reading = await readingPlace(page);
  await sidebar.getByRole("button", { name: /^Short placeholder conversation/ }).click();
  await expect(page.getByText("A short reply.")).toBeVisible();
  await sidebar.getByRole("button", { name: /^Long placeholder conversation/ }).click();
  await expect(page.locator(BOX).getByText(reading.text, { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  expect(Math.abs((await placeOf(page, reading.text)) - reading.y)).toBeLessThanOrEqual(1);
  // And it holds there while the rest of the conversation mounts around it.
  await expect(page.locator(`${BOX} [data-turn]`)).toHaveCount(TURNS, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(Math.abs((await placeOf(page, reading.text)) - reading.y)).toBeLessThanOrEqual(1);

  // A kept-alive tab: Settings opens over it (not as a tab), and Esc comes back to the place exactly.
  await page.getByRole("button", { name: /^Settings/ }).first().click();
  await expect(page.locator('[data-page="settings"]:not([data-inactive])')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(BOX)).toBeVisible();
  expect(Math.abs((await placeOf(page, reading.text)) - reading.y)).toBeLessThanOrEqual(1);

  // "Latest" goes back to the end.
  await page.getByRole("button", { name: "Jump to latest" }).click();
  await expect.poll(() => page.evaluate((sel) => { const b = document.querySelector<HTMLElement>(sel)!; return b.scrollHeight - b.scrollTop - b.clientHeight; }, BOX)).toBeLessThanOrEqual(2);
});
