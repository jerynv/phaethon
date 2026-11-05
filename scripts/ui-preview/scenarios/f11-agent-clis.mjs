// Agent CLIs (Team Agent CLIs): Codex and Gemini CLI next to Claude Code. Behaviour checks: check(...) fails the run.
//   f11-settings   Provider rows show known installation/authentication status; keyboard popup controls explicitly choose Codex.
//   f11-missing    choosing Gemini CLI when it isn't installed says so with how to install it, and doesn't switch
//   f11-model      with Codex answering, a space's model button offers Codex's own default, then the models Codex itself lists
//                  (asked of Codex once, names and what each is for), Refresh the list (asks again, menu stays open, said) and
//                  Another model…, where a typed name is saved as codex:<name> (a name that could be a flag is refused at the
//                  field) and the default comes back; a listed model chosen by keyboard is saved and named as Codex names it
//   f11-model-lists Gemini CLI's menu lists the choices its own menu offers with a note that it can't list its models
//   f11-model-unlisted a Codex that can't list says so in words and Another model… still works; Settings opening asks again
//   f11-errors     a chat error names the CLI that answers and says to sign in to it in Settings, never in a terminal
//   f11-sign-in    with Codex answering, Settings signs in to it for this Phaethon folder by keyboard: the button keeps focus
//                  and says it waits for the browser, Stop signing in stops it (said), signing in again says it worked and
//                  Codex's choice now says signed in; with Gemini CLI, Google refusing the account is said in words; Claude
//                  Code and Phaethon's own assistant have no sign-in here
//   f11-empty      the empty conversation says Gemini CLI answers here, read-only
import { SETTINGS, check, openSettings, park } from "../audit-fixtures.mjs";
import { closeProviderPopup, openProviderConfiguration, useProviderDefault } from "../provider-flow.mjs";

const calls = (page, cmd) => page.evaluate((cmd) => window.__calls.filter(([c]) => c === cmd).map(([, a]) => a), cmd);
const shown = "[data-space-pane][data-shown]";
const cliEditor = (id) => `[data-provider-detail] [data-agent-instance-popup]:has([data-provider-configuration="${id}"])`;
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
    { id: "claude", name: "Claude Code", installed: true, loggedIn: null, loginCommand: "claude", supported: true, ownHome: false },
    { id: "codex", name: "Codex", installed: true, loggedIn: true, loginCommand: 'CODEX_HOME="/x/default-codex" codex login', supported: true, ownHome: true },
    { id: "gemini", name: "Gemini CLI", installed: true, loggedIn: null, loginCommand: 'GEMINI_CLI_HOME="/x/default-gemini" gemini', supported: true, ownHome: true },
    { id: "opencode", name: "OpenCode", installed: false, loggedIn: null, loginCommand: "opencode auth login", supported: false, ownHome: false },
  ].map((c) => ({ ...c, ...(over[c.id] ?? {}) }));

export default [
  {
    name: "f11-settings",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ codex: { loggedIn: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await page.waitForSelector('[data-cli-status]');
      const choices = await page.$$eval('[data-provider-row]', (rows) => rows.map((row) => ({ id: row.dataset.providerRow, status: row.querySelector("[data-cli-status]")?.textContent })));
      check(["anthropic", "claude-cli", "codex-cli", "gemini-cli"].every((id) => choices.some((choice) => choice.id === id)), "API providers and installed assistant instances each have a management row", JSON.stringify(choices));
      check(choices.find((choice) => choice.id === "codex-cli")?.status === "Sign in required", "known signed-out state is shown honestly");
      check(choices.find((choice) => choice.id === "claude-cli")?.status === "Installed", "unknown authentication is not presented as signed in");
      await openProviderConfiguration(page, "codex-cli", { keyboard: true });
      check((await calls(page, "agent_instance_select")).length === 0, "opening existing-account management leaves the active account unchanged");
      await useProviderDefault(page, "codex-cli", { keyboard: true });
      check(await settingsSaid(page, "Now using Codex."), "the explicit default action is announced");
      check((await calls(page, "agent_instance_select")).at(-1)?.id === "codex", "the exact Codex instance is selected");
      check(!!(await page.$('[data-cli-sign-in="codex"]')), "the account has a direct sign-in action");
      const text = await page.$eval(cliEditor("codex-cli"), (element) => element.innerText);
      check(!/Models are chosen in each space|AGENTS\.md|terminal/.test(text), "management omits obvious tutorials");
      await h.shot("codex");

    },
  },
  {
    name: "f11-missing",
    sizes: [[1100, 720]],
    mock: { settings: SETTINGS, threads: {}, clis: CLIS({ gemini: { installed: false } }) },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "gemini-cli");
      const link = await page.$eval(`${cliEditor("gemini-cli")} [data-cli-missing="gemini-cli"]`, (element) => ({ text: element.textContent, href: element.href }));
      check(link.text.includes("Install Gemini CLI") && /github\.com\/google-gemini/.test(link.href), "a missing assistant links to its official installer", JSON.stringify(link));
      check(await page.$eval(`${cliEditor("gemini-cli")} [data-instance-select]`, (button) => button.disabled), "a missing executable cannot become the default");
      check((await calls(page, "agent_instance_select")).length === 0, "the installed provider stays selected");
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
      check(label[0] === "Model in School: Codex · Default" && label[1] === "Codex default", "the button says Codex picks its own model", JSON.stringify(label));
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [role="option"]', { timeout: 3000 });
      await h.idle();
      const items = await page.$$eval("[data-model-menu] [data-model-option]", (els) => els.map((e) => e.textContent.trim()));
      check(items[0] === "DefaultCodex" && !!(await page.$('[aria-label="Custom model"]')), "Codex's default stays first and custom models have an icon action", JSON.stringify(items));
      check(items[1] === "GPT-6.1-Sol" && items[2] === "GPT-6-Astra" && items[3] === "GPT-6-Luna", "models use consistent name-only rows", JSON.stringify(items));
      check(await page.$$eval('.ph-model-footer-actions [data-model-option]', buttons => buttons.map(button => button.getAttribute('data-model-option')).join(',') === '__refresh__,__other__'), "refresh and custom-model icons keep a consistent footer order");
      check((await calls(page, "agent_cli_models")).every((a) => a.cli === "codex") && (await calls(page, "agent_cli_models")).length === 1, "Codex is asked once", JSON.stringify(await calls(page, "agent_cli_models")));
      check(!(await page.$("[data-cli-models-note]")), "no note: Codex lists its own models");
      await park(page);
      await h.shot("menu");
      // Refresh the list: asked again, the menu stays open, said.
      await page.click('[data-model-option="__refresh__"]');
      await page.waitForFunction(() => window.__calls.filter(([command]) => command === "agent_instance_models").length >= 2);
      check((await calls(page, "agent_instance_models")).every(args => args.id === 'codex') && !!(await page.$("[data-model-menu]")), "the exact account catalog refreshes while the picker stays open", "");
      // A listed model, chosen: saved and named as Codex names it.
      await page.click('[data-model-option="gpt-6-astra"]');
      check(await shellSaid(page, "School now uses Codex · GPT-6-Astra."), "choosing a listed model says its name", await shellStatus(page));
      check((await calls(page, "space_model_set")).at(-1)?.model === "codex:gpt-6-astra", "saved as codex:gpt-6-astra", "");
      await page.waitForFunction((p) => document.querySelector(p)?.textContent.trim() === "GPT-6-Astra", { timeout: 3000 }, picker).catch(() => {});
      check((await page.$eval(picker, (b) => b.textContent.trim())) === "GPT-6-Astra", "the button shows it", "");
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      await h.idle();
      await page.click(picker);
      await page.waitForSelector('[data-model-option="__default__"]', { timeout: 3000 });
      await page.click('[data-model-option="__default__"]');
      check(await shellSaid(page, "School now uses Codex’s own default model."), "and back to the default", await shellStatus(page));
      // By keyboard alone: reopen in search, then Tab through catalog/access to Another model….
      await page.keyboard.press("Escape");
      await page.waitForFunction((p) => !document.querySelector("[data-model-menu]") && document.activeElement === document.querySelector(p), { timeout: 3000 }, picker);
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.matches('[data-model-search] input'), { timeout: 3000 });
      for (let i = 0; i < 8 && !(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Custom model")); i++) await page.keyboard.press("Tab");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Custom model", { timeout: 3000 });
      const at = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
      check(at === "Custom model", "Tab reaches the custom-model icon after catalog and permission controls", at);
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog]", { timeout: 3000 });
      const focused = await page.evaluate(() => document.activeElement?.hasAttribute("data-cli-model-input"));
      check(focused, "the name field has focus", String(focused));
      const desc = await page.$eval("[data-cli-model-dialog]", (d) => d.textContent);
      check(/Codex model in School/.test(desc) && !/For example/.test(desc) && await page.$eval("[data-cli-model-input]", input => !!input.placeholder), "custom model identifies its provider and uses the placeholder instead of tutorial paragraphs", desc);
      // A name that could be read as a flag is refused, at the field.
      // Typed once the menu has finished closing, as a person would.
      await page.waitForFunction(() => !document.querySelector("[data-model-menu]"), { timeout: 3000 });
      await page.keyboard.type("--yolo");
      await page.waitForFunction(() => document.querySelector("[data-cli-model-input]")?.value === "--yolo", { timeout: 3000 }).catch(() => {});
      const typed = await page.$eval("[data-cli-model-input]", (i) => [i.value, document.activeElement === i]);
      check(typed[0] === "--yolo", "the name is typed into the field", JSON.stringify(typed));
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-cli-model-dialog] [role=alert]", { timeout: 3000 });
      const err = await page.$eval("[data-cli-model-input]", (i) => [i.getAttribute("aria-invalid"), i.getAttribute("aria-describedby").split(" ").map(id => document.getElementById(id)?.textContent ?? "").join(" ")]);
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
    name: "f11-model-lists",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "gemini-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.click(picker);
      await page.waitForSelector('[data-model-menu] [data-model-option="flash-lite"]', { timeout: 3000 });
      await h.idle();
      const items = await page.$$eval("[data-model-menu] [data-model-option]", (els) => els.map((e) => e.textContent.trim()));
      check(JSON.stringify(items.slice(1, 5)) === JSON.stringify(["Auto", "Pro", "Flash", "Flash-Lite"]), "Gemini CLI's own menu's choices", JSON.stringify(items));
      check(!(await page.$("[data-cli-models-note]")), "successful model lists have no help-parser explanation");
      await park(page);
      await h.shot("gemini");
    },
  },
  {
    name: "f11-model-unlisted",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" },
      threads: {},
      cliLists: { codex: { models: [], note: "Codex couldn’t list its models just now. Type a model’s name with Another model…" } },
    },
    async run(page, h) {
      // A Codex that can't answer: said in words, and a name can still be typed.
      await page.waitForSelector(picker, { timeout: 5000 });
      await page.click(picker);
      await page.waitForSelector("[data-cli-models-note]", { timeout: 3000 });
      const said = await page.$eval("[data-cli-models-note]", (p) => p.textContent);
      check(/Codex couldn’t list its models just now/.test(said), "a list that couldn't be had is said in words", said);
      check(!!(await page.$('[data-model-option="__other__"]')), "Another model… is still there", "");
      await park(page);
      await h.shot("codex-unlisted");
      await page.keyboard.press("Escape");
      // Settings opening asks Codex again.
      const before = (await calls(page, "agent_cli_models")).length;
      await openSettings(page, h, "agent");
      await page.waitForFunction((n) => window.__calls.filter(([c]) => c === "agent_cli_models").length > n, { timeout: 3000 }, before).catch(() => {});
      check((await calls(page, "agent_cli_models")).length > before, "Settings asks the CLI for its list again", JSON.stringify(await calls(page, "agent_cli_models")));
    },
  },
  {
    name: "f11-errors",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "codex-cli" },
      threads: {},
      sendError: { code: "notLoggedIn", message: "Codex isn’t signed in for this Phaethon folder yet. Sign in to it in Settings › Assistant, then send your message again." },
    },
    async run(page, h) {
      await h.send("What is due this week?");
      await page.waitForSelector('[data-role="assistant"] [role="alert"]', { timeout: 5000 });
      const alert = await page.$eval('[data-role="assistant"] [role="alert"]', (a) => [a.querySelector("[data-error-title]").textContent, a.textContent]);
      check(alert[0] === "Codex isn’t signed in", "the title names Codex", alert[0]);
      check(/Sign in to Codex for this Phaethon folder in Settings › Assistant/.test(alert[1]) && !/terminal|Claude|`/.test(alert[1]), "the body says to sign in to Codex in Settings, never in a terminal", alert[1]);
      const detail = await page.$eval('[data-role="assistant"] [data-error-detail]', (d) => d.textContent);
      check(/isn’t signed in for this Phaethon folder/.test(detail), "the core's own words stay under Details", detail);
      const actions = await page.$$eval('[data-role="assistant"] [data-error-action]', (bs) => bs.map((b) => b.dataset.errorAction));
      check(actions.join() === "settings,retry", "Settings first, where signing in is, then Send again", actions.join());
      await park(page);
      await h.shot("not-signed-in");
    },
  },
  {
    name: "f11-sign-in",
    sizes: [[1100, 720], [640, 480]],
    mock: { settings: { ...SETTINGS, backend: "codex-cli" }, threads: {}, clis: CLIS({ codex: { loggedIn: false } }), signIn: { codex: { hold: true } } },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "codex-cli");
      const start = '[data-cli-sign-in="codex"] [data-cli-sign-in-start]';
      await page.focus(start);
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-cli-sign-in-stop]');
      check(await page.$eval(start, (button) => button.disabled && button.textContent.includes("Waiting")), "a pending browser sign-in cannot start twice");
      await page.keyboard.press("Enter");
      check((await calls(page, "agent_instance_sign_in")).length === 1 && (await calls(page, "agent_instance_sign_in"))[0].id === "codex", "the pending request names exactly this account");
      await page.keyboard.press("Escape");
      check(!!(await page.$(cliEditor("codex-cli"))), "Escape keeps a pending sign-in open");
      check(await page.$$eval(`${cliEditor("codex-cli")} [data-slot="dialog-footer"] button`, (buttons) => buttons.every((button) => button.disabled)), "management actions wait for authentication to finish");
      await page.focus('[data-cli-sign-in-stop]');
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-cli-sign-in-outcome="cancelled"]');
      check((await calls(page, "agent_instance_sign_in_cancel")).at(-1)?.id === "codex", "Cancel targets the pending account");
      await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), {}, start);
      check(await page.evaluate((selector) => document.activeElement === document.querySelector(selector), start), "Cancel returns focus to the sign-in action");
      await page.evaluate(() => { window.__MOCK__.signIn.codex = { status: "signedIn", message: "Signed in to Codex." }; });
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-cli-sign-in-outcome="signedIn"]');
      await page.waitForFunction(() => document.querySelector('[data-provider-row="codex-cli"] [data-cli-status]')?.textContent === "Signed in");
      check(await page.$eval(start, (button) => button.textContent === "Change account"), "a connected account offers Change account");
      await h.shot("signed-in");

    },
  },
  {
    name: "f11-sign-in-gemini",
    sizes: [[1100, 720]],
    mock: {
      settings: { ...SETTINGS, backend: "gemini-cli" },
      threads: {},
      clis: CLIS(),
      signIn: {
        gemini: {
          status: "notSignedIn",
          message: "Gemini CLI is signed in, but Google no longer lets it answer with this account: the free plan for individuals now points to Google’s Antigravity instead. A Gemini API key set up in Gemini CLI itself, or a Google Cloud or paid plan, still works. Or choose another assistant in Settings.",
        },
      },
    },
    async run(page, h) {
      await openSettings(page, h, "agent");
      await openProviderConfiguration(page, "gemini-cli");
      await h.click('[data-cli-sign-in="gemini"] [data-cli-sign-in-start]');
      await page.waitForSelector('[data-cli-sign-in-outcome="notSignedIn"]');
      const outcome = await page.$eval('[data-cli-sign-in-outcome="notSignedIn"]', (element) => element.textContent);
      check(outcome.includes("Google no longer lets it answer with this account"), "an actual rejected login is shown", outcome);
      await closeProviderPopup(page);
      await openProviderConfiguration(page, "claude-cli");
      check(!!(await page.$('[data-cli-sign-in="claude"] [data-cli-sign-in-start]')), "Claude Code also uses its actual browser sign-in flow");
      check(!(await page.$('[data-instance-args]')), "legacy personal Claude keeps its existing launch setup");
      check(!!(await page.$('[data-provider-logo="claude-cli"]')), "the management header retains the official assistant mark");
      await h.shot("refused");

    },
  },
  {
    name: "f11-empty",
    sizes: [[1100, 720]],
    mock: { settings: { ...SETTINGS, backend: "gemini-cli" }, threads: {} },
    async run(page, h) {
      await page.waitForSelector(`${shown} [data-empty-state]`, { timeout: 5000 });
      const text = await page.$eval(`${shown} [data-empty-state]`, (empty) => empty.textContent);
      check(text.includes("Start a conversation in School") && !text.includes("It can read and search"), "the empty workspace names the space without a permission essay", text);
      const label = await page.$eval(picker, (b) => b.textContent.trim());
      check(label === "Gemini CLI default", "the model button says Gemini CLI picks its own", label);
      await park(page);
      await h.shot("empty");
    },
  },
];
