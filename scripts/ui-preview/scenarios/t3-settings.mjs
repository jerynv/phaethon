// Settings, persona re-check round 2 (Team T). Each scenario fails unless the
// thing it names happens in the page.
//   t3-undo           Remove in Settings › Spaces has Undo, kept until Settings closes (jordan3)
//   t3-incoming       each space lists which other spaces can read it (sam3)
//   t3-radios         the assistant radios are named by their title alone (maya N3)
//   t3-words          MANUAL.md and the .phaethon folders explained in plain words (linda9)
//   t3-cli-missing    Claude Code not installed: say how to install, don't switch (linda6)
//   t3-cli-installed  installed: the radio switches as before
//   t3-word-spacing   a word-spacing control; Text comes first in Appearance (priya15, N5)
//   t3-slider-click   a click on a track steps toward it, never jumps (jordan5); Close has a tooltip
//   t3-compact        at 760x560 and 200% the header and tabs take at most a quarter of the height (tomas6)
//   t3-disclosure     space names, granted folders, and what is saved where (sam14)
//   t3-about-delete   About leads with the menu's Delete; the hidden files are folded (linda r3)
//   t3-space-folder   a space's folder in plain words, not "Folder: spaces/school" (linda r3)
import { SETTINGS, check, openSettings, park, PANEL } from "../audit-fixtures.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const css = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const panelText = (page) => page.evaluate((p) => document.querySelector(p)?.innerText ?? "", PANEL);
const status = (page) => page.evaluate(() => document.querySelector('[role="dialog"] p[role="status"]')?.textContent ?? "");
const focused = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName.toLowerCase()}|${a.getAttribute("aria-label") ?? ""}|${a.textContent?.trim().slice(0, 60) ?? ""}` : "none";
});
/** The slider thumb whose label is `label`. */
const sliderBy = (page, label) =>
  page.evaluateHandle(
    (label) =>
      [...document.querySelectorAll('[role="dialog"] [role="slider"]')].find((t) =>
        (t.getAttribute("aria-labelledby") ?? "").split(" ").some((id) => document.getElementById(id)?.textContent === label),
      ) ?? null,
    label,
  );

const CAL = { id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" };

export default [
  {
    name: "t3-undo",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, grants: { school: [CAL] } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      const row = `${PANEL} [data-space-row="school"]`;
      await page.focus(`${row} [data-revoke="g-cal"]`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${row} [data-undo="g-cal"]`, { timeout: 3000 });
      await h.idle();
      const revokes = await calls(page, "grant_revoke");
      check(revokes.length === 1 && revokes[0].id === "g-cal", "Remove takes the access away at once (grant_revoke)", JSON.stringify(revokes));
      const f = await focused(page);
      check(f.startsWith("button|Undo removing"), "focus moves to that row's Undo", f);
      const said = await status(page);
      check(/Undo/.test(said) && /already read stays/.test(said), "the status says it was removed, that what was read stays, and that Undo is there", said);
      await park(page);
      await h.shot("pending");
      // Jordan dwells about a second per target: Undo must not vanish on a timer.
      await new Promise((r) => setTimeout(r, 7000));
      check(!!(await page.$(`${row} [data-undo="g-cal"]`)), "Undo is still there after 7 seconds");
      await page.click(`${row} [data-undo="g-cal"]`);
      await page.waitForSelector(`${row} [data-revoke="g-cal"]`, { timeout: 3000 });
      await h.idle();
      const restores = await calls(page, "grant_restore");
      check(restores.length === 1 && restores[0].id === "g-cal", "Undo puts the same access back (grant_restore, the id only)", JSON.stringify(restores));
      check((await focused(page)).startsWith("button|Remove School"), "focus goes back to Remove", await focused(page));
      check(/School can read Work \/ calendar again/.test(await status(page)), "and Undo is announced", await status(page));
      // Remove again, then close Settings: the removal stands, and the row is gone on reopening.
      await page.click(`${row} [data-revoke="g-cal"]`);
      await page.waitForSelector(`${row} [data-undo="g-cal"]`, { timeout: 3000 });
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      await openSettings(page, h, "spaces");
      const text = await page.$eval(row, (el) => el.innerText);
      check(!(await page.$(`${row} [data-undo]`)) && !(await page.$(`${row} [data-revoke]`)) && /Can’t read anything outside School/.test(text), "after closing, the removal stands and Undo is gone", text.slice(0, 200));
    },
  },
  {
    name: "t3-incoming",
    sizes: [[1100, 720], [760, 560]],
    mock: { settings: SETTINGS, threads: {}, grants: { school: [CAL] } },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      const work = `${PANEL} [data-space-row="work"]`;
      const text = await page.$eval(work, (el) => el.innerText);
      check(/School\sreads\scalendar/.test(text), "Work's row says School reads its calendar", text);
      const list = await page.$eval(work, (el) => el.querySelector('ul[aria-label^="Who can read"]')?.getAttribute("aria-label"));
      check(list === "Who can read Work", "as a list named Who can read Work", list);
      const school = await page.$eval(`${PANEL} [data-space-row="school"]`, (el) => el.innerText);
      check(/No other space can read School/.test(school), "School's row says nothing reads it", school);
      await page.$eval(work, (el) => el.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("work");
      // Removing from the reading side's row works the same way (with Undo).
      await page.click(`${work} [data-revoke="g-cal"]`);
      await page.waitForSelector(`${work} [data-undo="g-cal"]`, { timeout: 3000 });
      const revokes = await calls(page, "grant_revoke");
      check(revokes.length === 1 && revokes[0].id === "g-cal", "Remove on Work's row takes School's access away", JSON.stringify(revokes));
      await park(page);
    },
  },
  {
    name: "t3-radios",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const radios = await page.$$('[role="dialog"] [data-backend]');
      check(radios.length === 2, "two assistant choices", `${radios.length}`);
      for (const r of radios) {
        const ax = await page.accessibility.snapshot({ root: r, interestingOnly: false });
        const desc = await r.evaluate((el) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim());
        console.log(`     radio: name "${ax?.name}" | description "${desc.slice(0, 60)}…"`);
        check(!!ax?.name && !!desc && !ax.name.includes(desc.slice(0, 20)), "the radio's name is its title only; the description is said once", `${ax?.name}`);
      }
    },
  },
  {
    name: "t3-words",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const d = await page.$eval("[data-disclosure]", (el) => el.innerText);
      check(/MANUAL\.md, a note in your Phaethon folder/.test(d), "Assistant says what MANUAL.md is", d);
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const about = await panelText(page);
      check(/folders named \.phaethon/.test(about) && /hidden/.test(about), "About says in a plain sentence what the .phaethon folders are", about.slice(0, 600));
      check(/MANUAL\.md/.test(about) && /how you like it to work/.test(about), "About explains MANUAL.md");
      await page.$eval("[data-files-heading]", (el) => el.scrollIntoView({ block: "start" }));
      await park(page);
    },
  },
  {
    name: "t3-cli-missing",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, claudeCli: { installed: false } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.click('[role="dialog"] [data-backend="claude-cli"]');
      await page.waitForSelector("[data-cli-missing]", { timeout: 3000 });
      await h.idle();
      const asked = await calls(page, "claude_cli_status");
      const set = await calls(page, "settings_set_backend");
      check(asked.length >= 1, "it checks whether Claude Code is installed first", `${asked.length}`);
      check(set.length === 0, "and does not switch when it isn't", JSON.stringify(set));
      const checkedNow = await page.$eval('[role="dialog"] [data-backend][data-state="checked"]', (el) => el.getAttribute("data-backend"));
      check(checkedNow === "phaethon", "the choice stays on Phaethon", checkedNow);
      const msg = await page.$eval("[data-cli-missing]", (el) => ({ text: el.innerText, link: el.querySelector("a")?.href ?? "" }));
      check(/isn’t installed on this computer/.test(msg.text) && /install/i.test(msg.text) && msg.link.startsWith("https://"), "it says Claude Code isn't installed and how to install it", JSON.stringify(msg));
      check(/isn’t installed/.test(await status(page)), "and says so in the status line", await status(page));
      await park(page);
    },
  },
  {
    // The first-run card's "Use Claude Code instead" uses the same check (setup-card.tsx calls switchToClaudeCode).
    name: "t3-cli-missing-setup",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: { ...SETTINGS, hasAnthropicKey: false }, threads: {}, claudeCli: { installed: false } },
    async run(page, h) {
      await page.waitForSelector("[data-setup-cli]", { timeout: 5000 });
      await page.$eval("[data-setup-cli]", (el) => el.scrollIntoView({ block: "center" }));
      await page.click("[data-setup-cli]");
      await page.waitForFunction(() => /isn’t installed on this computer/.test(document.body.innerText), { timeout: 3000 });
      await h.idle();
      const set = await calls(page, "settings_set_backend");
      check(set.length === 0, "the setup card does not switch when Claude Code isn't installed", JSON.stringify(set));
      check(!(await page.$("[data-setup-done]")), "and does not say it now uses Claude Code");
      const text = await page.evaluate(() => document.body.innerText);
      check(!/Error:/.test(text), "the message is plain words, no 'Error:' prefix");
      await park(page);
    },
  },
  {
    name: "t3-cli-installed",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {}, claudeCli: { installed: true, path: "/usr/local/bin/claude" } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.click('[role="dialog"] [data-backend="claude-cli"]');
      await page.waitForFunction(() => window.__calls.some(([c]) => c === "settings_set_backend"), { timeout: 3000 });
      await h.idle();
      const set = await calls(page, "settings_set_backend");
      check(set.length === 1 && set[0].backend === "claude-cli", "installed: it switches to Claude Code", JSON.stringify(set));
      check(!(await page.$("[data-cli-missing]")), "with no install message");
    },
  },
  {
    name: "t3-word-spacing",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      const groups = await page.$$eval(`${PANEL} h4`, (hs) => hs.map((x) => x.textContent));
      check(groups[0] === "Text", "Text (with the reading font) is the first group in Appearance", groups.join());
      const fontTop = await page.$eval(`${PANEL} [data-font-card]`, (el) => el.getBoundingClientRect().top);
      check(fontTop < 720 * 0.6, "the reading font shows without scrolling", `${fontTop}`);
      await h.shot("appearance");
      await h.click('[data-testid="settings-tab-accessibility"]');
      await h.idle();
      const ws = await sliderBy(page, "Word spacing");
      check(await ws.evaluate((t) => !!t), "Accessibility › Reading has a Word spacing slider");
      await ws.focus();
      await page.keyboard.press("Home");
      await h.idle();
      const low = { vt: await ws.evaluate((t) => t.getAttribute("aria-valuetext")), token: await css(page, "--ph-word-spacing") };
      check(low.token.startsWith("-") && /Tighter/.test(low.vt), "word spacing goes below zero for wide fonts", JSON.stringify(low));
      // Priya: OpenDyslexic's own space is wide, so the floor is about −0.2em, not −0.1em.
      check(parseFloat(low.token) <= -0.2 && low.token.endsWith("em"), "word spacing goes down to −0.2em", JSON.stringify(low));
      await page.keyboard.press("End");
      await h.idle();
      const high = await page.evaluate(() => ({
        token: getComputedStyle(document.documentElement).getPropertyValue("--ph-word-spacing").trim(),
        body: getComputedStyle(document.querySelector('[role="dialog"] h3')).wordSpacing,
        sample: getComputedStyle(document.querySelector("[data-reading-sample]")).wordSpacing,
      }));
      check(parseFloat(high.token) >= 0.16, "and up to at least 0.16em (WCAG 1.4.12)", JSON.stringify(high));
      check(parseFloat(high.body) > 0 && parseFloat(high.sample) > 0, "it applies to all text, the sample too", JSON.stringify(high));
      await new Promise((r) => setTimeout(r, 900));
      const saved = (await calls(page, "appearance_set")).at(-1)?.appearance?.tokens ?? {};
      check(typeof saved["--ph-word-spacing"] === "string" && saved["--ph-word-spacing"].endsWith("em"), "it is saved with the appearance", JSON.stringify(saved));
      await ws.evaluate((t) => t.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("wide");
      // The page's Reset puts it back.
      await page.$$eval('[role="dialog"] button', (bs) => bs.find((b) => /Reset/.test(b.textContent) && /word spacing/i.test(b.getAttribute("aria-label") ?? ""))?.click());
      await h.idle();
      check((await css(page, "--ph-word-spacing")) === "0", "Reset puts word spacing back to none", await css(page, "--ph-word-spacing"));
    },
  },
  {
    name: "t3-slider-click",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "accessibility");
      const thumb = await sliderBy(page, "Text size");
      const track = await thumb.evaluateHandle((t) => t.closest("[data-setting-row]").querySelector("[data-slider-track]"));
      const box = await track.boundingBox();
      // A slip onto the track at 80%: one step toward it, not a jump to 175%.
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height / 2);
      await h.idle();
      const one = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(Math.abs(one - 1.05) < 1e-6, "a click on the track moves text size one step (100% to 105%)", `${one}`);
      check(await thumb.evaluate((t) => document.activeElement === t), "and the thumb has focus, so arrows go on from there");
      // Toward the left of the thumb steps down.
      await page.mouse.click(box.x + box.width * 0.02, box.y + box.height / 2);
      await h.idle();
      const back = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(Math.abs(back - 1) < 1e-6, "a click left of it steps back down", `${back}`);
      // The thumb still drags.
      const tb = await thumb.boundingBox();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.5, tb.y + tb.height / 2, { steps: 8 });
      await page.mouse.up();
      await h.idle();
      const dragged = await thumb.evaluate((t) => Number(t.getAttribute("aria-valuenow")));
      check(dragged > 1.3, "dragging the thumb still moves it as far as you drag", `${dragged}`);
      // Close shows its name on hover.
      await h.hover('button[aria-label="Close settings"]');
      await page.waitForSelector('[data-slot="tooltip-content"]', { timeout: 3000 });
      const tip = await page.$eval('[data-slot="tooltip-content"]', (el) => el.textContent);
      check(tip.startsWith("Close settings"), "Close shows a visible tooltip with its name", tip);
      await h.idle();
      await h.shot("close-tip");
      await park(page);
    },
  },
  {
    name: "t3-compact",
    sizes: [[760, 560]],
    sizesRequired: true,
    mock: { settings: { ...SETTINGS, appearance: { tokens: { "--ph-text-scale": 2 } } }, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const m = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]').getBoundingClientRect();
        const panel = document.querySelector('[role="tabpanel"]:not([hidden])').getBoundingClientRect();
        const tabs = [...document.querySelectorAll('[role="tab"]')].map((t) => t.getBoundingClientRect());
        return { dh: d.height, top: panel.top - d.top, tabsIn: tabs.every((t) => t.right <= d.right + 1 && t.left >= d.left - 1 && t.height >= 24), title: document.querySelector('[role="dialog"] h2')?.textContent };
      });
      console.log(`     header ${Math.round(m.top)} of ${Math.round(m.dh)} px`);
      check(m.top / m.dh <= 0.25, "the header and tabs take at most a quarter of the window", `${Math.round((m.top / m.dh) * 100)}%`);
      check(m.tabsIn, "every tab is fully in view and at least 24px tall");
      check(m.title === "Settings", "the window is still titled Settings", m.title);
      await park(page);
    },
  },
  {
    name: "t3-disclosure",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "agent");
      const d = await page.$eval("[data-disclosure]", (el) => el.innerText);
      check(/names of your other spaces/.test(d), "the disclosure says the names of other spaces are sent", d);
      check(/folders and files you’ve let (it|this space) read/.test(d), "and the folders and files you've granted", d);
      check(/saved in this space’s conversation/.test(d), "and that what is read from another space is saved in this space's conversation", d);
      await page.$eval("[data-disclosure]", (el) => el.scrollIntoView({ block: "center" }));
      await park(page);
      await h.click('[data-testid="settings-tab-about"]');
      await h.idle();
      const about = await panelText(page);
      check(/read from another space/.test(about) && /conversation/.test(about), "About's privacy notes say it too", about.slice(0, 400));
    },
  },
  {
    // Linda: About leads with the Conversations menu's Delete; the hidden-folder steps are a folded fallback.
    name: "t3-about-delete",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "about");
      const shown = await page.$eval("[data-about-delete]", (el) => el.innerText);
      check(/^Deleting a conversation\s+To delete a conversation, open Conversations at the top of the space and choose Delete/.test(shown), "it starts with the Conversations menu's Delete", shown.slice(0, 200));
      check(!/Command-Shift|thread\.json/.test(shown), "the hidden files and Finder keys are not on show", shown);
      check(/attachments folder/.test(shown) && /Anthropic/.test(shown), "it says attachments stay and what was sent to Anthropic", shown);
      check(/If you use Claude Code, it also keeps its own copy/.test(shown), "it says Claude Code keeps its own copy", shown);
      await page.$eval("[data-about-delete]", (el) => el.scrollIntoView({ block: "center" }));
      await park(page);
      await h.shot("folded");
      await page.focus("[data-about-delete] summary");
      await page.keyboard.press("Enter");
      await h.idle();
      const open = await page.$eval("[data-about-delete]", (el) => el.innerText);
      check(/Where the files are/.test(open) && /\.phaethon\/thread\.json/.test(open) && /Command-Shift-full stop/.test(open), "Where the files are opens from the keyboard and lists them", open);
      await park(page);
    },
  },
  {
    // Linda: a space's folder is said in words, not as the path "spaces/school".
    name: "t3-space-folder",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await openSettings(page, h, "spaces");
      const text = await panelText(page);
      check(!/Folder: |spaces\/school/.test(text), "no \"Folder: spaces/school\" path", text.slice(0, 400));
      const f = await page.$$eval("[data-space-folder]", (els) => els.map((e) => ({ text: e.textContent, mono: getComputedStyle(e).fontFamily.includes("Mono") })));
      check(f[0]?.text === "Kept in the folder named “school”, inside the spaces folder of your Phaethon folder." && !f[0].mono, "it says where in plain words", JSON.stringify(f));
      await park(page);
    },
  },
];
