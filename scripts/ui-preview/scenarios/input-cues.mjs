import { SETTINGS, check, openSettings } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration, providerPopup } from "../provider-flow.mjs";
import studyScenarios from "./f6-study.mjs";

const shown = "[data-space-pane][data-shown]";
const nav = ":is(#spaces-sidebar:not([hidden]), [data-space-pane][data-shown])";
const studyFixture = () => structuredClone(studyScenarios.find((scenario) => scenario.name === "f6-deck-edit").mock);

async function emptyCue(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 4000 });
  await page.$eval(selector, (field) => field.scrollIntoView({ block: "center" }));
  const cue = await page.$eval(selector, (field) => ({
    placeholder: field.placeholder,
    value: field.value,
    shown: field.matches(":placeholder-shown"),
    label: [...field.labels].map((label) => label.textContent.trim()).join(" "),
    visibleLabel: [...field.labels].some((label) => label.getBoundingClientRect().width > 0 && label.getBoundingClientRect().height > 0),
    type: field.type,
  }));
  check(cue.value === "" && cue.shown && cue.placeholder.trim().length > 0, "an empty field shows a cue without inserting it as a value", JSON.stringify(cue));
  check(cue.label.length > 0 && cue.visibleLabel, "the field keeps a visible label separate from its placeholder", JSON.stringify(cue));
  return cue;
}

async function openStudy(page) {
  await page.waitForSelector(`${nav} [data-view-tab="study"]`, { timeout: 5000 });
  await page.click(`${nav} [data-view-tab="study"]`);
  await page.waitForSelector(`${shown} [data-open-course]`, { timeout: 4000 });
  await page.click(`${shown} [data-open-course]`);
  await page.waitForSelector(`${shown} [data-study-hub] [data-course-back]`, { timeout: 4000 });
}

export default [
  {
    name: "input-cues-connections",
    sizes: [[1100, 720], [640, 480]],
    mock: {
      settings: { ...SETTINGS, hasAnthropicKey: false },
      threads: {},
      prov: { provider: "anthropic", keys: {}, models: {}, urls: {}, lists: {} },
    },
    async run(page, h) {
      const onboarding = await emptyCue(page, `${shown} [data-setup-key]`);
      check(onboarding.type === "password" && onboarding.placeholder.startsWith("sk-ant-"), "onboarding shows the provider key format in a password field");
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "anthropic");
      const providerKey = await emptyCue(page, `${providerPopup} [data-key-input]`);
      check(providerKey.type === "password" && providerKey.placeholder.startsWith("sk-ant-"), "provider setup shows the same key format without revealing a secret");
      await closeProviderPopup(page);
      await openProviderConfiguration(page, "custom", { catalog: true });
      const server = await emptyCue(page, `${providerPopup} [data-provider-url]`);
      check(server.type === "url" && new URL(server.placeholder).protocol === "https:", "the server field supplies a usable HTTPS address example", server.placeholder);
      await page.type(`${providerPopup} [data-provider-url]`, server.placeholder);
      await page.click(`${providerPopup} [data-provider-url-save]`);
      await page.waitForFunction((url) => window.__MOCK__.prov.urls.custom === url, { timeout: 4000 }, server.placeholder);
      const changed = await page.evaluate(() => window.__calls.filter(([command]) => command === "settings_set_provider_url").length);
      check(changed === 1, "typing and saving the address uses the real field flow once", String(changed));
    },
  },
  {
    name: "input-cues-flashcards",
    sizes: [[1100, 720], [640, 480]],
    mock: studyFixture(),
    async run(page) {
      await openStudy(page);
      await page.click(`${shown} [data-open-deck="study/decks/Graph theory basics.md"]`);
      await page.waitForSelector("[data-add-card]", { visible: true, timeout: 4000 });
      await page.click("[data-add-card]");
      const front = await emptyCue(page, "[data-edit-front]");
      const back = await emptyCue(page, "[data-edit-back]");
      check(front.placeholder !== back.placeholder, "question and answer fields have distinct examples");
      await page.type("[data-edit-front]", "What is a leaf?");
      await page.type("[data-edit-back]", "A vertex of degree 1.");
      await page.click("[data-save-card]");
      await page.waitForFunction(() => !document.querySelector("[data-card-editor]"), { timeout: 4000 });
      const saved = await page.evaluate(() => window.__calls.filter(([command]) => command === "study_deck_save").at(-1)?.[1].cards);
      check(saved?.length === 6 && saved[0].front === "What is a leaf?" && saved[0].back === "A vertex of degree 1.", "saving a new card stores the user's words, not the placeholder examples", JSON.stringify(saved?.[0]));
    },
  },
  {
    name: "input-cues-quiz-answers",
    sizes: [[1100, 720], [640, 480]],
    mock: studyFixture(),
    async run(page) {
      await openStudy(page);
      await page.click(`${shown} [data-take-quiz="study/quizzes/Test 1 practice.json"]`);
      await page.waitForSelector('[data-go-question="q4"]', { visible: true, timeout: 4000 });
      await page.click('[data-go-question="q4"]');
      const short = await emptyCue(page, '[data-question="q4"] textarea');
      check(!short.placeholder.includes("sides alternate"), "the short-answer cue gives format guidance without supplying the answer");
      await page.type('[data-question="q4"] textarea', "Walking an edge switches sides.");
      await page.click("[data-quiz-next]");
      await emptyCue(page, '[data-question="q5"] input');
      await page.click('[data-go-question="q4"]');
      const answer = await page.$eval('[data-question="q4"] textarea', (field) => ({ value: field.value, shown: field.matches(":placeholder-shown") }));
      check(answer.value === "Walking an edge switches sides." && !answer.shown, "the typed answer replaces the cue and survives question navigation", JSON.stringify(answer));
    },
  },
];
