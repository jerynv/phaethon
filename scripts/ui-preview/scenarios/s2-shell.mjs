// Shell round 2 (persona fixes S1–S6), all behaviour checks: check(...) fails the run.
//   s2-panes-*     every visited space stays mounted: a waiting card, a draft, live state (S1)
//   s2-activity    the sidebar's "Answering…" / "Needs you", names and announcements (S1)
//   s2-switch-*    "Work, 2 messages" and the window title (S4)
//   s2-overlay     the narrow window's sidebar lies over the conversation (S2)
//   s2-labels      title bar buttons carry words when the sidebar is not docked (S2)
//   s2-keys-*      Cmd+1…9, the command palette, the shortcuts sheet (S3)
//   s2-names       no shell control repeats its name as its description (S5)
//   s2-read-by-*   the space being read shows who reads it; Revoke with Undo; Revoke all (S6)
import { LONG, check, park } from "../audit-fixtures.mjs";

const SCHOOL = [
  { role: "user", text: "When is the C241 test?", attachments: [] },
  { role: "assistant", text: "Between Oct 14 and 16. Your syllabus says the exact day is announced in lab.", attachments: [] },
];
const WORK = [
  { role: "user", text: "What is on my plate this week?", attachments: [] },
  { role: "assistant", text: "Review the onboarding doc by Tuesday.", attachments: [] },
];
const status = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");
/** Wait until the shell's status region says `text` (it is cleared and set again on the next frame). */
const said = (page, text, timeout = 5000) =>
  page
    .waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text)
    .then(() => true, () => false);
const chord = async (page, key) => {
  await page.keyboard.down("Meta");
  await page.keyboard.press(key);
  await page.keyboard.up("Meta");
};
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const space = (id) => `#spaces-sidebar [data-space-id="${id}"]`;
const pane = (id) => `[data-space-pane="${id}"]`;
const showSidebar = async (page) => {
  if (await page.evaluate(() => document.getElementById("spaces-sidebar")?.hidden)) {
    await page.click('button[aria-controls="spaces-sidebar"]');
    await page.waitForSelector("#spaces-sidebar:not([hidden])", { timeout: 5000 });
  }
};
const choose = async (page, id) => {
  await showSidebar(page);
  await page.click(space(id));
};

export default [
  {
    // S1: a card waiting in School survives a visit to Work; the reply is never cancelled.
    name: "s2-panes-card-waits",
    mock: {
      threads: { school: SCHOOL, work: WORK },
      turn: [
        { kind: "text", delta: "I’ll write that plan." },
        { waitApproval: true, id: "toolu_1", summary: "Create a new file plans/week6.md (2 lines).", detail: "# Week 6\n- [ ] Review\n", delay: 200 },
      ],
    },
    async run(page, h) {
      await h.send("Make me a study plan for the week");
      await page.waitForSelector(`${pane("school")} [role="alertdialog"]`, { timeout: 5000 });
      await choose(page, "work");
      await page.waitForSelector(`${pane("work")}[data-shown]`, { timeout: 5000 });
      const s = await page.evaluate((p) => {
        const el = document.querySelector(p);
        return { mounted: !!el, hidden: el ? getComputedStyle(el).visibility === "hidden" : null, inert: el?.inert, card: !!el?.querySelector('[role="alertdialog"]') };
      }, pane("school"));
      check(s.mounted && s.hidden && s.inert && s.card, "School stays mounted, invisible and inert, with its card still waiting", JSON.stringify(s));
      check((await calls(page, "agent_cancel")).length === 0, "switching away did not cancel School's reply");
      await choose(page, "school");
      await page.waitForSelector(`${pane("school")}[data-shown] [role="alertdialog"]`, { timeout: 5000 });
      check(true, "back in School, the card is there to answer");
      await park(page);
      await h.idle();
    },
  },
  {
    // S1: a draft keeps its words while you look at another space.
    name: "s2-panes-draft",
    sizes: [[1100, 720]],
    mock: { threads: { school: SCHOOL, work: WORK } },
    async run(page, h) {
      await page.waitForSelector(`${pane("school")} [data-composer-input]`, { timeout: 5000 });
      await page.focus(`${pane("school")} [data-composer-input]`);
      await page.keyboard.type("Half a thought about recursion");
      await choose(page, "work");
      await page.waitForSelector(`${pane("work")} [data-composer-input]`, { timeout: 5000 });
      await choose(page, "school");
      await h.idle();
      const v = await page.evaluate((p) => document.querySelector(`${p} [data-composer-input]`)?.value, pane("school"));
      check(v === "Half a thought about recursion", "the School draft survived a visit to Work", v);
      // The thread is loaded once per space, not again on every switch back.
      const loads = (await calls(page, "thread_load")).map((a) => a.space);
      check(loads.filter((s) => s === "school").length === 1, "School's conversation was loaded once", JSON.stringify(loads));
    },
  },
  {
    // S1: coming back to a space finds it where you left it (scroll position kept while hidden).
    name: "s2-panes-scroll",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: { school: LONG, work: WORK } },
    async run(page, h) {
      const log = `${pane("school")} [role="log"]`;
      await page.waitForSelector(log, { timeout: 5000 });
      await h.idle();
      await page.$eval(log, (l) => (l.scrollTop = 200));
      await h.idle();
      const before = await page.$eval(log, (l) => l.scrollTop);
      await choose(page, "work");
      await h.idle();
      await choose(page, "school");
      await h.idle();
      const after = await page.$eval(log, (l) => l.scrollTop);
      check(before > 0 && Math.abs(after - before) < 2, "School's conversation keeps its scroll position across a switch", `${before} -> ${after}`);
    },
  },
  {
    // S1: with every visited space mounted, Cmd+N (and the palette's New conversation) must start a
    // new conversation in the space shown, never in another one visited earlier.
    name: "s2-cmd-n-target",
    sizes: [[1100, 720]],
    themes: ["light"],
    mock: { threads: { school: SCHOOL, work: WORK } },
    async run(page, h) {
      await page.waitForSelector(`${pane("school")} [data-composer-input]`, { timeout: 5000 });
      await choose(page, "work");
      await page.waitForSelector(`${pane("work")} [data-composer-input]`, { timeout: 5000 });
      await page.focus(`${pane("work")} [data-composer-input]`);
      await chord(page, "n");
      await h.idle();
      let spaces = (await calls(page, "thread_new")).map((a) => a.space);
      check(spaces.join() === "work", "Cmd+N in Work starts a new conversation in Work only", JSON.stringify(spaces));
      await chord(page, "1");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "School", { timeout: 3000 });
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("new conversation");
      await page.keyboard.press("Enter");
      await h.idle();
      spaces = (await calls(page, "thread_new")).map((a) => a.space);
      check(spaces.join() === "work,school", "the palette's New conversation acts on the shown space (School)", JSON.stringify(spaces));
    },
  },
  {
    // S1: per-space activity in the sidebar, its accessible names, and polite announcements.
    name: "s2-activity",
    sizes: [[1100, 720]],
    mock: { threads: { school: SCHOOL, work: WORK } },
    async run(page, h) {
      await h.idle();
      await page.evaluate(() => window.__setSpaceActivity("work", { running: true, needsYou: false }));
      await h.idle();
      // The button's name from its content (aria-hidden parts left out), and what is shown.
      const named = (sel) =>
        page.$eval(sel, (b) => {
          // Elements are separate boxes here (grid items, sr-only text): a space between them, as Chromium adds.
          const t = (n) => (n.nodeType === 3 ? n.textContent : n.nodeType !== 1 || n.getAttribute("aria-hidden") === "true" ? "" : [...n.childNodes].map(t).join(" "));
          return `${t(b).replace(/\s+/g, " ").trim()} | ${b.querySelector("[data-space-activity]")?.textContent ?? ""}`;
        });
      let n = await named(space("work"));
      check(n === "Work, answering, Projects, meetings, follow-ups | Answering…", "Work reads \"Work, answering, …\" and shows Answering…", n);
      await h.shot("answering");
      await page.evaluate(() => window.__setSpaceActivity("work", { running: true, needsYou: true }));
      check(await said(page, "Work needs your answer."), "a background space that needs you is announced", await status(page));
      n = await named(space("work"));
      check(n === "Work, needs your answer, Projects, meetings, follow-ups | Needs you", "Work's name says it needs your answer; it shows Needs you", n);
      await h.shot("needs-you");
      await page.evaluate(() => window.__setSpaceActivity("work", { running: false, needsYou: false }));
      check(await said(page, "The reply in Work has ended."), "a background reply ending is announced", await status(page));
      // The shown space's own changes are not announced (its conversation says them).
      await page.evaluate(() => window.__setSpaceActivity("school", { running: true, needsYou: true }));
      await h.idle();
      check(!(await status(page)).includes("School"), "the shown space's activity is not announced by the shell", await status(page));
      await park(page);
    },
  },
  {
    // S4: the switch is announced with the message count, and the window is titled after the space.
    name: "s2-switch-announce",
    sizes: [[1100, 720]],
    mock: { threads: { school: SCHOOL, work: WORK, empty: [] }, spaces: [
      { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 },
      { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 55 },
      { id: "empty", name: "Yard", description: "", hue: 130 },
    ] },
    async run(page, h) {
      await h.idle();
      check((await page.title()) === "School — Phaethon", "the window title names the first space", await page.title());
      await choose(page, "work");
      check(await said(page, "Work, 2 messages"), "switching says \"Work, 2 messages\"", await status(page));
      check((await page.title()) === "Work — Phaethon", "the window title follows the switch", await page.title());
      await choose(page, "empty");
      check(await said(page, "Yard, no messages yet"), "an empty space says \"no messages yet\"", await status(page));
      const titled = await page.evaluate(() => window.__calls.some(([c, a]) => c === "plugin:window|set_title" && a.value === "Yard — Phaethon"));
      check(titled, "the Tauri window title is set too");
    },
  },
  {
    // S2: narrow window: the sidebar lies over the conversation, traps focus, and closes three ways.
    name: "s2-overlay",
    sizesRequired: true,
    sizes: [[700, 560], [640, 480]],
    mock: { threads: { school: SCHOOL, work: WORK } },
    async run(page, h) {
      await h.idle();
      const before = await page.$eval("#main", (m) => m.getBoundingClientRect().width);
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("#spaces-sidebar[data-overlay]:not([hidden])", { timeout: 5000 });
      await h.idle();
      const o = await page.evaluate(() => ({
        main: document.getElementById("main").getBoundingClientRect().width,
        inert: document.getElementById("main").inert,
        focus: document.activeElement?.getAttribute("data-space-id"),
        expanded: document.querySelector('button[aria-controls="spaces-sidebar"]').getAttribute("aria-expanded"),
      }));
      check(Math.abs(o.main - before) < 1, "the conversation keeps its width under the open sidebar", `${before} -> ${o.main}`);
      check(o.inert && o.focus === "school" && o.expanded === "true", "the conversation is inert, focus is on the current space, the toggle says expanded", JSON.stringify(o));
      await h.shot("open");
      // Tab cycles inside.
      const seen = new Set();
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        seen.add(await page.evaluate(() => (document.getElementById("spaces-sidebar").contains(document.activeElement) ? "in" : `out:${document.activeElement?.tagName}`)));
      }
      check(seen.size === 1 && seen.has("in"), "Tab stays inside the open sidebar", [...seen].join());
      await page.keyboard.press("Escape");
      await h.idle();
      let a = await page.evaluate(() => ({ hidden: document.getElementById("spaces-sidebar").hidden, toggle: document.activeElement?.getAttribute("aria-controls") }));
      check(a.hidden && a.toggle === "spaces-sidebar", "Escape closes it and focus returns to the toggle", JSON.stringify(a));
      await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector("[data-sidebar-scrim]", { timeout: 5000 });
      const vw = page.viewport().width;
      await page.mouse.click(vw - 20, 300);
      await h.idle();
      a = await page.evaluate(() => ({ hidden: document.getElementById("spaces-sidebar").hidden, toggle: document.activeElement?.getAttribute("aria-controls"), inert: document.getElementById("main").inert }));
      check(a.hidden && a.toggle === "spaces-sidebar" && !a.inert, "a click outside closes it, focus on the toggle, conversation usable again", JSON.stringify(a));
      await park(page);
    },
  },
  {
    // S2: with the sidebar not docked the title bar's buttons read "Spaces" and "Settings".
    name: "s2-labels",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: SCHOOL }, grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] } },
    async run(page, h) {
      await h.idle();
      if (!(await page.evaluate(() => document.getElementById("spaces-sidebar").hidden))) await page.click('button[aria-controls="spaces-sidebar"]');
      await page.waitForSelector('header [data-testid="titlebar-settings"]', { timeout: 5000 });
      const t = await page.evaluate(() => [...document.querySelectorAll("header button[aria-keyshortcuts]")].map((b) => `${b.textContent.trim()}|${b.getAttribute("aria-label") ?? ""}`));
      check(t.join() === "Spaces|,Settings|", "the title bar buttons show their words, which are their names", t.join());
      const whole = await page.$eval("#space-title", (h1) => h1.scrollWidth <= h1.clientWidth);
      check(whole, "the space title still shows whole");
      const fit = await page.evaluate(() => {
        const c = document.querySelector("[data-grants-chip]").getBoundingClientRect();
        return { right: c.right, room: innerWidth, width: c.width };
      });
      check(fit.right <= fit.room && fit.width > 40, "the grants chip fits in the bar (it shortens before it is cut off)", JSON.stringify(fit));
      await park(page);
    },
  },
  {
    // S3: Cmd+1…9 switch spaces, even while typing in the composer.
    name: "s2-keys-spaces",
    sizes: [[1100, 720]],
    mock: { threads: { school: SCHOOL, work: WORK } },
    async run(page, h) {
      await page.waitForSelector(`${pane("school")} [data-composer-input]`, { timeout: 5000 });
      await page.focus(`${pane("school")} [data-composer-input]`);
      await page.keyboard.type("draft");
      await chord(page, "2");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Work", { timeout: 3000 });
      await h.idle();
      const f = await page.evaluate(() => document.activeElement?.closest("[data-space-pane]")?.getAttribute("data-space-pane") ?? document.activeElement?.id);
      check(f === "work", "Cmd+2 shows Work and focus moves into Work's conversation", f);
      await chord(page, "1");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "School", { timeout: 3000 });
      const v = await page.evaluate((p) => document.querySelector(`${p} [data-composer-input]`)?.value, pane("school"));
      check(v === "draft", "Cmd+1 goes back; the draft is still there", v);
      await chord(page, "9");
      await h.idle();
      check((await page.$eval("#space-title", (e) => e.textContent)) === "School", "Cmd+9 with no ninth space does nothing");
    },
  },
  {
    // S3: Cmd+K command palette: a combobox over a listbox; type, arrow, Enter.
    name: "s2-keys-palette",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: SCHOOL, work: WORK }, settings: { backend: "phaethon", hasAnthropicKey: true, model: "claude-opus-5-5", appearance: {}, vaultPath: "/Users/you/Phaethon/default", version: "0.1.0" } },
    async run(page, h) {
      await h.idle();
      await chord(page, "k");
      await page.waitForSelector("[data-command-palette] [data-palette-input]", { timeout: 3000 });
      const a = await page.evaluate(() => {
        const i = document.activeElement;
        const list = document.getElementById(i.getAttribute("aria-controls"));
        return {
          role: i.getAttribute("role"),
          focusedInput: i.hasAttribute("data-palette-input"),
          list: list?.getAttribute("role"),
          active: document.getElementById(i.getAttribute("aria-activedescendant"))?.textContent,
          options: list?.querySelectorAll('[role="option"]').length,
        };
      });
      check(a.role === "combobox" && a.focusedInput && a.list === "listbox" && a.options > 5, "Cmd+K opens the palette with focus in its combobox over a listbox", JSON.stringify(a));
      await h.shot("open");
      await page.keyboard.type("wor");
      await h.idle();
      const sel = await page.evaluate(() => document.getElementById(document.activeElement.getAttribute("aria-activedescendant"))?.getAttribute("data-command"));
      check(sel === "space:work", "typing \"wor\" highlights Work", sel);
      await h.shot("filtered");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("space-title")?.textContent === "Work", { timeout: 3000 });
      check(!(await page.$("[data-command-palette]")), "Enter runs it and the palette closes");
      // Settings sections are commands too.
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("appearance");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-testid="settings-tab-appearance"][data-state="active"]', { timeout: 5000 });
      check(true, "\"appearance\" + Enter opens Settings at Appearance");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 5000 });
      // Arrow keys move the highlight; Escape closes and focus returns.
      await page.focus(`${pane("work")} [data-composer-input]`);
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.press("ArrowDown");
      const second = await page.evaluate(() => document.getElementById(document.activeElement.getAttribute("aria-activedescendant"))?.getAttribute("data-command"));
      check(second === "space:work", "ArrowDown moves to the second option", second);
      await page.keyboard.press("Escape");
      await h.idle();
      const back = await page.evaluate(() => document.activeElement?.hasAttribute("data-composer-input"));
      check(back, "Escape closes the palette and focus returns to the composer");
    },
  },
  {
    // S3: Cmd+/ lists every shortcut; also reachable from the palette.
    name: "s2-keys-sheet",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: SCHOOL } },
    async run(page, h) {
      await h.idle();
      await chord(page, "/");
      await page.waitForSelector("[data-shortcuts-sheet]", { timeout: 3000 });
      const t = await page.evaluate(() => ({
        title: document.querySelector("[data-shortcuts-sheet] h2")?.textContent,
        rows: document.querySelectorAll("[data-shortcuts-sheet] tbody tr").length,
        spoken: document.querySelector("[data-shortcuts-sheet] tbody th")?.textContent,
        text: document.querySelector("[data-shortcuts-sheet]").textContent,
      }));
      check(t.title === "Keyboard shortcuts" && t.rows >= 10, "Cmd+/ opens the list of shortcuts", JSON.stringify({ ...t, text: undefined }));
      check(t.spoken.startsWith("Command K"), "key caps are spoken by name", t.spoken);
      check(["Find a space or command", "Go to space 1 to 9", "New conversation", "Show or hide the sidebar", "Stop the reply"].every((s) => t.text.includes(s)), "every shell shortcut is listed");
      await h.shot("open");
      await chord(page, "/");
      await h.idle();
      check(!(await page.$("[data-shortcuts-sheet]")), "Cmd+/ again closes it");
      await chord(page, "k");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("shortcuts");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-shortcuts-sheet]", { timeout: 3000 });
      check(true, "the palette opens it too");
    },
  },
  {
    // S5: no shell control's description repeats its name.
    name: "s2-names",
    sizes: [[1100, 720], [760, 560]],
    mock: { threads: { school: SCHOOL }, grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] } },
    async run(page, h) {
      await h.idle();
      await showSidebar(page);
      // Hover the toggle so its tooltip is open (Radix then describes the trigger by it, unless told not to).
      await page.hover('button[aria-controls="spaces-sidebar"]');
      await new Promise((r) => setTimeout(r, 900));
      const cdp = await page.createCDPSession();
      const val = (p) => p?.value ?? "";
      /** "name [description]" for every button under `scope`, from Chromium's accessibility tree. */
      const { nodes: tree } = await cdp.send("Accessibility.getFullAXTree");
      const byBackend = new Map(tree.map((n) => [n.backendDOMNodeId, n]));
      const named = async (scope) => {
        const out = [];
        const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
        const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: scope.split(",").map((s) => `${s.trim()} button`).join(", ") });
        for (const nodeId of nodeIds) {
          const { node } = await cdp.send("DOM.describeNode", { nodeId });
          const n = byBackend.get(node.backendNodeId);
          if (!n || n.ignored) continue;
          const name = val(n.name).trim();
          const d = val(n.description).trim();
          out.push({ name, d, text: `${name}${d ? ` [${d}]` : ""}` });
        }
        return out;
      };
      const shell = await named("header, #spaces-sidebar");
      const conversation = await named("main");
      const dup = ({ name, d }) => d && (d === name || d.includes(name) || name.includes(d));
      console.log(`     shell buttons: ${shell.map((b) => b.text).join(" · ")}`);
      const chatDup = conversation.filter(dup).map((b) => b.text);
      if (chatDup.length) console.log(`     (conversation buttons, the chat's to fix: ${chatDup.join(" · ")})`);
      const bad = shell.filter(dup).map((b) => b.text);
      const seen = shell.map((b) => b.text);
      check(!bad.length, "no shell button's description repeats its name", bad.join(" · "));
      // Docked (a wide window) the toggle is an icon named "Hide sidebar"; over the conversation it reads "Spaces".
      const docked = await page.evaluate(() => !document.getElementById("spaces-sidebar").hasAttribute("data-overlay"));
      if (docked) check(seen.some((s) => s.startsWith("Hide sidebar [Command Backslash]")), "the sidebar toggle is described only by its shortcut while its tooltip shows", seen.join(" · "));
      else check(!!seen[0]?.startsWith("Spaces"), "over the conversation, the toggle is named by its word, Spaces", seen.join(" · "));
      check(seen.includes("School, Courses, deadlines, study notes"), "a space button says its name and description once each, with no description repeating them", seen.join(" · "));
    },
  },
  {
    // S6: Work (the space being read) shows who reads it; Revoke waits with Undo; Undo keeps it.
    name: "s2-read-by-undo",
    sizes: [[1100, 720], [760, 560]],
    mock: {
      threads: { school: SCHOOL, work: WORK },
      grants: { school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-09T15:20:00Z", scope: "always" }] },
    },
    async run(page, h) {
      await choose(page, "work");
      await page.waitForSelector("[data-grants-in-chip]", { timeout: 5000 });
      const name = await page.$eval("[data-grants-in-chip]", (b) => b.textContent.replace(/\s+/g, " ").trim());
      check(name === "Read by School", "Work's title bar says \"Read by School\"", name);
      check(!(await page.$("[data-grants-chip]")), "Work itself reads nothing, so it has no \"Also reads\" chip");
      await park(page);
      await h.shot("chip");
      await page.click("[data-grants-in-chip]");
      await page.waitForSelector('[data-radix-popper-content-wrapper] [role="dialog"]', { timeout: 5000 });
      await h.idle();
      await h.shot("popover");
      await page.click("[data-revoke]");
      await page.waitForSelector("[data-undo]", { timeout: 3000 });
      const s = await page.evaluate(() => ({ focus: document.activeElement?.getAttribute("aria-label"), status: document.querySelector("[data-shell-status]")?.textContent }));
      check(s.focus === "Undo removing Work / calendar", "Revoke puts focus on its Undo", JSON.stringify(s));
      await h.shot("undo");
      // The revoke is made at once: the grant stops working when the user says so.
      check((await calls(page, "grant_revoke")).map((a) => a.id).join() === "g-cal", "Revoke is made at once");
      check(await said(page, "School can no longer read Work / calendar. Undo is available for a few seconds."), "and announced, with Undo", await status(page));
      await page.keyboard.press("Enter");
      await h.idle();
      check(await said(page, "Undone. School can still read Work / calendar."), "Undo is announced", await status(page));
      const restored = await calls(page, "grant_restore");
      check(restored.length === 1 && restored[0].id === "g-cal" && restored[0].created === "2026-10-09T15:20:00Z", "Undo puts the same grant back", JSON.stringify(restored));
      const f = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      check(f === "Remove School’s access to Work / calendar", "Undo puts focus back on Revoke", f);
      await new Promise((r) => setTimeout(r, 6500));
      check((await calls(page, "grant_revoke")).length === 1, "an undone revoke is not made again");
      // Now let one go through.
      await page.click("[data-revoke]");
      await new Promise((r) => setTimeout(r, 6600));
      const made = (await calls(page, "grant_revoke")).map((a) => a.id);
      check(made.join() === "g-cal,g-cal", "the second revoke is made", JSON.stringify(made));
      const after = await page.evaluate(() => ({ chip: !!document.querySelector("[data-grants-in-chip]"), focus: document.activeElement?.id }));
      check(!after.chip && after.focus === "main", "the chip goes; focus is on the conversation", JSON.stringify(after));
    },
  },
  {
    // S6: most recent first, and Revoke all with an inline confirm.
    name: "s2-read-by-all",
    sizes: [[1100, 720]],
    mock: {
      threads: { school: SCHOOL, work: WORK },
      spaces: [
        { id: "home", name: "Home", description: "Bills and family", hue: 320 },
        { id: "school", name: "School", description: "Courses, deadlines, study notes", hue: 250 },
        { id: "work", name: "Work", description: "Projects, meetings, follow-ups", hue: 55 },
      ],
      grants: {
        school: [{ id: "g-cal", from: "work", path: "calendar", created: "2026-10-01T15:20:00Z", scope: "always" }],
        home: [{ id: "g-now", from: "work", path: "projects/now.md", created: "2026-10-10T09:00:00Z", scope: "always" }],
      },
    },
    async run(page, h) {
      await choose(page, "work");
      await page.waitForSelector("[data-grants-in-chip]", { timeout: 5000 });
      const name = await page.$eval("[data-grants-in-chip]", (b) => b.textContent.replace(/\s+/g, " ").trim());
      // A narrow window collapses the chip to a count.
      const want = page.viewport().width < 768 ? "Read by 2 spaces" : "Read by Home +1 more";
      check(name === want, `the chip reads "${want}" (most recent reader first)`, name);
      await page.click("[data-grants-in-chip]");
      await page.waitForSelector("[data-revoke-all]", { timeout: 5000 });
      const order = await page.$$eval("[data-grant-row]", (rows) => rows.map((r) => r.getAttribute("data-grant-row")));
      check(order.join() === "g-now,g-cal", "rows are most recent first", order.join());
      await page.click("[data-revoke-all]");
      await page.waitForSelector("[data-revoke-all-confirm]", { timeout: 3000 });
      const f = await page.evaluate(() => document.activeElement?.hasAttribute("data-revoke-all-cancel"));
      check(f, "the confirm puts focus on Cancel (the safe choice)");
      check((await calls(page, "grant_revoke")).length === 0, "nothing is revoked before confirming");
      await park(page);
      await h.shot("confirm");
      await page.click("[data-revoke-all-confirm]");
      await page.waitForFunction(() => !document.querySelector("[data-grants-in-chip]"), { timeout: 5000 });
      const made = (await calls(page, "grant_revoke")).map((a) => a.id).sort();
      check(made.join() === "g-cal,g-now", "Revoke all revokes both", made.join());
      check(await said(page, "No other space can read anything in Work now.", 2000), "and says so", await status(page));
    },
  },
];
