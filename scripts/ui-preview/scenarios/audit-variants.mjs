// Audit: the main screens, kept small so they can be run under every global
// variant (--scale, --contrast, --forced-colors, --motion, --sizes):
//
//   node scripts/ui-preview/shoot.mjs --engine chromium --match audit-v- --sizes 640x480,760x560,1100x720,1600x1000
//   node scripts/ui-preview/shoot.mjs --engine chromium --match audit-v- --scale 2 --sizes 1100x720
//
// Each logs whether the page scrolls sideways (WCAG 1.4.10 reflow).
import { CONVERSATION, GRANTS, SETTINGS, openSettings, park } from "../audit-fixtures.mjs";

const reflow = async (page) => {
  const r = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll("body, #root > *, main, [role='log'], [role='dialog'], header")) {
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "hidden") out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}[${el.getAttribute("role") ?? ""}] ${el.scrollWidth}>${el.clientWidth}`);
    }
    // Clipped text: elements whose content is wider than their box with overflow hidden.
    const clipped = [...document.querySelectorAll("h1, h2, h3, button, label, p, span")]
      .filter((el) => !el.closest(".sr-only") && el.getClientRects().length)
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis" && getComputedStyle(el).overflow === "hidden")
      .map((el) => el.textContent.trim().slice(0, 30));
    return { sideways: out, clipped };
  });
  console.log(`     reflow: ${r.sideways.length ? `SCROLLS SIDEWAYS ${r.sideways.join("; ")}` : "no sideways scroll"}; clipped text without an ellipsis: ${r.clipped.length ? JSON.stringify(r.clipped) : "none"}`);
};

const approvalTurn = [
  { kind: "text", delta: "I'll put the plan in a file so you can tick things off." },
  { kind: "tool", label: "Waiting for you to allow: Writing file plans/week6.md" },
  { waitApproval: true, id: "toolu_1", summary: "Create a new file plans/week6.md (7 lines).", detail: "# Week 6\n\n- [ ] Mon: recursion 3.1 to 3.6 (90 min)\n- [ ] Tue: problem set 4 (2 h)\n- [ ] Wed: review ch. 1 to 4 (60 min)\n" },
];

export default [
  {
    name: "audit-v-conversation",
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.waitText("Here is a plan");
      await park(page);
      await h.idle();
      await reflow(page);
    },
  },
  {
    name: "audit-v-empty",
    mock: { settings: SETTINGS, threads: {} },
    async run(page, h) {
      await h.idle();
      await page.focus("[data-composer-input]");
      await page.keyboard.press("Shift");
      await park(page);
      await h.idle();
      await reflow(page);
    },
  },
  {
    name: "audit-v-approval",
    mock: { settings: SETTINGS, threads: { school: CONVERSATION.slice(0, 2) }, holdOpen: true, turn: approvalTurn },
    async run(page, h) {
      await h.send("Yes, make the plan.");
      await page.waitForSelector('[role="alertdialog"]', { timeout: 5000 });
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      await park(page);
      await h.idle();
      await reflow(page);
    },
  },
  {
    name: "audit-v-titlebar-grants",
    mock: { settings: SETTINGS, threads: { school: CONVERSATION }, grants: { school: GRANTS.two } },
    async run(page, h) {
      await h.click("[data-grants-chip]");
      await page.waitForSelector('[data-radix-popper-content-wrapper] [role="dialog"]', { timeout: 5000 });
      await page.keyboard.press("Tab");
      await park(page);
      await h.idle();
      await reflow(page);
    },
  },
  {
    name: "audit-v-settings-appearance",
    mock: { settings: SETTINGS, threads: { school: CONVERSATION } },
    async run(page, h) {
      await openSettings(page, h, "appearance");
      await page.keyboard.press("Tab");
      await park(page);
      await h.idle();
      await reflow(page);
    },
  },
];
