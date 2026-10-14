// Importing courses is step by step (the shared wizard, ui/stepper.tsx). Behaviour checks: check(...) fails the run.
//   f14-import-steps   an existing site: Step 1 of 4 (no school or sign-in), courses, who can see them, the review; Back and
//                      Change keep what was unchecked; no step scrolls at 1100x720; Escape midway asks, Keep going keeps it
import { SETTINGS, check } from "../audit-fixtures.mjs";

const D = "[data-course-import]";
const waitFor = (page, fn, arg, timeout = 4000) => page.waitForFunction(fn, { timeout }, arg).then(() => true, () => false);
const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter((c) => c[0] === cmd).map((c) => c[1]), cmd);
const at = (page) =>
  page.evaluate((D) => {
    const d = document.querySelector(D);
    const t = d.querySelector("[data-step-title]");
    const body = d.querySelector("[data-wizard-body]");
    return {
      step: d.dataset.step,
      label: d.querySelector("[data-step-label]")?.textContent ?? null,
      focused: document.activeElement === t,
      current: d.querySelector('[data-wizard-steps] [aria-current="step"]')?.getAttribute("data-wizard-step") ?? null,
      over: body ? body.scrollHeight - body.clientHeight : null,
    };
  }, D);
async function expectStep(page, step, label) {
  const ok = await waitFor(page, ([D, s]) => document.querySelector(D)?.dataset.step === s && document.activeElement?.matches(`${D} [data-step-title]`), [D, step]);
  const s = await at(page);
  check(ok && s.label === label && s.current === step, `${step}: “${label}”, current in the list, heading focused`, JSON.stringify(s));
  const scale = await page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue("--ph-text-scale")) || 1);
  if (page.viewport().width >= 1100 && scale === 1) check(s.over <= 1, `${step}: fits without scrolling`, String(s.over));
  return s;
}
const checked = (page) => page.evaluate(() => [...document.querySelectorAll("[data-course] input:checked")].map((i) => i.closest("[data-course]").dataset.course).join());

export default [
  {
    name: "f14-import-steps",
    sizes: [[1100, 720], [640, 480]],
    themes: ["light"],
    mock: {
      settings: SETTINGS,
      threads: {},
      lms: { connections: { school: [{ id: "c1", kind: "canvas", address: "https://iu.instructure.com", schoolName: "Indiana University Bloomington", signedIn: true, courses: [] }] } },
    },
    async run(page, h) {
      await page.waitForSelector("[data-composer-input]", { timeout: 5000 });
      await page.focus("[data-composer-input]");
      await page.keyboard.down("Meta");
      await page.keyboard.press("k");
      await page.keyboard.up("Meta");
      await page.waitForSelector("[data-palette-input]", { timeout: 3000 });
      await page.keyboard.type("import courses");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-existing-site="c1"]', { timeout: 3000 });
      check((await at(page)).label === "Step 1 of 6", "it starts on step 1 of 6");
      await page.focus('[data-existing-site="c1"]');
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-course-list]", { timeout: 3000 });
      await expectStep(page, "choose", "Step 2 of 4");
      await h.shot("1-courses");
      // Uncheck one, then on to who can see them and back: it stays unchecked.
      await page.click('[data-course="102"] input');
      const before = await checked(page);
      await page.keyboard.press("Enter");
      await expectStep(page, "viewers", "Step 3 of 4");
      await h.shot("2-viewers");
      await page.click("[data-step-back]");
      await expectStep(page, "choose", "Step 2 of 4");
      check((await checked(page)) === before, "Back keeps what was checked", `${before} -> ${await checked(page)}`);
      await page.click("[data-step-next]");
      await expectStep(page, "viewers", "Step 3 of 4");
      await page.keyboard.press("Enter");
      await expectStep(page, "review", "Step 4 of 4");
      await h.shot("3-review");
      check((await calls(page, "lms_import")).length === 0, "nothing imported before the last step");
      // Change from the review goes to that step, with the choice kept.
      await page.click('[data-review-change="courses"]');
      await expectStep(page, "choose", "Step 2 of 4");
      check((await checked(page)) === before, "Change keeps what was checked");
      // Escape midway asks first; Keep going keeps the import where it was.
      await page.keyboard.press("Escape");
      check(await waitFor(page, () => document.activeElement?.matches("[data-wizard-keep]")), "Escape midway asks first, Keep going focused");
      await h.shot("asking");
      await page.keyboard.press("Enter");
      check(await waitFor(page, ([D]) => !document.querySelector("[data-wizard-discard]") && document.querySelector(D)?.dataset.step === "choose", [D]), "Keep going: still on the courses");
      check((await checked(page)) === before, "with the same courses checked");
    },
  },
];
