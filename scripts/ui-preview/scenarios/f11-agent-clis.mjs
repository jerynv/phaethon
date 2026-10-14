// Agent CLIs (Team Agent CLIs): Codex and Gemini CLI next to Claude Code. Behaviour checks: check(...) fails the run.
//   f11-settings   Settings › Assistant lists the four assistants, each CLI's status in words (installed, signed in where the CLI
//                  can say), what CLIs can't do here, OpenCode as not installed with how to install it; choosing Codex by keyboard
//                  switches, and the model and disclosure sections name Codex and OpenAI
//   f11-missing    choosing Gemini CLI when it isn't installed says so with how to install it, and doesn't switch
//   f11-model      with Codex answering, a space's model button offers Codex's own default and Another model…, where a typed name
//                  is saved as codex:<name> (a name that could be a flag is refused at the field) and the default comes back
//   f11-errors     a chat error names the CLI that answers and its own sign-in command
//   f11-empty      the empty conversation says Gemini CLI answers here, read-only
import { SETTINGS, check, openSettings, park, PANEL } from "../audit-fixtures.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const picker = `${shown} [data-model-picker]`;
const settingsSaid = (page, text, timeout = 4000) =>
  page
    .waitForFunction((t) => [...document.querySelectorAll('[role="dialog"] p[role="status"]')].some((p) => p.textContent === t), { timeout }, text)
    .then(() => true, () => false);
const shellSaid = (page, text, timeout = 4000) =>
  page.waitForFunction((t) => document.querySelector("[data-shell-status]")?.textContent === t, { timeout }, text).then(() => true, () => false);
const shellStatus = (page) => page.evaluate(() => document.querySelector("[data-shell-status]")?.textContent ?? "");

const CLIS = (over = {}) =>
  [
    { id: "claude", name: "Claude Code", installed: true, loggedIn: null, loginCommand: "claude", supported: true },
    { id: "codex", name: "Codex", installed: true, loggedIn: true, loginCommand: "codex login", supported: true },
    { id: "gemini", name: "Gemini CLI", installed: true, loggedIn: null, loginCommand: "gemini", supported: true },
    { id: "opencode", name: "OpenCode", installed: false, loggedIn: null, loginCommand: "opencode auth login", supported: false },
  ].map((c) => ({ ...c, ...(over[c.id] ?? {}) }));

export default [
  {
    name: "f11-settings",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ codex: { loggedIn: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-cli-status]', { timeout: 3000 });
      const choices = await page.$$eval('[role="radio"][data-backend]', (rs) =>
        rs.map((r) => ({ value: r.dataset.backend, name: document.getElementById(r.getAttribute("aria-labelledby"))?.textContent, said: r.getAttribute("aria-describedby").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ") })),
      );
      check(choices.map((c) => c.value).join() === "phaethon,claude-cli,codex-cli,gemini-cli", "four assistants to choose from", JSON.stringify(choices.map((c) => c.value)));
      const codex = choices.find((c) => c.value === "codex-cli");
      check(codex.name === "Codex on this computer" && /OpenAI’s Codex/.test(codex.said) && /not signed in: run codex login in a terminal/.test(codex.said), "Codex says it isn't signed in, and how to sign in, as part of its choice", codex.said);
      const gemini = choices.find((c) => c.value === "gemini-cli");
      check(/can’t tell whether you’re signed in until you send a message/.test(gemini.said) && /run gemini in a terminal/.test(gemini.said), "Gemini CLI says Phaethon can't tell, and how to sign in", gemini.said);
      const claude = choices.find((c) => c.value === "claude-cli");
      check(/doesn’t check whether you’re signed in/.test(claude.said), "Claude Code's sign-in is never checked", claude.said);
      const can = await page.$eval("[data-cli-can]", (p) => p.textContent);
      check(/can’t change anything/.test(can) && /works only with Phaethon’s own assistant/.test(can), "what the CLIs can't do here is said", can);
      const oc = await page.$eval("[data-opencode]", (p) => [p.dataset.opencode, p.textContent, p.querySelector("a")?.href]);
      check(oc[0] === "missing" && /OpenCode isn’t installed/.test(oc[1]) && /opencode\.ai/.test(oc[2] ?? ""), "OpenCode: not installed, with how to install it", JSON.stringify(oc));
      await park(page);
      await h.shot("choices");

      // Keyboard: arrows move and choose within the radio group.
      await page.focus('[role="radio"][data-backend="claude-cli"]');
      await page.keyboard.press("ArrowDown");
      check(await settingsSaid(page, "Now using Codex on this computer."), "choosing Codex by keyboard switches and says so");
      const sets = await calls(page, "settings_set_backend");
      check(sets.at(-1)?.backend === "codex-cli", "codex-cli is saved", JSON.stringify(sets));
      await page.waitForSelector("[data-cli-model-default]", { timeout: 3000 });
      const text = await page.$eval(PANEL, (e) => e.innerText);
      check(/Chosen by Codex/.test(text) && /A space can name another one/.test(text), "the model section says Codex chooses unless a space names one", "");
      check(/What is sent to OpenAI/.test(text) && /your own ChatGPT or OpenAI account/.test(text) && /\.codex folder/.test(text), "the disclosure names OpenAI and Codex's own folder", text.slice(text.indexOf("What is sent"), text.indexOf("What is sent") + 500));
      check(/AGENTS\.md in \.codex/.test(text), "it says Codex's own instructions file still reaches every space", "");
      await park(page);
      await h.shot("codex");
    },
  },
  {
    name: "f11-missing",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ gemini: { installed: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-cli-status="missing"]', { timeout: 3000 });
      await page.click('[role="radio"][data-backend="gemini-cli"]');
      await page.waitForSelector('[data-cli-missing="gemini-cli"]', { timeout: 3000 });
      const box = await page.$eval('[data-cli-missing="gemini-cli"]', (b) => [b.textContent, b.querySelector("a")?.href]);
      check(/Gemini CLI isn’t installed on this computer/.test(box[0]) && /run gemini in a terminal/.test(box[0]) && /How to install Gemini CLI/.test(box[0]) && /github\.com\/google-gemini/.test(box[1] ?? ""), "it says Gemini CLI is missing and how to install it", JSON.stringify(box));
      check((await calls(page, "settings_set_backend")).length === 0, "and doesn't switch");
      const checked = await page.$eval('[role="radio"][aria-checked="true"]', (r) => r.dataset.backend);
      check(checked === "phaethon", "Phaethon's own assistant stays chosen", checked);
      await park(page);
      await h.shot("missing");
    },
  },
  {
    name: "f11-model",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      let label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(label[0] === "Model in School: Codex default, the model Codex chooses" && label[1] === "Codex default", "the button says Codex picks its own model", JSON.stringify(label));
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [role="menuitemradio"]', { timeout: 3000 });
      await h.idle();
      const items = await page.$$eval("[data-model-menu] [data-model-option]", (els) => els.map((e) => e.textContent.trim()));
      check(/^Codex’s own default/.test(items[0]) && items.at(-1) === "Another model…", "Codex's default first, then Another model…", JSON.stringify(items));
      await park(page);
      await h.shot("menu");
      // By keyboard alone: close, open from the button, start on the model in use, the next item is Another model….
      await page.keyboard.press("Escape");
      await page.waitForFunction((p) => !document.querySelector("[data-model-menu]") && document.activeElement === document.querySelector(p), { timeout: 3000 }, picker);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-checked") === "true", { timeout: 3000 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => /Another model/.test(document.activeElement?.textContent ?? ""), { timeout: 3000 }).catch(() => {});
      const at = await page.evaluate(() => document.activeElement?.textContent);
      check(/Another model/.test(at ?? ""), "ArrowDown reaches Another model…", at);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog]", { timeout: 3000 });
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-cli-model-input"));
      check(focused, "the name field has focus", String(focused));
      const desc = await page.$eval("[data-cli-model-dialog]", (d) => d.textContent);
      check(/can’t list Codex’s models/.test(desc) && /For example gpt-5\.5/.test(desc), "it says to type the name as Codex knows it", desc);
      // A name that could be read as a flag is refused, at the field.
      await page.keyboard.type("--yolo");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog] [role=alert]", { timeout: 3000 });
      const err = await page.$eval("[data-cli-model-input]", (i) => [i.getAttribute("aria-invalid"), document.getElementById(i.getAttribute("aria-describedby").split(" ")[1])?.textContent]);
      check(err[0] === "true" && /isn’t a model name Phaethon can pass on/.test(err[1] ?? ""), "the refusal is at the field and described by it", JSON.stringify(err));
      await park(page);
      await h.shot("refused");
      await page.click("[data-cli-model-input]", { clickCount: 3 });
      await page.keyboard.type("gpt-5.5");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !document.querySelector("[data-cli-model-dialog]"), { timeout: 3000 });
      const sets = await calls(page, "space_model_set");
      check(sets.at(-1)?.space === "school" && sets.at(-1)?.model === "codex:gpt-5.5", "School saves codex:gpt-5.5", JSON.stringify(sets));
      check(await shellSaid(page, "School now uses Codex · gpt-5.5."), "and says so", await shellStatus(page));
      await page.waitForFunction((p) => document.activeElement === document.querySelector(p), { timeout: 3000 }, picker);
      label = await page.$eval(picker, (b) => [b.getAttribute("aria-label"), b.textContent.trim()]);
      check(label[0] === "Model in School: Codex · gpt-5.5" && label[1] === "gpt-5.5", "focus is back on the button, which shows the model", JSON.stringify(label));

      // Back to Codex's own default.
      await page.click(picker);
      await page.waitForSelector('[data-model-option="__default__"]', { timeout: 3000 });
      await page.click('[data-model-option="__default__"]');
      check(await shellSaid(page, "School now uses Codex’s own default model."), "the default comes back, said", await shellStatus(page));
      const last = (await calls(page, "space_model_set")).at(-1);
      check(last.model === null, "cleared with null (the core clears Codex's)", JSON.stringify(last));
    },
  },
  {
    name: "f11-errors",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" },
      threads: {},
      sendError: { code: "notLoggedIn", message: "Codex is not logged in. Run `codex login` once in a terminal to sign in, then try again." },
    },
    async run(page, h) {
      await h.send("What is due this week?");
      await page.waitForSelector('[data-role="assistant"] [role="alert"]', { timeout: 5000 });
      const alert = await page.$eval('[data-role="assistant"] [role="alert"]', (a) => [a.querySelector("[data-error-title]").textContent, a.textContent]);
      check(alert[0] === "Codex isn’t signed in", "the title names Codex", alert[0]);
      check(/Run codex login once in a terminal/.test(alert[1]) && !alert[1].includes("Claude") && !alert[1].includes("`"), "the body is Codex's own sign-in command, in plain text", alert[1]);
      const detail = await page.$eval('[data-role="assistant"] [data-error-detail]', (d) => d.textContent);
      check(/codex login/.test(detail), "the core's own words stay under Details", detail);
      const actions = await page.$$eval('[data-role="assistant"] [data-error-action]', (bs) => bs.map((b) => b.dataset.errorAction));
      check(actions.join() === "retry,settings", "Send again, then Settings", actions.join());
      await park(page);
      await h.shot("not-signed-in");
    },
  },
  {
    name: "f11-empty",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "gemini-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-empty-reach]`, { timeout: 5000 });
      await page.waitForFunction((s) => /Gemini CLI answers here/.test(document.querySelector(`${s} [data-empty-reach]`)?.textContent ?? ""), { timeout: 3000 }, shown);
      const text = await page.$eval(`${shown} [data-empty-reach]`, (p) => p.textContent);
      check(/Gemini CLI answers here\. It can read and search the files in School/.test(text) && /can’t change any file/.test(text), "the empty conversation says Gemini CLI answers, read-only", text);
      const label = await page.$eval(picker, (b) => b.textContent.trim());
      check(label === "Gemini CLI default", "the model button says Gemini CLI picks its own", label);
      await park(page);
      await h.shot("empty");
    },
  },
];
